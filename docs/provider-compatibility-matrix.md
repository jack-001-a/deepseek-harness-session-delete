# Persistence provider compatibility matrix

- Status: current implementation inventory and future integration requirements
- Reviewed against: plugin PR #12, Host-native lease ADR in PR #13, and the built-in Harness JSONL and SQLite provider implementations
- Scope: filesystem artifact lifecycle only; this is not a claim of end-to-end workspace transaction isolation

## Executive summary

The plugin's cross-process filesystem lock coordinates **cooperating instances of this plugin**. It does not acquire the Harness persistence provider's native session write lease and does not serialize native workspace-registry mutations from another Harness process.

The built-in JSONL and SQLite providers both implement provider-specific cross-process write ownership for their own write handles. Those are backend implementation details, not a generic `SessionPersistence` lifecycle API. Neither currently protects this plugin's delete, restore, or purge operations because the plugin does not acquire a provider-owned lifecycle lease.

**Operational constraint:** until a provider-owned artifact lease/tombstone API is available and integrated, do not run multiple Harness processes against the same session store while using destructive Session Delete actions. The plugin's lock is not a substitute for native writer coordination.

## Capability matrix

| Provider / mechanism | Cross-process writer exclusion | Can lease an absent artifact for restore? | What this plugin currently uses |
|---|---|---|---|
| Shipped Harness JSONL provider | Yes, for its own write handles: POSIX `flock(2)` on the `session.lock` inode; Windows named kernel semaphore derived from the session path | No, not through `open(id, 'write')`: the provider resolves an existing log before acquiring the lease, so an absent log returns not-found | **Nothing.** The plugin does not call `sessionPersistence.open(id, 'write')` to acquire this lease |
| Built-in Harness SQLite provider | Yes, for its own write handles: a database-scoped per-Session kernel lease plus the root artifact/creation lock; the shared lease uses POSIX `flock(2)` or a Windows named kernel semaphore | No public consumer API. Internal migration code can acquire a lease from a `SessionHeader`, but that helper is not exposed by `SessionPersistence` and is not a delete/retire contract | **Nothing.** The plugin does not acquire the SQLite provider's internal ownership locks; SQLite snapshots also omit a per-Session filesystem `location` because history is stored in the shared database |
| Generic `SessionPersistence` contract | Do not assume cross-process exclusion. The abstract contract's single-writer guarantee is backend-instance scoped unless a provider documents more | Not specified by the generic contract | No provider capability is inferred from `locate()` or a package version |
| Other / third-party persistence providers | Unknown until the provider documents and tests its own mechanism | Unknown | The plugin currently uses its own filesystem operation lock and store locator/path validation only |
| Session Delete plugin operation lock | Serializes cooperating plugin instances using the same canonicalized local session-store path; stale-lock reclamation is conservative and fail-closed | Not applicable; this is not a Host persistence lease | Used by delete, restore, purge, retention cleanup, startup reconciliation, and interrupted trash-move recovery |

### Built-in SQLite provider details

- SQLite stores Session metadata and event frames in the shared `<root>/.segments/sessions.sqlite` database; it does not expose one movable per-Session log directory. Its `stat()` snapshots omit `location`, so a consumer cannot derive a safe per-Session filesystem artifact from the generic snapshot.
- A SQLite write handle acquires two internal ownership locks: a database-scoped per-Session lock under the database's `.session-locks` sibling directory, and a root artifact/creation lock. The lock implementation uses POSIX `flock(2)` or a Windows named kernel semaphore. Legacy JSONL import also coordinates against the legacy artifact lock.
- The internal `SqliteStore.acquireSessionLease(header)` helper is used by migration. It is not part of the public `SessionPersistence` service surface, is not exposed as a provider capability to plugins, and does not define atomic delete, restore, quarantine, or retirement semantics.
- The SQLite provider documentation requires all processes writing imported Sessions to use SQLite. Do not mix JSONL and SQLite writers for one imported Session.
- Consequently, the current Session Delete filesystem trash implementation has no verified destructive support for SQLite-backed histories. Do not treat the database file as a per-Session artifact or move/delete it to remove one Session.

### Platform-specific JSONL details

- **POSIX:** the provider lease protects an open lock-file inode, not an abstract pathname. Renaming the containing directory can leave the old process holding the old inode while a new directory at the original pathname acquires a new `session.lock` inode. Unlinking/replacing the lock file while held can therefore split exclusion.
- **Windows:** the shipped provider uses a named kernel semaphore derived from the session path. Do not project POSIX inode assumptions onto this implementation; it needs its own provider-level integration tests.
- The JSONL lease is released by `SessionHandle.close()` after routed writes and the mutation chain have drained. A newly created, unmaterialized session does not acquire the lease until its first materializing write.

## Current operation coverage

| Operation | Plugin lock held? | Host-native artifact lease held? | Current limitation |
|---|---:|---:|---|
| Delete to trash | Yes | No | The current implementation moves the located artifact; for the shipped JSONL layout this includes the session directory and its lock file. A concurrent native writer in another Harness process is outside the plugin lock |
| Restore | Yes | No | Restores the artifact to its original location. A native writer can race independently; `open(id, 'write')` cannot lease a temporarily absent log |
| Explicit purge | Yes | No | Removes the trash entry. It does not coordinate with a native writer that may have independently recreated/materialized the original session |
| Retention cleanup | Yes | No | Uses the same plugin operation lock as explicit purge, but does not gain Host-native exclusion |
| Startup reconciliation | Yes, per session | No | Recovery decisions are serialized against plugin operations only; ambiguous source/target states are preserved |
| Interrupted trash-move recovery | Yes, per session | No | Filesystem recovery is plugin-coordinated; it is not a cross-Harness writer protocol |
| Workspace membership / pin / archive writes | Plugin operation lock around this plugin's work | No | A different Harness process can still mutate its own workspace registry; the plugin lock is not shared with that registry |

**Important distinction:** the current implementation's path containment checks, known-artifact-kind checks, transaction markers, retries, and plugin lock remain useful safeguards. They do not establish mutual exclusion with a native Harness writer. The current implementation does **not** dynamically detect a missing artifact-lease capability and fail closed on that basis.

## Required behavior for a future Host integration

Do not implement this by reproducing JSONL's private `session.lock`, `flock`, or Windows semaphore details in the plugin.

A future provider-owned artifact lease/tombstone capability must:

1. Coordinate atomically with existing write handles and new `open('write')` / create attempts.
2. Acquire by stable Session identity even while the log artifact is temporarily absent during restore.
3. Preserve one exclusion identity across delete, quarantine, cross-volume staging/promotion, restore, and retire/purge.
4. Wait for existing writers to close and drain their final event batch before granting destructive ownership.
5. Define crash recovery and process-death semantics.
6. Expose provider-owned capabilities rather than asking plugins to manipulate private lock paths.
7. Distinguish unsupported provider, contention, and I/O failure.

Once such a capability exists, destructive operations that require it must **fail closed** when the provider does not advertise/support it. A generic `locate()` result, `open('write')` on a live log, or the plugin's own filesystem lock is not an acceptable fallback.

See [the Host-native write-lease ADR](./host-native-write-lease-adr.md) for the proposed JSONL transaction protocol and API semantics.

## Validation status and missing evidence

| Evidence | Status |
|---|---|
| Plugin lock serialization across independent Node processes | Covered by plugin tests |
| Plugin lock path convergence through symlink aliases | Covered by plugin tests |
| Plugin lock reclamation after owner process exits | Covered by plugin tests |
| Shipped JSONL provider's POSIX/Windows write lease contract | Inspected/documented; not integrated by this plugin |
| Built-in SQLite provider's database-scoped and artifact write-ownership locks | Inspected/documented; not integrated by this plugin |
| SQLite per-Session filesystem artifact location | Not exposed by `stat()`; history resides in the shared database |
| Public provider-owned lifecycle lease / tombstone / retirement API (JSONL or SQLite) | **No public capability verified** |
| Two real Harness processes contending on the provider lease while delete/restore/purge runs | **Not tested** |
| Provider-owned lease for temporarily absent artifacts | **No public capability verified** |
| Third-party provider compatibility | **Unknown; provider-specific evidence required** |
| Cross-process workspace registry serialization | **Not provided by this plugin lock** |

Mock Cordis contexts and independent Node processes validate the plugin lock implementation. They do not simulate the shipped provider's kernel lease or establish behavior across two live Harness processes. Do not report them as Host integration coverage.

## Release / support policy

- Keep the current guarantee narrowly worded: cooperating plugin instances on the same host and local filesystem.
- Do not claim protection against native Harness writers or cross-process workspace mutations.
- Do not infer provider guarantees from the generic persistence interface.
- Do not add JSONL- or SQLite-specific destructive storage handling until the Host exposes a stable artifact lifecycle capability and the real multi-process acceptance tests pass.
- Until then, users should avoid concurrent Harness processes sharing the same session store when performing delete, restore, or purge.
