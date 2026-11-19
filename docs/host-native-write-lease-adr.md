# ADR: Host-native session write-lease integration

- Status: proposed
- Scope: shipped DeepSeek Harness JSONL persistence provider
- Depends on: the plugin-level cross-process operation lock in PR #12
- Non-goal: claiming generic cross-process exclusion for every `SessionPersistence` backend

## Context

The plugin's filesystem operation lock serializes cooperating instances of this plugin. It does not exclude a native Harness writer. The persistence seam exposes `ctx.sessionPersistence.open(id, 'write')`; a successful write handle owns the provider's single-writer lease until `close()` has drained pending writes and released ownership.

The shipped JSONL provider implements that lease with a POSIX `flock(2)` on `session.lock` inside the session directory, or a Windows named kernel semaphore derived from that path. On POSIX, the lease protects an inode, not a pathname. The provider deliberately verifies that the locked inode is still the inode currently named by `session.lock`, and deliberately never unlinks that file.

## Verified provider lifecycle

1. `open(id, 'write')` resolves the current log first.
2. It claims the backend's process-local writer slot.
3. It acquires the kernel lease in the resolved log's containing session directory.
4. It reads/prepares the stored log and returns a write handle.
5. `SessionHandle.close()` drains routed writes and the mutation chain, releases the kernel lease, then releases the process-local writer claim.
6. A newly created, unmaterialized session does not acquire a lease until its first materializing write.

The last point means a lease cannot protect an unmaterialized session. It also means this ADR's destructive protocol applies only after an existing materialized artifact has been resolved and opened.

## Critical pathname/inode race

Do **not** implement deletion as:

1. open the session for write;
2. rename the entire session directory into trash;
3. close the handle.

On POSIX, the open descriptor continues to lock the original `session.lock` inode after the directory rename. The original pathname is now absent. A concurrent create/materialization at that original pathname can create a new directory and a new `session.lock` inode, then acquire a different lock. The old lease does not exclude it. The same general warning applies to any algorithm that unlinks or replaces the lock file while a lease is held.

## Proposed JSONL-specific protocol

Treat the session directory and its `session.lock` as stable provider-owned coordination state. Move or remove the log generations, not the containing directory and not `session.lock`.

### Delete to trash

1. Acquire the plugin's per-session operation lock.
2. Resolve and validate the JSONL artifact location; reject unknown artifact kinds and unsupported providers.
3. Open `sessionPersistence.open(id, 'write')`. If it reports active ownership, abort without moving anything. Keep the returned handle open for the entire filesystem mutation.
4. Re-resolve the current log location while holding the provider lease. Confirm it is still the expected session directory and that the directory's `session.lock` remains present. Do not use a stale path captured before acquiring the lease.
5. Write the trash manifest and transaction marker before moving log data.
6. Move/copy the selected log-generation files into the trash artifact while leaving the original session directory and `session.lock` in place. For cross-volume moves, copy to private staging, verify the complete copied generations, atomically promote staging on the trash volume, then remove only the source log-generation files. Never recursively remove the source session directory.
7. Verify no selected log generation remains at the live path. Keep the write handle open until this verification and the durable transaction state are complete.
8. Close the write handle, then replay workspace accounting and projection-cache cleanup using the existing retry/recovery protocol.
9. The now-empty session directory and stable `session.lock` remain as provider coordination state. This is intentional; deleting that lock file would invalidate the provider's exclusion guarantee.

### Restore

1. Acquire the plugin operation lock and validate the manifest, marker, target path, and trash artifact.
2. Recreate the original session directory if absent, but never replace or unlink an existing `session.lock`.
3. Open the session for write only when a live log already exists. For an empty target directory, the provider's write-open correctly reports not-found; the restore implementation must instead use a provider-supported lease acquisition capability or a new Host API. Do not invent a lock by writing `session.lock` directly: the POSIX and Windows implementations differ.
4. Under a valid lease, restore the log-generation files into the existing directory using staging and atomic promotion. Preserve the lock file and fail closed if another writer has materialized a log or acquired ownership.
5. Persist restore completion before releasing the lease. If lease acquisition loses a race, preserve both the trash artifact and any target state; leave accounting pending.

**Important unresolved seam:** after delete has removed all log generations, `open(id, 'write')` cannot acquire a lease because the provider's `open` first resolves an existing log and returns not-found. A correct restore/delete lifecycle therefore needs a provider-owned API that can acquire a lease by `SessionId` plus validated `SessionHeader`/location even when the log is temporarily absent, or a Host-level atomic tombstone/quarantine primitive. Directly reproducing provider lock internals in this plugin is rejected.

### Permanent purge and retention cleanup

- Never recursively remove the session directory while its write lease is held.
- Purging trash-side log data does not require deleting the live session's stable lock sentinel; the trash artifact must not contain a second copied `session.lock`.
- If policy requires deleting the empty live directory and its lock file, that is **not safe** with the current public persistence seam. It requires a provider-owned tombstone/retire API that prevents new opens/creates while the provider removes its lock state.
- Retention cleanup must use the same protocol and must not bypass the lease because it runs in the background.

## Required Host API capability

Before implementation, upstream should expose a provider-owned operation with semantics equivalent to:

```ts
interface SessionArtifactLease {
  readonly id: SessionId
  readonly location: SessionLocation
  // Prevents new opens/creates for this id while held.
  // Existing writers must have closed before acquisition resolves.
  release(): Promise<void>
}

sessionPersistence.acquireArtifactLease(id, options?): Promise<SessionArtifactLease>
```

This is a semantic sketch, not a proposed exact public signature. Required properties:

- atomically coordinates with existing write handles and new `open('write')` / `create` attempts;
- can acquire for a materialized session and for a temporarily absent artifact during restore;
- exposes a validated provider-owned location/capability, not an arbitrary filesystem path;
- keeps a stable per-session exclusion identity across log rename, copy, quarantine, and restore;
- has explicit crash semantics and releases kernel ownership on process death;
- does not require consumers to know POSIX inode or Windows semaphore details;
- distinguishes unsupported providers from contention and I/O failure.

A backend-local `open('write')` is still useful for flushing and validating a live session, but it is not a substitute for this lifecycle capability.

## Compatibility and fail-closed behavior

- Feature-detect the proposed Host capability; do not infer it from a package version string alone.
- If absent, keep the current plugin behavior only where its existing guarantees are sufficient. Do not claim native-writer exclusion.
- For destructive JSONL operations that require the missing capability, refuse the operation with a clear unsupported-capability error rather than falling back to plugin-only locking.
- Other artifact kinds/backends require their own provider-specific contract. A generic `locate()` result does not imply a lock protocol.

## Acceptance tests before implementation

Run against the real shipped JSONL provider and two independent Harness processes, not only mocked contexts:

1. A live native writer makes artifact-lease acquisition contend; no log file or manifest is moved.
2. Closing/disposal drains the final event batch before lease acquisition succeeds.
3. Delete holds exclusion while another process attempts `open('write')` and `create(id)`.
4. Delete to trash leaves the original stable `session.lock` inode/path intact and no live log generations.
5. A process crash after staging, after promotion, and before source cleanup is recoverable without deleting a changed source.
6. Restore races a competing writer; either restore owns the artifact lease and completes, or it preserves the trash copy and leaves restore accounting pending.
7. Crash recovery resumes each delete/restore phase without treating an absent log as proof that the transaction committed.
8. Permanent purge and retention never unlink a held lock file or recursively remove its containing directory.
9. Windows named-semaphore behavior is covered separately; tests must not assume POSIX lock-file semantics there.
10. Unsupported providers fail closed and never receive JSONL-specific filesystem mutations.

## Decision

Do not implement Host-native lease integration inside PR #12. Keep PR #12 as the plugin-instance coordination layer. Implement the destructive integration only after the Host exposes and tests the stable artifact-lease/tombstone capability above. Until then, the plugin must not claim protection against native Harness writers.
