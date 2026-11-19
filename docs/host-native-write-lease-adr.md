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
