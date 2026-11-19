# ADR: Provider-owned Session lifecycle transactions

- Status: proposed
- Scope: Host persistence lifecycle contract shared by built-in providers
- Depends on: plugin-level cross-process operation lock in PR #12
- Replaces: the earlier JSONL-directory-move protocol
- Non-goal: exposing provider-private paths, lock files, database tables, or kernel primitives to plugins

## Context and verified constraints

The plugin's filesystem operation lock serializes cooperating plugin instances. It does not exclude native Harness writers or coordinate provider storage mutations from another process.

The built-in providers have different storage models:

- **JSONL** stores each Session in a directory. Cross-process write ownership uses a stable `session.lock` coordination object: POSIX `flock(2)` on its inode and a Windows named kernel semaphore. A live handle retains ownership until close drains writes and releases the lease. Moving or unlinking the lock-file identity can split exclusion on POSIX.
- **SQLite** stores Session metadata and event frames in a shared database. Its writer path acquires a database-scoped per-Session lock plus a root artifact/creation lock. Public persistence snapshots do not expose a per-Session filesystem `location`. Internal migration helpers are not a public lifecycle API.

Both providers have provider-specific writer ownership, but neither currently exposes a public provider-owned delete/restore/retire contract. A plugin cannot safely translate a generic `SessionPersistence` snapshot into a filesystem mutation.

## Decision

The Host should expose a **provider-owned Session lifecycle transaction**. The public contract describes lifecycle semantics, not storage paths or lock mechanics. The provider remains the sole authority for admitting writers, preserving Session identity, quarantining data, restoring it, permanently purging it, and recovering interrupted operations.

The plugin may own user-facing trash metadata, retention policy, and workspace projection/accounting. It must not move, rename, unlink, or edit provider-private Session storage.

## Proposed semantic API

This is a design sketch, not an approved exact TypeScript signature:

```ts
type SessionLifecycleState = 'live' | 'retiring' | 'retired' | 'restoring' | 'purging' | 'purged'

interface SessionRetirement {
  readonly id: SessionId
  readonly token: string // opaque, stable, provider-issued
  readonly state: 'retired' | 'restored' | 'purged'
  readonly revision: string
}

interface SessionLifecycle {
  retire(id: SessionId, options: {
    operationId: string // caller-generated idempotency key, stable across retries
    expectedRevision?: SessionRevision
    signal?: AbortSignal
  }): Promise<SessionRetirement>

  restore(token: string, options?: { signal?: AbortSignal }): Promise<SessionSnapshot>
  purge(token: string, options?: { signal?: AbortSignal }): Promise<void>
  inspect(token: string): Promise<SessionRetirement | undefined>
  inspectById(id: SessionId): Promise<SessionRetirement | undefined>
  recover(signal?: AbortSignal): Promise<void>
}
```

The exact surface may instead use an explicit transaction object with prepare/commit/abort. The non-negotiable semantics are:

1. **Stable identity:** coordination is keyed by stable `SessionId`, not by current file existence or pathname.
2. **Writer fencing:** lifecycle mutation atomically excludes new write opens and creates for that ID, and waits for admitted writers to drain their final event batch before destructive ownership is granted.
3. **Absent-artifact restore:** a retirement token remains valid while the live artifact is absent. Restore does not need a fake live artifact or a lease on a missing file.
4. **Provider-owned mutation:** the provider performs quarantine, restore, and purge using its own storage model. Consumers receive an opaque token/state, never a private storage path.
5. **Idempotency and lost responses:** `retire` requires a caller-generated `operationId` that is stable across retries. If the provider commits retirement but the process dies before receiving the response, retrying the same `operationId` returns the same retirement token. `inspectById(id)` lets plugin recovery discover a committed retirement when its metadata write was interrupted. Repeated restore/purge calls with the same token return the committed terminal state or a typed terminal-state error; they cannot create duplicate retirement or destroy unrelated data.
6. **Crash consistency:** durable phase changes and data movement are recoverable after process death. A missing live artifact alone never proves retirement committed.
7. **Revision protection:** retire may compare an expected revision so stale plugin/UI state cannot retire a newer Session generation.
8. **Typed outcomes:** unsupported capability, writer contention/cancellation, revision conflict, not-found, already-retired/restored/purged, and storage I/O/corruption are distinguishable.
9. **Process-death release:** kernel ownership is released on process death, while durable transaction state remains recoverable by a later provider instance.
10. **Capability discovery:** support is advertised by the active provider instance through a typed optional capability or registry. Package-version checks and `locate()` are insufficient.

The Host may wait for an active writer or return a typed busy result. Either policy is acceptable if atomic, documented, cancellable, and tested. It must never proceed while a writer can still commit.

## Provider adapter requirements

### JSONL

- Keep the provider's coordination identity stable for the full lifecycle. Never move, unlink, replace, or copy `session.lock` as part of a plugin operation.
- The provider may quarantine data generations while preserving its coordination object, or use a provider-owned tombstone namespace. This remains an implementation detail.
- New `open('write')` and `create(id)` attempts must observe retirement state and be rejected or serialized behind the lifecycle transaction.
- Restore reacquires the same stable Session identity even when no live log generation exists.
- Cross-volume staging, promotion, source cleanup, and crash recovery are provider responsibilities.

### SQLite

- Retire and restore through transactions over provider-owned metadata, event frames, and tombstone records. Never move or delete the shared database to remove one Session.
- The current SQLite schema stores fork history as predecessor-linked Segments. Multiple child Segments may share an ancestor; a trace references only its tail, and reads traverse the parent chain/ancestor index. Purge must use reachability-aware garbage collection, not recursive deletion of every ancestor of the target trace.
- A Segment is reclaimable only when no remaining trace points to it as a tail and no remaining Segment points to it as a parent. Reclaim its frames and ancestor-index references before deleting the Segment, then walk toward its parent until a still-referenced node is reached. Preserve all history needed by any live or restorable retired Session.
- The current schema's `frames_no_delete` and `ancestors_no_delete` triggers prohibit reclamation; schema version 1 is not silently migrated. Any lifecycle implementation must ship a versioned, data-preserving migration that narrows deletion to provider-owned GC while retaining immutable update/reparent guards.
- Routing markers and legacy JSONL fallback are part of Session identity. A marker without a trace row currently causes listing to report missing storage, and `open()` may fall back to legacy JSONL when no SQLite row is selected. Tombstones must prevent both false missing-storage errors and resurrection from legacy JSONL.
- Existing writer leases cover DB-scoped per-Session write ownership plus root artifact/creation coordination, but not the lifetime of read handles or an unmaterialized pending create. Lifecycle fencing must define linearization for pending creates, opens, and in-flight reads; later reads must not see retired state.
- A retirement record preserves enough provider-owned metadata to restore the Session without exposing Segment IDs, database paths, or lock directories.
- Distinguish logical purge from forensic erasure. Deleting trace/Segment rows does not prove that old bytes are gone from SQLite pages, WAL files, snapshots, or backups. Do not claim secure physical erasure without a separate tested sanitization or cryptographic-erasure mechanism that does not damage unrelated Sessions.
- Legacy JSONL import and lifecycle operations need a documented lock order; inconsistent acquisition order must not deadlock or publish stale imported history after retirement.

### Third-party providers

A provider may advertise no lifecycle capability. In that case the plugin must not perform destructive storage operations against it. No generic raw-filesystem fallback is permitted.

## Plugin integration boundary

1. Discover the capability from the active `ctx.sessionPersistence` instance.
2. If unsupported, disable or reject destructive actions with a clear unsupported-capability error. Preserve non-destructive listing/description where permitted.
3. Invoke provider lifecycle operations using stable Session IDs and opaque retirement tokens.
4. Persist plugin-owned trash metadata and workspace projection/accounting through an idempotent outbox/reconciliation protocol.
5. Treat provider lifecycle state as authoritative for whether data is live, retired, or purged. Plugin metadata is a replayable projection.
6. Run provider recovery before reconciling plugin trash metadata. Never infer provider state from path existence.
7. Keep the plugin lock for plugin metadata/accounting serialization only; it is not native writer fencing.

Provider mutation and plugin metadata publication are not one distributed transaction. The plugin must persist its `operationId` before calling `retire`. If it crashes after provider commit but before storing the returned token, startup uses `inspectById(id)` (or retries the same `operationId`) to recover the provider-issued token, then completes the plugin projection. The outbox must retain the operation ID until reconciliation is durable.

## Failure and recovery model

A representative durable state machine is:

```text
live -> retiring -> retired -> restoring -> live
                         \-> purging -> purged
```

- Intermediate states are recoverable, not user-visible success.
- A crash before durable retirement must roll back or resume without losing the live Session.
- A crash after provider retirement but before plugin metadata publication must allow discovery by token/ID and completion of the projection.
- A crash during restore preserves the retirement token and either resumes restore or leaves retired data intact.
- A crash during purge must never resurrect partially deleted data as live. Purge is durable and idempotent.
- Unknown or contradictory state fails closed and preserves data for operator recovery; it never triggers best-effort recursive deletion.

## Compatibility and rollout

- Add the lifecycle capability as an optional, explicitly discoverable provider capability first.
- Keep existing `SessionPersistence` methods source-compatible; `open(id, 'write')` is not itself a lifecycle lease.
- Ship provider implementations and conformance tests before enabling destructive plugin integration.
- Feature-detect at runtime. Unsupported providers fail closed for destructive operations.
- Do not enable a provider until its platform-specific multi-process tests pass.
- Existing plugin-only filesystem behavior retains its narrowly documented guarantee until provider integration exists. Old trash entries must not be silently reinterpreted as provider retirement tokens.

## Acceptance tests before implementation

Run conformance tests against two independent real Harness processes for each built-in provider and supported OS family:

1. A live writer blocks retirement or produces a typed busy result; no data or plugin metadata is lost.
2. Retirement succeeds only after writer close/process teardown drains its final admitted event batch.
3. While retirement is held, another process cannot open a writer or create/materialize the same Session ID.
4. A create racing retirement is serialized deterministically; exactly one wins and no duplicate live generation appears.
5. Successful retirement removes the Session from normal list/read/open paths while preserving an opaque restore token.
6. Restore works with no live artifact and preserves metadata, event order, revision semantics, and required workspace references.
7. A competing writer racing restore is excluded or receives a typed conflict; retired data remains recoverable if restore loses.
8. Process termination at every durable phase boundary recovers without data loss or split lock identity.
9. Purge affects only the retired Session and is idempotent after process death at every phase.
10. SQLite retirement/purge never moves, truncates, or removes the shared database; unrelated Sessions remain readable and writable.
11. JSONL tests prove the stable coordination object is not replaced or unlinked while ownership is held; Windows named-object behavior is tested independently.
12. Legacy JSONL import racing SQLite retirement follows a documented lock order and cannot publish stale imported history after retirement.
13. Unsupported third-party providers fail closed; no plugin-side private-layout fallback is attempted.
14. Plugin outbox recovery completes metadata/accounting after a crash between provider commit and plugin projection publication.

Mock Cordis contexts and plugin-local process-lock tests are useful but do not satisfy these provider conformance requirements.

## Consequences

- This is a cross-provider Host API proposal, not a claim that either built-in provider currently implements it.
- JSONL and SQLite preserve storage-specific optimizations without leaking lock/storage models into plugins.
- The plugin owns user-facing trash policy and metadata projection; the provider owns Session data lifecycle correctness.
- Provider implementation and migration complexity increase, but consumers gain one enforceable contract.

## Decision

Do not implement provider-native destructive integration in the plugin until the Host exposes this capability and both built-in providers pass the real multi-process conformance suite. Keep PR #12 as plugin-instance coordination only. Until then, do not claim protection against native Harness writers or cross-process provider mutations.
