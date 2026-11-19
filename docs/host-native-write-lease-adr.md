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


## Public API placement recommendation (upstream review)

The reviewed upstream contract is defined in `packages/session/session-persistence/src/index.ts`. That package explicitly describes itself as the backend-independent service seam; JSONL and SQLite subclass `SessionPersistence`, while each provider owns its storage runtime. The package root exports the abstract service and its public types, and its `package.json` exposes that root as the supported package entry point. Cordis declaration merging exposes the active instance as `ctx.sessionPersistence`.

**Recommended placement: keep lifecycle as an optional capability of that same active `SessionPersistence` instance, with its public capability types exported by `@deepseek-ai/dsh-session-persistence`.** Do not introduce a second independently registered Cordis service for lifecycle operations: a separately resolved service could outlive or become mismatched with a replaced persistence provider. Do not add mandatory abstract methods to `SessionPersistence`, because that would break third-party subclasses.

A source-compatible discovery shape is a concrete default method on the existing abstract service:

```ts
export abstract class SessionPersistence extends Service {
  // Existing abstract persistence methods remain unchanged.

  /** Provider-owned lifecycle operations, or undefined when unsupported. */
  getLifecycleCapability(): SessionLifecycleCapability | undefined {
    return undefined
  }
}
```

The exported `SessionLifecycleCapability` interface describes the provider-owned operations and their typed results. A built-in provider overrides the method and returns a stable capability object bound to that provider instance. Existing third-party providers inherit the default `undefined` result and remain valid; consumers must fail closed when it is absent. This is preferable to package-version checks, provider-name checks, `instanceof` checks against concrete provider packages, or filesystem/database probing.

Discovery must always start from the currently active `ctx.sessionPersistence` instance. A consumer that caches the capability must also retain and revalidate that service instance's existing `identity` before use; after provider replacement it must reacquire the capability. The capability is not a free-standing handle to a storage root.

Keep the interface and shared semantic types in the persistence seam package, but keep all implementation details in provider packages. The shared package must not import JSONL/SQLite code, expose lock primitives, Segment IDs, database paths, or filesystem layouts. The JSONL and SQLite packages implement the same capability independently. The SQLite package's existing dependency on the JSONL package for legacy import does not change lifecycle ownership: the outer SQLite persistence instance remains authoritative for an ID selected into SQLite and must fence the legacy importer too.

This recommendation is a contract placement proposal for upstream maintainers, not an implementation or a claim that the reviewed upstream commit already contains the method.

## Concrete capability contract (refinement)

The following is the recommended public shape for upstream review. Names may change during review, but the compatibility and retry semantics below are normative.

```ts
export interface SessionLifecycleRetireOptions {
  /** Caller-persisted idempotency key; reuse unchanged after timeout or process death. */
  readonly operationId: string
  /** Compared against a snapshot from this same active persistence instance and Session ID. */
  readonly expectedRevision?: SessionPersistenceRevision
  readonly signal?: AbortSignal
}

export interface SessionLifecycleOptions {
  readonly signal?: AbortSignal
}

export type SessionLifecycleTerminalState = 'retired' | 'restored' | 'purged'

export interface SessionLifecycleRecord {
  readonly id: SessionId
  /** Opaque provider-issued token; never a path, database key, or Segment identifier. */
  readonly token: string
  readonly state: SessionLifecycleTerminalState
}

export interface SessionLifecycleRestoreResult {
  /** The same durable retirement identity, now in state 'restored'. */
  readonly retirement: SessionLifecycleRecord
  /** Current live snapshot after restoration. */
  readonly snapshot: SessionPersistenceSnapshot
}

export interface SessionLifecycleCapability {
  retire(id: SessionId, options: SessionLifecycleRetireOptions): Promise<SessionLifecycleRecord>
  restore(token: string, options?: SessionLifecycleOptions): Promise<SessionLifecycleRestoreResult>
  purge(token: string, options?: SessionLifecycleOptions): Promise<SessionLifecycleRecord>
  inspect(token: string, options?: SessionLifecycleOptions): Promise<SessionLifecycleRecord | undefined>
  /** Exact recovery lookup for a previously submitted retire operation. */
  inspectOperation(id: SessionId, operationId: string, options?: SessionLifecycleOptions): Promise<SessionLifecycleRecord | undefined>
  /** Current lifecycle record for diagnostics; not a substitute for operation-ID lookup. */
  inspectById(id: SessionId, options?: SessionLifecycleOptions): Promise<SessionLifecycleRecord | undefined>
}
```

Contract details that the signature alone cannot express:

- A repeated `retire(id, { operationId })` returns the same token and committed result, even if the original response was lost. Reusing an operation ID for a different Session is a typed conflict. Once an operation ID has committed, retry resolution takes precedence over re-checking its original expected revision.
- A stale `expectedRevision` rejects before retirement begins. Revisions are only comparable within the same active persistence instance and Session ID, matching the existing `SessionPersistenceRevision` contract; they are not durable cross-restart versions.
- Repeated `restore(token)` returns the same restored outcome and current snapshot. Repeated `purge(token)` returns the same purged outcome. Restore-after-purge and purge-after-restore return typed terminal-state conflicts; neither may recreate or delete data.
- `inspectById(id)` must return enough durable state to reconcile a caller that committed `operationId` but died before persisting the returned token. Its retention/compaction rules must not discard an outcome while a corresponding caller operation could still be in its recovery window.
- Provider crash recovery is an initialization responsibility: the provider must reconcile incomplete durable phases before exposing the persistence service as ready. It is not a plugin-callable `recover()` method, because callers cannot safely decide when another process's recovery is complete.
- The capability object is bound to exactly one persistence instance. Consumers obtain it from that instance and must reacquire it after service replacement; no global singleton or separately registered Cordis service is permitted.

Use typed errors for unsupported capability (discovery returns `undefined`, so this is normally a consumer-side refusal), revision conflict, operation-ID conflict, writer busy/cancelled, not-found, and illegal terminal transition. The provider must document which outcomes are retryable and whether cancellation occurred before or after the linearization point.



### Exact recovery identity

`inspectById(id)` is useful for observing the Session's current lifecycle state, but it is not a sufficient lost-response recovery key by itself. The same Session may be restored and retired again under a new operation ID; a later retirement must not be mistaken for the earlier operation whose response was lost.

The normative recovery path is therefore `inspectOperation(id, operationId)` (or retrying `retire` with that exact same operation ID). The provider durably indexes the operation ID to its committed result and returns the original token/state even if the Session has since moved to another lifecycle state. `inspectById` remains diagnostic/current-state lookup only. The provider must not compact an operation mapping while the plugin outbox may still reference it.
## Lifecycle error taxonomy, linearization, and retry contract

The capability must distinguish a rejected operation from an operation whose commit outcome is unknown. Callers must never infer rollback from a timeout, abort, connection loss, or generic I/O error after the provider may have crossed its commit point.

### Stable error categories

The following names are semantic categories for the shared persistence package; exact class names may be adjusted upstream, but consumers need stable discriminants and documented retry behavior.

| Category | Meaning | Retry policy | Required caller action |
| --- | --- | --- | --- |
| `unsupported` | Active persistence instance has no lifecycle capability (`undefined`) | Never retry against the same unchanged provider | Refuse destructive action; preserve data |
| `not_found` | Session or opaque token has no durable record in this provider | Do not blind-retry | Reconcile active provider and identity; report absent only when authoritative lookup confirms it |
| `revision_conflict` | `expectedRevision` did not match the current snapshot at admission | Retry only after obtaining a fresh snapshot and making a new user/domain decision | Do not silently overwrite the caller's concurrency expectation |
| `operation_id_conflict` | An operation ID is already bound to a different Session or incompatible request fingerprint | Never retry with that key | Treat as caller bug/corrupt outbox; generate a new key only for a genuinely new intent |
| `state_conflict` | Token/Session is in a state that disallows this transition (e.g. restore after purge) | Do not retry unchanged | Inspect durable state and surface terminal conflict |
| `busy` | Provider writer/lifecycle ownership is held by another operation | Bounded retry with backoff is allowed | Preserve the same operation ID and token; do not create a new intent |
| `cancelled_before_commit` | Provider observed cancellation before the operation linearization point and guarantees no lifecycle mutation committed | Retry is allowed if intent remains valid | Reuse the same operation ID for retire; retain the same token for restore/purge |
| `outcome_unknown` | Provider cannot prove whether commit occurred (e.g. I/O/connection loss around COMMIT) | Never submit a new operation ID | Resolve using exact operation lookup or retry the same idempotency key |
| `corruption` | Durable state, graph, token mapping, or provider invariants failed validation | Never automatically retry or repair primary data | Fail closed, preserve artifacts, require diagnosis |

Errors should expose a stable `kind`/code, Session ID where safe, operation ID for operation-scoped failures, and a `retryable` classification. Do not require callers to parse message text or inspect backend-specific SQLite/JSONL errors. Preserve the original cause for diagnostics, but do not leak storage paths, SQL, frame bytes, or opaque token contents into logs.

### Operation outcome and linearization table

| Operation | Linearization point | Outcome after point | Idempotent retry behavior |
| --- | --- | --- | --- |
| `retire(id, { operationId })` | Durable provider transaction commit that changes live state to retired and persists token + operation mapping | Retired | Same `(id, operationId)` returns the original token and outcome, even if later restored or purged |
| `restore(token)` | Durable transaction commit that makes the exact retired generation live and records restored outcome | Restored | Same token returns the same retirement identity and current live snapshot; it never creates a second live generation |
| `purge(token)` | Durable transaction commit that releases the restorable root, completes graph reclamation, records terminal purged outcome and anti-resurrection fence | Purged | Same token returns the durable purged outcome; it never repeats destructive work against a later generation |
| `inspect*` | Read snapshot/transaction selected by provider | Observed state only | Safe to repeat; inspection does not reserve or authorize a later mutation |

Provider implementations must document the point after which cancellation is no longer allowed to change the result. If cancellation is observed before commit, return `cancelled_before_commit` only when rollback is known complete. Once commit may have happened, return the committed result if known, otherwise `outcome_unknown`; never report a clean cancellation that implies no mutation.

### Exact retry and idempotency rules

- `operationId` is generated and durably stored by the caller before its first `retire` call. It is an idempotency key, not a provider-issued token, revision, timestamp, or random value regenerated on retry.
- Bind the operation key to `(SessionId, operationId, operation kind, request fingerprint/generation)`. Reuse with a different Session, operation kind, or incompatible request must return `operation_id_conflict`; it must not alias an earlier token.
- The provider checks an existing operation mapping before evaluating the original `expectedRevision`. This is essential: a retry after successful commit must return the original outcome even though the Session revision/state has since changed.
- `busy`, `cancelled_before_commit`, and `outcome_unknown` retries retain the exact original operation ID. A fresh operation ID means a new user intent and can target a later lifecycle generation only after explicit reconciliation.
- Restore and purge are keyed by the opaque retirement token. A provider may add optional caller-generated operation IDs for audit/deduplication, but must not make them mandatory in a way that breaks the current proposed API. Token-scoped retries remain idempotent.
- Tokens are opaque, unguessable, provider-scoped capabilities. They are not bearer authorization against arbitrary callers unless the Host's authorization model explicitly says so; possession alone must not bypass plugin/user authorization.
- A known purged token remains inspectable as terminal state for the documented retention window. Its anti-resurrection fence must outlive all artifacts/import paths capable of recreating the Session ID. Token and operation mapping compaction must not erase the only evidence needed by an active outbox recovery.

### Stale token and Provider replacement semantics

- Unknown token: return `not_found`; do not infer that the Session is live or that a legacy artifact may be imported.
- Known token in `restored` state: `restore` is idempotent; `purge` returns `state_conflict` and cannot delete the now-live Session.
- Known token in `purged` state: `purge` is idempotent; `restore` returns terminal `state_conflict` and cannot recreate data.
- Token for an earlier retirement generation after the same Session ID has been restored and retired again: the earlier token continues to identify only its original generation. It must never resolve to or mutate the newer retirement.
- When Cordis replaces `ctx.sessionPersistence`, consumers must stop using the old capability immediately, reacquire from the new active instance, and verify that the new provider owns the same durable backing identity before attempting recovery. A process-local `identity` mismatch is a cache invalidation signal, not proof that the durable database changed or stayed the same.
- A token from another provider/database namespace must not be accepted merely because the Session ID matches. Return a non-disclosing `not_found` or provider-scope conflict; never fall back to filesystem paths or provider-private inspection.
- If the new active provider cannot establish authoritative continuity with the prior provider, keep the outbox pending and fail closed. Do not infer completion from `inspectById` alone.

### Plugin outbox reconciliation protocol

1. Before the first provider call, persist an outbox record containing the Session ID, operation ID, requested action, request fingerprint, provider-neutral intent metadata, and a pending status. For retire, the operation ID must already be durable.
2. Call the currently active provider capability. On a definite committed result, persist the returned token and provider outcome to the outbox before updating user-facing projections.
3. On timeout, process death, `outcome_unknown`, or provider replacement, reacquire the capability from the current active persistence instance and call `inspectOperation(id, operationId)` (or retry `retire` with the same key).
4. If the exact operation mapping is found, reconcile the original token/outcome into the outbox even if the Session has since been restored or purged. Do not substitute the current `inspectById` state for the historical operation result.
5. If the operation mapping is not found, do not immediately create a new operation ID. First establish provider continuity, authoritative absence, and that the original request could not still be in flight. If any condition is uncertain, leave the outbox pending for retry/operator review.
6. Only after durable provider outcome and outbox mapping are reconciled may the plugin publish trash/list/accounting projections. Projection writes are idempotent and can be replayed independently.
7. A projection failure never rolls back provider lifecycle state. Retry projection from the durable outbox; do not call purge or retire again as a projection repair.

### Conformance tests for the error and retry contract

- Stale revision rejects without creating a tombstone, operation mapping, or token.
- Same operation ID and identical retire request returns the exact original token after response loss, process restart, provider restart, restore, and subsequent purge.
- Same operation ID reused for another Session or incompatible request returns `operation_id_conflict` and changes nothing.
- Simulate busy before transaction admission; bounded retry with the same operation ID succeeds once the owner releases.
- Abort before linearization returns `cancelled_before_commit` and leaves no committed lifecycle change; abort immediately after the commit barrier returns committed result or `outcome_unknown`, never false cancellation.
- Drop the connection/kill the caller around COMMIT; exact operation inspection or same-key retry resolves to one durable outcome without duplicate generation.
- Two concurrent restores of one token yield one transition and one idempotent restored result; no duplicate live artifact or generation.
- Restore racing purge yields exactly one terminally valid winner; loser receives state conflict and cannot mutate the winner's state.
- Old token after restore-and-retire of the same Session ID continues to identify only its original generation.
- Replace the Cordis persistence service between request and recovery; old capability use is rejected by consumer identity checks and the new capability must establish provider continuity.
- Provider replacement to a different backing store with same Session ID must not resolve old token or import/fallback stale legacy data.
- Outbox crash at every boundary (before provider call, after commit, before token persistence, after token persistence, during projection) converges to one correct projection without repeating destructive intent.
- Unknown token, expired/compacted mapping, provider corruption, and ambiguous provider continuity all fail closed without automatic filesystem fallback.

### Implementation boundary

This section defines the shared semantic contract only. The existing upstream persistence package currently exports generic persistence errors such as not-found, already-exists, already-owned, ownership-lost, and corruption; it does not yet implement this lifecycle error taxonomy or lifecycle capability. Treat every new error/capability above as a proposal until implemented and covered by the real JSONL and SQLite provider conformance suites.
## JSONL Provider lifecycle transactions: stable fencing, quarantine, and crash recovery

The pinned JSONL Provider stores immutable format-generation files inside a per-Session directory (`sessionDir(root, cwd, id)`). Its current POSIX writer lease is `session.lock` inside that directory; Windows uses a named semaphore derived from that path. The POSIX lease deliberately never unlinks the lock file because `flock(2)` protects an inode, not a pathname. This is correct for append ownership but is not sufficient for directory retirement: renaming the Session directory also moves the lock file, and a later opener at the original path could create a different directory and lock inode. Two processes could then believe they own the same Session ID under different locks.

### Non-negotiable prerequisite: provider-root stable lock namespace

Before enabling lifecycle operations, the JSONL Provider must introduce a stable per-Session kernel lock namespace outside every movable artifact directory, for example `<provider-root>/.lifecycle-locks/<encoded-session-id>.lock` on POSIX and a named kernel object derived from the canonical provider-root + Session ID on Windows.

- Every ordinary write-open, first materialization, append, flush, close, retire, restore, purge, and recovery path must use the same stable per-Session lock identity. It is not enough for only lifecycle methods to acquire it.
- The stable POSIX lock file is persistent and is never unlinked during normal operation, retirement, restore, purge, or cleanup. Its parent directory is provider-owned and must not be renamed with a Session artifact.
- Windows keeps using a kernel semaphore/mutex-like object with process-death release semantics; object naming must be canonicalized consistently and scoped to the provider root, not merely the Session directory path.
- During a compatibility transition, new code may additionally acquire the legacy in-directory lock to coordinate with already-open legacy writers, but this dual-lock bridge is only valid while all legacy processes are known and bounded. It does not make mixed-version deployment supported. The production rollout remains offline: stop every old process, deploy the new provider, and then enable lifecycle.
- The lock order must be globally fixed (provider-root stable lock before any legacy lock, directory/catalog maintenance lock, or artifact operation) to prevent deadlocks. Every path that acquires more than one lock must use the same order.
- Lock acquisition must verify provider-root identity and path canonicalization. Symlink/root substitution, changed mount/device identity, or lock namespace mismatch fails closed.

The stable lock is a concurrency fence, not a durable lifecycle record. Kernel locks disappear when the holder exits; durable state and recovery intent must live separately.

### Provider-owned durable lifecycle ledger

The JSONL artifact directory cannot be the sole source of lifecycle truth because retirement moves that directory. The provider therefore needs a durable ledger under a non-movable provider-owned metadata namespace, keyed by Session ID and retirement generation. The ledger records at minimum: Session ID, provider/root identity, generation, operation ID, request fingerprint, opaque token digest or recoverable token mapping, state/revision, original artifact path, quarantine destination, and last completed transition.

Ledger updates require a crash-safe write protocol: create a unique temporary file in the same metadata directory, write the complete versioned record, sync the file, atomically publish without replacing an unexpected existing record, then sync the containing directory on POSIX. Windows must use the provider's existing write-through namespace primitive and validate no-replacement semantics. A partial temp file is never authoritative. The provider must define a bounded, validated temp-file cleanup protocol under the stable lock; it must not wildcard-delete unknown files.

A single atomic record replacement is not atomic with a directory rename. The provider must therefore use explicit durable intent states and deterministic reconciliation, rather than claiming a cross-resource transaction.

### Retire: write-ahead intent then same-volume quarantine rename

1. Acquire the provider-root stable Session lock. Re-resolve the authoritative current artifact directory and verify the expected Session revision and provider/root identity while holding the lock.
2. Refuse if a live writer, unresolved materialization, pending migration publication, or incompatible lifecycle generation exists. Because ordinary writers use the same lock for their full write-handle lifetime, a successful exclusive acquisition proves no conforming writer is active.
3. Validate the complete selected generation set and Session identity. Do not follow symlinks; require the source to be a provider-owned directory beneath the configured root and verify its device/volume identity.
4. Persist and durably publish a `retiring` intent containing the exact source and quarantine destination, operation ID, generation, and token mapping. This is the durable admission barrier: every subsequent open/read/list/restore/purge path must consult the ledger while holding the relevant stable lock and must not treat `retiring` as live.
5. Create/validate the quarantine parent on the same filesystem/volume as the source. The destination must be unique and must not already exist. Never fall back to copy-and-delete when rename crosses a volume.
6. Rename the whole Session directory atomically to its quarantine destination. POSIX must sync both affected parent directories (once if identical) after rename. Windows uses the existing `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`-style primitive without replacement or copy fallback; verify the resulting source/destination state after any ambiguous error.
7. Persist `retired` in the durable ledger, including the exact original path and quarantine path. Only then return the retirement token as a definite committed result.
8. If the process crashes at any boundary, leave the intent and artifacts intact. Recovery under the same stable lock inspects source and destination and deterministically completes or refuses the transition; it never guesses based only on a missing source path.

Retire's linearization point is the durable `retiring` admission barrier, not the rename. Before that barrier, new opens may be admitted; after it, all new opens and mutations must reject or wait. The operation is reported as successfully retired only after the quarantine rename and durable `retired` ledger state are confirmed. If the caller loses the response after that point, the operation mapping recovers the original token.

### Restore: reverse publication with conflict detection

1. Acquire the same stable Session lock and verify the token identifies the exact retired generation and provider/root namespace.
2. Persist `restoring` intent with exact source/destination paths and revision. Do not overwrite an existing live artifact directory, even if it appears empty.
3. Verify quarantine directory identity, selected generation files, header Session ID, format version, and content integrity. Preserve every generation file; do not reconstruct from a listing projection.
4. Ensure the original parent exists durably. Rename quarantine directory back to the original Session directory on the same filesystem/volume, with the same POSIX parent-directory sync or Windows write-through publication rules.
5. Persist `live`/restored terminal outcome and retain the old retirement token's generation mapping. A subsequent retire uses a new generation and a new operation ID.
6. If source and destination both exist, neither exists, or either path has an unexpected identity, stop and mark the lifecycle record as recovery-required/corrupt. Never overwrite, merge, or delete either side automatically.

Restore does not authorize a stale token to affect a later retirement generation. Repeated restore with the same token returns its original idempotent outcome only when the exact generation is already restored; purge of that token must then return a state conflict.

### Purge: durable terminal fence before non-atomic recursive deletion

Filesystem recursive deletion is not atomic. Purge must not pretend that deleting a directory tree can be rolled back after a crash.

1. Acquire the stable Session lock and verify the exact retired generation; refuse if any restore or other lifecycle transition is active.
2. Persist a `purging` intent and durable anti-resurrection fence before deleting any quarantined artifact. All open/create/import/routing paths must consult this fence and reject recreation of the same Session ID.
3. Verify the quarantine directory identity against the recorded device/file identity and ensure it is strictly beneath the provider-owned quarantine root. Refuse symlinks, mount-point surprises, path escapes, or changed root identity.
4. Delete only the exact recorded quarantine generation, using a no-follow traversal that does not follow symlinks. Deletion is restartable: missing descendants are acceptable only when the recorded purge intent proves this exact generation was already being removed.
5. Persist progress only as diagnostic/recovery hints; the durable `purging` intent remains authoritative until the exact destination is absent and its parent namespace has been durably synced.
6. Persist terminal `purged` state and retain the Session ID fence plus operation/token mappings for the required anti-resurrection retention period. The fence outlives every legacy import, delayed create, and marker path capable of publishing that ID.
7. If deletion fails, keep the Session unavailable in `purging`; do not restore it automatically or expose a partially deleted directory as live.

The purge linearization point is the durable anti-resurrection fence plus `purging` state. Physical deletion may continue asynchronously/restartably after that point, but the API must distinguish logical purge committed from physical cleanup pending. If the API promises purge completion only after bytes are gone, it must wait for durable absence; it must not equate logical purge with forensic erasure.

### Read admission and already-open readers

The current JSONL reader resolves a current generation path and then opens/scans it; it does not hold a provider lifecycle read lease across admission. A directory rename does not invalidate an already-open file descriptor, and a reader that resolved a path before retirement may still open/read after the rename unless admission is coordinated.

- Every new read-open must acquire the stable Session lock, inspect lifecycle ledger state, resolve the authoritative live/quarantine path, and open the selected generation file while still holding the lock. Release the lock only after the file descriptor (or an equivalent stable read handle) is established.
- The opened descriptor is the read admission point. A reader admitted before the durable `retiring` barrier may finish from its already-open descriptor after retirement; a reader arriving after the barrier must reject with the typed retired/busy outcome.
- Path resolution followed by an unlocked open is a TOCTOU bug and must not remain in lifecycle-enabled code.
- Listing/stat APIs must omit retired/purging/purged Sessions and must not fall back to quarantine or legacy artifacts when a ledger fence exists.
- If a read path cannot be changed to establish descriptor admission under the stable lock, destructive retirement is not safe to enable for that path.

### Crash recovery matrix

| Crash boundary | Durable state | Required recovery |
| --- | --- | --- |
| Before `retiring` ledger publication | `live`; source directory remains | Retry as a new attempt only after confirming no intent committed |
| After `retiring`, before rename | `retiring`; source exists, destination absent | Validate source identity and complete rename, or mark recovery-required; never reopen as live |
| During/after rename before parent sync | `retiring`; source/destination may be ambiguous after power loss | Inspect both paths and identities; sync the observed namespace state; never infer from syscall return alone |
| After rename and parent sync, before `retired` ledger publication | `retiring`; destination exists | Verify destination identity and finalize `retired` |
| After `retired`, before caller receives token | `retired`; destination exists | `inspectOperation` returns original token/outcome |
| During restore before reverse rename | `restoring`; quarantine exists | Resume only after verifying exact paths and identities |
| After restore rename before `live` publication | `restoring`; original path exists | Verify identity and finalize live; do not publish a second copy |
| During purge deletion | `purging`; quarantine may be partial | Continue no-follow deletion of the exact recorded generation |
| After destination deletion before terminal ledger update | `purging`; destination absent | Sync parent, finalize `purged`, preserve anti-resurrection fence |

Unknown or conflicting path states are not automatically repaired. The provider leaves the Session unavailable and preserves all remaining artifacts for diagnosis.

### Cross-platform durability and filesystem assumptions

- Source and quarantine must be on the same mounted filesystem/volume. Rename atomicity is not promised across devices; no copy fallback is allowed.
- POSIX requires syncing file contents before publication, then syncing affected parent directories after namespace changes. Directory sync failures are operation failures with an ambiguous outcome that must be reconciled by inspecting durable state.
- Windows uses the existing write-through namespace primitive for publication and directory creation, but tests must verify the actual filesystem behavior on supported Windows versions and filesystems; do not claim POSIX directory-fsync equivalence.
- Network filesystems, cloud-sync folders, overlay filesystems, removable volumes, and filesystems with unverified lock/rename durability semantics are unsupported unless separately conformance-tested.
- Stable lock files are never removed. Session artifact directories may be renamed or purged only while the stable lock is held; the lock namespace itself is outside the artifact tree.
- Do not use directory existence, lock-file existence, trash listing, or marker presence alone as proof of ownership or lifecycle state.

### Required JSONL lifecycle conformance tests

- Two processes: writer holds stable lock; retire returns busy and does not rename. Writer exits/SIGKILL; retire acquires the same lock and succeeds.
- Reverse order: retire publishes `retiring`; new write-open, create/import, read-open, list, and stat cannot observe the Session as live.
- POSIX regression: rename/purge Session directory while stable lock is held; a competing process must still contend on the same persistent lock inode at the provider-root namespace.
- Legacy in-directory `session.lock` is never unlinked while held; migration to the new stable namespace runs only with old processes stopped.
- Read-open race at every boundary: before intent, after intent, after rename, and after restore; admitted pre-barrier descriptors may finish, post-barrier readers reject.
- Crash after each ledger write, file sync, directory sync, rename, and purge unlink; restart yields one valid state or explicit recovery-required, never accidental live fallback.
- Restore conflicts: destination already exists, quarantine missing, both paths exist, wrong Session ID, changed device/root, corrupt generation, symlink injection, and path traversal all fail closed without overwrite.
- Purge tests: partial recursive deletion, symlink replacement, parent swap, process death, disk-full, permission failure, and repeated restart; only the recorded quarantine generation is removed.
- Concurrent retire/restore/purge on the same Session serialize under one stable lock and produce one generation-scoped terminal outcome.
- Multiple Session IDs sharing a project directory can retire/restore/purge independently; project parent directories are not moved or deleted as collateral.
- POSIX and Windows tests verify same-volume constraint, no-replace publication, namespace durability, process-death lock release, and root lock namespace stability.
- Recovery tests prove operation ID mapping, tombstone, and purged-ID fence survive artifact directory deletion and caller response loss.

### Implementation status and safety gate

This section is a proposed provider contract, not a claim that the pinned upstream JSONL Provider already supports lifecycle operations. The current writer lease is directory-local, reads do not establish lifecycle admission under a stable lock, and there is no provider-owned durable lifecycle ledger/quarantine protocol in the pinned revision. Until all three are implemented and the cross-process crash matrix passes on supported platforms, JSONL destructive lifecycle operations must remain unsupported and fail closed. The plugin must not move or delete Session directories itself.
## JSONL lifecycle ledger: record format, durability, recovery, and scale

The lifecycle ledger is provider metadata, not a user Session artifact. It must survive quarantine and purge, and its correctness must not depend on a single mutable JSON document or a rebuildable directory listing. The initial implementation should prefer a simple per-Session append-only journal over a global index or a mutable whole-provider manifest.

### Namespace and sharding

Use a provider-owned metadata root that is outside all Session and quarantine directories and is bound to a canonical provider-root identity. Store one journal per encoded Session ID in a deterministic sharded namespace, for example `.lifecycle-ledger/<first-two-hex-of-hash>/<encoded-session-id>.journal`. Sharding avoids huge flat directories; one journal per Session avoids a global write bottleneck. The stable per-Session kernel lock from the preceding section serializes journal access and every corresponding artifact transition.

- The Session ID is encoded as one safe path component; the shard is derived from a cryptographic hash of the canonical Session ID, not from caller-controlled path fragments.
- Journal records repeat the full Session ID and provider-root identity. On open, verify both against the requested identity and the namespace path; a mismatch is corruption, not a reason to try another path.
- A global listing index is only a cache/projection. It can be rebuilt from validated journals and live artifact headers; it never authorizes open, restore, or purge.
- Do not place all Sessions in one JSON file, one SQLite database shared with user artifacts, or one global lock. Per-Session journals and locks permit unrelated Sessions to progress independently.
- Journal creation is itself durable: create the shard directory safely, sync its parent when required, create the journal without replacement, sync the new file, then sync the containing directory before reporting the first durable lifecycle intent.

### Versioned append-only record envelope

Each journal is a sequence of bounded, length-delimited records. A record contains a fixed magic value, format version, record type, monotonically increasing per-Session sequence number, payload length, canonical payload bytes, and checksum. The encoding must be deterministic and reject duplicate keys, invalid UTF-8, non-canonical integer encodings, unknown mandatory fields, oversized lengths, and trailing bytes.

Recommended record envelope fields:

- `magic`, `formatVersion`, `recordType`, `sequence`, `payloadLength`.
- `providerRootId`, `sessionId`, `generation`, `revision`.
- `operationId`, `operationKind`, stable request fingerprint, and previous-record digest.
- `state` and only the transition-specific data required to resume or inspect the operation.
- `checksum` over the complete envelope and payload; a cryptographic digest chain links each record to its predecessor.

Use a well-specified canonical binary encoding (or rigorously canonical JSON with explicit byte framing); do not depend on ordinary `JSON.stringify` object property order as a storage protocol. Set hard limits for record size, journal size, string lengths, and number of outstanding operations. Unknown optional fields may be skipped only when the format version explicitly permits it; unknown mandatory record types or fields fail closed.

The checksum detects torn/corrupt records; it is not an authenticity boundary against an attacker who can rewrite provider files. If hostile local file modification is in scope, use a separately protected key and authenticated records, with a defined key provisioning/rotation/recovery design. Do not imply that CRC or a hash chain prevents a privileged filesystem writer from forging state.

### Append and durability contract

While holding the stable per-Session lock:

1. Open the journal with no-follow semantics and verify it is a regular provider-owned file beneath the metadata root; reject symlinks, hard-link surprises where detectable, unexpected owner/ACL/mode, or root identity changes.
2. Read and validate the last committed record, sequence, and digest. Never accept a sequence rollback or a journal whose identity differs from the requested Session.
3. Append one complete framed record. Handle short writes and interruptions; never assume a single write call writes the entire record.
4. Flush userspace buffers and sync the journal file before treating the record as durable. The provider must document the actual OS/filesystem primitive used and its failure semantics.
5. For a newly created journal or newly created shard, sync the containing directory after the entry is published. A durable file body without a durable directory entry is not sufficient.
6. Only after the durable append may the provider cross the next external filesystem boundary (quarantine rename, restore rename, purge deletion) or return a committed operation result.

A sync error or process death around append has an ambiguous outcome. Reopen and scan the journal under the stable lock. If the complete record is present and validates, treat it as committed; if only an incomplete final tail is present, apply the tail-recovery rule below; if the result cannot be established, return `outcome_unknown` and retain the same operation ID. Never append a conflicting retry under a new operation ID.

### Torn-tail recovery versus corruption

On startup or journal access, scan records from the beginning and validate framing, sequence monotonicity, identity, checksum, and digest chain.

- A strictly incomplete final record (for example, fewer bytes than its declared bounded length at EOF) may be truncated to the last fully validated record only while holding the stable lock, followed by file sync. This is safe only because the append protocol writes records serially and syncs before advancing the external state machine.
- A complete final record with an invalid checksum, invalid sequence, wrong previous digest, malformed payload, or impossible transition is corruption. Do not silently truncate it.
- Any invalid record followed by additional bytes is interior corruption and must fail closed; do not scan forward looking for a plausible magic marker.
- If an incomplete final record could have preceded an external rename or deletion, the state machine must prove that no external transition was permitted before the append became durable. If that ordering cannot be proven for a historical format, mark recovery-required rather than truncate.
- Keep the original journal and diagnostic evidence. Do not automatically replace it with an empty file, rebuild it from artifact directories, or fall back to legacy JSONL as if no lifecycle record existed.

### State machine and operation mapping

Journal records are immutable facts; current state is a fold over the validated sequence. The minimum state transitions are:

| Current state | Record | Next state | Required durable ordering |
| --- | --- | --- | --- |
| absent/live | `retire_intent` | `retiring` | Append + sync before quarantine rename |
| retiring | `retire_committed` | `retired` | Rename + parent sync before append + sync |
| retired | `restore_intent` | `restoring` | Append + sync before restore rename |
| restoring | `restore_committed` | `live` | Rename + parent sync before append + sync |
| retired | `purge_intent` | `purging` | Append + sync + anti-resurrection fence before deletion |
| purging | `purge_committed` | `purged` | Destination absent + parent sync before append + sync |

Every successful retire stores an operation mapping keyed by `(SessionId, operationId)` and binds it to operation kind, request fingerprint, generation, and exact opaque token. A repeated matching operation returns the exact original result, even if later generations exist. Reusing the same operation ID with a different Session ID, operation kind, or fingerprint returns `operation_id_conflict`. A new retirement after restore creates a new generation and new operation mapping.

Do not store only a token digest: after a lost response, the provider must be able to return the original opaque token. Store the high-entropy token bytes in the protected provider metadata journal, or define a separately protected deterministic derivation scheme with a durable key lifecycle. The simpler initial contract is to store the token bytes, restrict metadata-root access, avoid logging tokens, and make clear that token possession alone is not a substitute for caller authorization.

Operation mappings and terminal purged-ID fences must outlive the artifact directory. Do not compact them based only on wall-clock TTL. A mapping can be reduced to a minimal deduplication record only when the exact original token/outcome remains recoverable and no caller can legitimately retry the operation.

### Snapshotting and compaction

Do not implement compaction in the first lifecycle release. Per-Session journals are expected to be small, and correctness is more valuable than premature rewrite logic. Enforce conservative size/count limits and surface a maintenance-required condition before reaching them; do not silently discard dedupe mappings or fences.

If compaction becomes necessary, it is a separate versioned protocol:

1. Under the same stable Session lock, validate the entire journal and fold it into a canonical snapshot containing current state, all still-required operation mappings/tokens, generation fences, last sequence, and last digest.
2. Write snapshot to a unique temporary file in the same metadata directory; sync it; publish it with no-replace/atomic replacement semantics; sync the directory.
3. Only after the snapshot is durably published, create a new journal segment whose header references the snapshot sequence and digest; sync the segment and directory.
4. Atomically publish a small manifest selecting the snapshot + segment set, then sync the directory. Recovery validates both old and new sets and selects only a manifest whose referenced files and digests all validate.
5. Retain the previous snapshot/segment set until the new manifest is durable and verified. Cleanup is a later idempotent maintenance step, never part of the critical compaction commit.
6. Crash injection at every file write, sync, rename, manifest publish, and cleanup boundary must prove recovery selects a complete old or complete new representation, never a mixture.

Compaction must preserve the exact token and outcome for every retryable operation and every anti-resurrection fence. It may not erase history merely because the Session is purged or the corresponding artifact directory is gone.

### Multi-Session scaling and recovery isolation

- A Session journal append holds only that Session's stable lock; no provider-wide lock is held during ordinary lifecycle transitions.
- Provider startup may discover shard directories, but it must not eagerly load every journal into unbounded memory. Use bounded workers, bounded file descriptors, and per-journal validation on demand.
- A global index is derived and rebuildable. If it is stale or missing, rebuild it from validated per-Session journals before using it for listing; never use it to authorize a destructive operation.
- Recovery of one corrupt journal must not block unrelated healthy Session IDs, but that ID remains unavailable and the provider reports a scoped degraded state. Provider-wide root identity or metadata-root corruption disables all lifecycle operations.
- Recovery must be idempotent and safe across processes. The stable per-Session lock serializes one journal; any shard-wide maintenance operation has a separate lock acquired only after the per-Session lock in a documented global order.
- Bound concurrent recovery and quarantine cleanup. Do not hold a single provider-wide lock while recursively deleting large Session directories.

### Security and integrity boundaries

- Metadata root and lock namespace must be created with restrictive permissions/ACLs and verified on every open. POSIX mode bits alone are not a substitute for ownership checks; Windows ACL inheritance must be explicitly tested.
- Reject symlink traversal and path substitution at every component. Use directory-relative/no-follow operations where supported; revalidate file identity immediately before rename/delete.
- Bind journal records to provider-root identity so copying a journal into another configured root does not authorize operations there. A copied root restored as a whole is a separate disaster-recovery scenario requiring explicit root identity restoration.
- Never put event payloads, prompt content, frame bytes, or arbitrary caller metadata in lifecycle records. Store only bounded identity, transition, token, and recovery data.
- Checksums and hash chains provide accidental-corruption/torn-write detection, not encryption, authorization, or protection from an attacker with write access to the metadata root.
- Backups must capture journal files, lock namespace metadata as applicable, quarantine artifacts, and root identity consistently. Restoring only journals or only artifact directories can create ambiguous state and must trigger reconciliation/fail-closed behavior.

### Ledger conformance and fault-injection tests

- Short write at every byte boundary; EINTR; disk full; file sync failure; directory sync failure; process kill before/after sync; ambiguous append result and same-operation retry.
- Incomplete final header/payload may be truncated only when no external transition could have followed; complete checksum failure and interior corruption fail closed.
- Wrong Session ID, provider-root ID, shard path, generation, sequence, previous digest, duplicate operation ID with different fingerprint, unknown mandatory record type, oversized length, malformed UTF-8, and trailing bytes all reject.
- Concurrent processes append to different Session journals independently; same Session appends serialize; no global index lock serializes unrelated Sessions.
- Missing/stale global index rebuilds from validated journals; corrupt one Session journal does not authorize fallback or disable unrelated IDs.
- Token survives lost response and restart; exact same operation returns same token; token is not logged; permissions/ACL tests deny unrelated users/processes.
- Snapshot/manifest crash matrix is mandatory before compaction ships; initial release tests assert compaction remains disabled.
- Backup/restore combinations (journal-only, quarantine-only, complete consistent root) produce explicit safe outcomes; partial restore never reopens an ambiguous Session.

### Implementation gate

This is a proposed storage contract. The pinned upstream JSONL Provider currently has no lifecycle ledger, no generation-scoped durable operation journal, and no cross-resource recovery protocol. Until the journal format, sync semantics, stable lock, quarantine protocol, and fault-injection tests are implemented together, the plugin must continue to treat JSONL lifecycle capability as unsupported.
