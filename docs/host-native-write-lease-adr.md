# ADR: Provider-owned Session lifecycle transactions

- Status: proposed
- Scope: Host persistence lifecycle contract shared by built-in providers
- Depends on: plugin-level cross-process operation lock in PR #12
- Replaces: the earlier JSONL-directory-move protocol
- Non-goal: exposing provider-private paths, lock files, database tables, or kernel primitives to plugins
- Evidence trust policy: [Evidence provenance and trust policy](./evidence-provenance-and-trust-policy.md)

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

The sketch above is intentionally non-final. The concrete additive capability shape, operation-ID rules, read-admission semantics, and compatibility contract are refined in the [upstream API proposal](./provider-lifecycle-api-proposal.md). That proposal recommends an optional capability on the active `SessionPersistence` instance, defaulting to absent for existing providers; it treats startup recovery as provider-owned initialization rather than requiring consumers to call a provider-specific recovery method. The existing snapshot `location`, where a backend supplies it, remains observational metadata only and never grants storage mutation authority.

The exact surface may instead use an explicit transaction object with prepare/commit/abort. The non-negotiable semantics are:

1. **Stable identity:** coordination is keyed by stable `SessionId`, not by current file existence or pathname.
2. **Writer fencing:** lifecycle mutation atomically excludes new write opens and creates for that ID, and waits for admitted writers to drain their final event batch before destructive ownership is granted.
3. **Absent-artifact restore:** a retirement token remains valid while the live artifact is absent. Restore does not need a fake live artifact or a lease on a missing file.
4. **Provider-owned mutation:** the provider performs quarantine, restore, and purge using its own storage model. Consumers receive an opaque token/state, never a private storage path.
5. **Idempotency and lost responses:** `retire` requires a caller-generated `operationId` that is stable across retries. If the provider commits retirement but the process dies before receiving the response, retrying the same `operationId` returns the same retirement token. The plugin persists the exact `operationId` before calling the provider; after a lost response it recovers the historical result with `inspectOperation(id, operationId)` (or retries `retire` with that same key). `inspectById(id)` is only a current-state diagnostic and MUST NOT substitute for exact operation recovery after same-ID restore/re-retire cycles. Repeated restore/purge calls with the same token return the committed terminal state or a typed terminal-state error; they cannot create duplicate retirement or destroy unrelated data.
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

Provider mutation and plugin metadata publication are not one distributed transaction. The plugin must persist its `operationId` before calling `retire`. If it crashes after provider commit but before storing the returned token, startup uses `inspectOperation(id, operationId)` (or retries `retire` with the same `operationId`) to recover the exact provider-issued token and historical outcome, then completes the plugin projection. `inspectById(id)` is diagnostic/current-state lookup only: after a same-ID restore/re-retire cycle it cannot identify which historical retirement the outbox is recovering. The outbox must retain the operation ID until reconciliation is durable.

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
- `inspectOperation(id, operationId)` must return enough durable state to reconcile a caller that committed an operation but died before persisting its returned token. Its retention/compaction rules must not discard the exact historical outcome, token, and generation binding while the corresponding plugin outbox may still reference that operation. `inspectById(id)` reports only current lifecycle state and is not an operation-recovery index.
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


## JSONL stable-lock adoption and mixed-version rollout

The stable provider-root lock and lifecycle ledger are a coordinated storage-protocol upgrade, not an additive lock that can safely coexist with the current directory-local lease. The pinned JSONL implementation has the following relevant behavior:

- POSIX write ownership is a `flock(2)` on the inode at `<session-dir>/session.lock`; Windows uses a named kernel semaphore derived from that path.
- Existing-artifact write opens acquire this lease, and the write handle retains it for its lifetime. A create handle acquires it lazily, immediately before its first materializing write.
- Read handles do not acquire the current write lease. They resolve the current generation path and read it independently.
- Consequently, a legacy writer, a pending create, or a legacy reader has no knowledge of a newly introduced provider-root lifecycle lock. Acquiring the new lock in a newer process does not fence any of them.

These are verified constraints at the pinned upstream commit `2e39e70496aa02986ca6a820c5d497e816b69d7e`. This section defines a proposed migration protocol; it does not claim the upstream provider implements it.

### Non-negotiable compatibility rule

There must be no production interval in which old and new provider processes can access the same JSONL root while relying on different lock namespaces. The old in-directory lease cannot be treated as a bridge:

- An old process never acquires the new stable lock, so a new process holding it cannot exclude an old writer or reader.
- A new process holding both locks does not solve the problem: old processes still do not honor the new lock, and directory movement can change the in-directory lock identity.
- A lock-file existence check, process-local version check, package semver check, or timeout is not proof that every old process has stopped.
- Do not automatically fall back to `session.lock` when a stable lock or ledger is missing. Such fallback would silently reopen the split-lock protocol.

Therefore, **offline, all-processes-stopped migration is mandatory** for the first stable-lock deployment. Rolling upgrade and mixed-version operation are unsupported until a future protocol explicitly proves a shared fencing handshake.

### Root identity and namespace bootstrap

The provider must establish one durable identity for the configured storage root before creating any stable per-Session lock:

1. Resolve and validate the configured root using provider-owned no-follow rules. Reject unexpected symlinks, non-directory components, ownership/ACL mismatches, and path substitutions. Do not assume two textual paths identify different roots, or that equal path strings identify the same physical root.
2. Create or read a versioned root-identity record under a protected provider metadata namespace. Its random root ID is durable data, not a hash of the current path. Creation uses exclusive publication, file sync, and containing-directory sync; concurrent initializers must converge on the one published identity or fail closed.
3. Bind the identity record to the expected storage-root physical identity and metadata namespace. Revalidate this binding when opening locks and journals. Copying only the metadata namespace to another root must not authorize operations there.
4. Derive stable per-Session lock names from the root ID and canonical Session ID encoding, not from a movable Session directory. POSIX lock files live in a non-movable provider metadata directory and are never unlinked or replaced. Windows uses a named kernel synchronization object derived from the same canonical tuple; name length, namespace scope, and cross-user collision behavior require platform tests.
5. A missing, malformed, mismatched, or inaccessible root identity is a provider-wide lifecycle recovery error. Never silently mint a new identity over existing Session data or infer identity from directory contents.

The root ID is an identity namespace, not an authorization secret. ACLs, ownership checks, no-follow path handling, and operation validation remain mandatory.

### Offline upgrade procedure

The migration is an operator-controlled maintenance transaction with an explicit traffic barrier:

1. **Prepare:** publish the exact new provider version and migration tooling, but keep lifecycle capability disabled. Validate disk capacity, filesystem support for required rename/sync semantics, permissions, and a consistent backup/restore plan.
2. **Stop admission:** stop routing new requests and prevent automatic restarts, schedulers, worker launches, and background recovery from opening the root.
3. **Drain and stop:** close every Session handle; wait for each write handle's mutation chain, routed live-event buffer, final flush, and close completion. Stop all Host processes, child workers, test/maintenance processes, and any external tool that can access the root. A process list or PID file alone is insufficient; the deployment supervisor must establish the stop barrier.
4. **Verify quiescence:** with no process able to reopen the root, verify the old deployment is stopped and no external writer remains. If this cannot be established, abort before changing lock or artifact state.
5. **Back up:** take a provider-consistent backup of the complete root, including Session generations, old lock files as inert historical artifacts, metadata, and any relevant sidecars. Preserve the backup's identity and restore instructions. Do not combine files from different points in time.
6. **Initialize metadata:** publish and sync the root identity, stable lock namespace, and ledger namespace. Validate every existing Session ID/path relationship without moving or rewriting Session artifacts. Old `session.lock` files are not imported as lock authority and are not deleted as part of bootstrap.
7. **Reconcile before enabling:** inventory all Session artifacts, validate their current generation and identity, and establish an explicit initial lifecycle state for each. A missing/corrupt artifact or ambiguous inventory blocks that Session; it must not be guessed live or retired. The global listing index is rebuilt only from validated authoritative records.
8. **Start only the new version:** configure every process that can access the root to use the same provider build and stable-lock protocol. Verify version/build identity at process startup and ensure the supervisor cannot start an older binary.
9. **Run admission and recovery gates:** validate root identity, lock namespace, ledger integrity, journal recovery, and per-Session reconciliation before enabling reads/writes. Lifecycle capability remains unavailable until the provider-wide gates pass.
10. **Resume traffic:** enable the new provider and lifecycle capability only after all processes are on the new protocol and the deployment barrier has been released deliberately.

Any failure before step 10 leaves destructive lifecycle capability disabled. Roll back by restoring the complete consistent backup while all processes remain stopped; do not attempt a mixed-version rollback against a root that has already accepted new-protocol writes.

### Stable-lock admission contract after migration

Every operation that can observe or mutate Session lifecycle state must participate in the same stable per-Session lock protocol. This includes read open/admission, write open, pending-create materialization, append, flush, close/drain, retire, restore, purge, and recovery. A provider must not claim complete fencing while any public or internal path bypasses the protocol.

- **Read admission:** acquire the stable Session lock, validate root identity and authoritative lifecycle state, resolve the current generation, open the required file descriptor(s), and validate the opened object identity while still holding the lock. Only then release the lock. The descriptor is the read-admission point; a read admitted before the retire barrier may finish from its already-open descriptor, while a read admitted after the barrier rejects. A path string resolved under the lock but opened after releasing it is not sufficient.
- **Write admission:** acquire the same stable lock before a write handle is returned and retain the lease for the full handle lifetime, including its queued mutations and final close drain. For a pending create, reserve the Session identity at create time or acquire the lock before publishing any materialized artifact; lazy acquisition must not allow two processes to materialize the same ID concurrently. The chosen behavior must be consistent across providers and tested.
- **Lifecycle transition:** hold the stable lock across the ledger intent, filesystem transition, durability barriers, and terminal ledger record. Never release it between checking state and publishing the mutation.
- **Close:** drain all in-flight and routed writes before releasing the stable lock. Release must be idempotent; a drain failure must not be reported as a successful clean close. Kernel ownership is released on process death, while the durable ledger state is recovered by the next process.
- **Recovery:** acquire the same per-Session lock before reconciling an individual journal/artifact pair. A process-wide startup coordinator may bound work, but must not replace per-Session exclusion or serialize unrelated normal operations.

An already-open read descriptor may continue after retirement admission closes; this is an explicit grandfathering rule, not permission for a later read on the same handle to reopen the pathname. The API must either pin all data needed by the admitted read or reject subsequent reads once the lifecycle generation changes. This behavior needs a dedicated handle contract and tests.

### Lock order and maintenance fencing

Define one lock order and enforce it in every code path:

1. provider-root maintenance/admission gate, when required;
2. per-Session stable lock;
3. journal append/metadata lock, if distinct;
4. filesystem object operations and directory durability barriers.

Prefer avoiding a second journal lock when the per-Session stable lock already serializes the journal. If a shard or root-wide maintenance operation needs additional coordination, document a single total order and never acquire a higher-ranked lock while holding a lower-ranked one. Listing/index rebuild must use a snapshot or bounded per-Session locks; it must not hold a global lock while waiting for arbitrary Session work.

The maintenance gate is reserved for offline bootstrap, root identity changes, namespace migration, and future compaction/manifest publication. Normal Session operations must not take a provider-wide exclusive lock. Recovery and shutdown must have bounded concurrency and must not wait while holding unrelated Session locks.

### Deployment state machine and fail-closed gates

Treat the provider deployment as one of these explicit modes:

- `legacy_only`: old provider protocol; lifecycle capability unsupported.
- `migration_required`: new binary sees an uninitialized or legacy root; it refuses destructive operations and does not fall back to legacy locking.
- `quiesced_migration`: operator has established the all-processes-stopped barrier; metadata initialization/reconciliation may run.
- `stable_lock_ready`: root identity, stable lock namespace, and ledger are validated, but lifecycle capability remains disabled until all deployment processes are verified new-version.
- `lifecycle_enabled`: all root-wide and per-Session gates pass; every access path participates in stable admission.
- `recovery_required`: ambiguous identity, lock, journal, artifact, or migration state; destructive operations and new writes fail closed pending explicit recovery.

The provider must not infer `lifecycle_enabled` from the presence of a metadata directory. It requires an explicit successful migration/reconciliation result and a deployment-level guarantee that no legacy process can return. If process-version attestation cannot be made reliable, the deployment must remain offline until an operator-controlled cutover guarantees it.

### Rollback and compatibility policy

- Before any new-protocol write or lifecycle transition, a failed migration may restore the complete pre-upgrade backup with all processes stopped.
- After a new-protocol write, do not start the legacy provider against the upgraded root. The old implementation does not understand the root identity, stable lock namespace, ledger, or lifecycle fences.
- After the first retire/restore/purge transition, rollback to a legacy provider is categorically unsupported. Recovery is forward-only using the new protocol or a consistent full-root disaster-recovery restore with an explicit data-loss point.
- A package downgrade is not a storage rollback. Package version, root format version, and lifecycle protocol version must be tracked independently.
- A future rolling upgrade requires a separately reviewed compatibility protocol in which old and new binaries demonstrably share one fencing authority before either can access the root. Merely adding a compatibility lock to the new binary is not such a protocol.

### Migration and admission conformance tests

- Old writer holds the in-directory POSIX lock while new version starts: new version must refuse migration/admission until the deployment stop barrier is proven; acquiring a stable lock alone must not proceed.
- Old process with a pending unmaterialized create, a materialized writer, a reader, a listing, and a recovery worker are each tested across the cutover boundary.
- Verify no old process can reopen after quiescence; supervisor restart prevention and stale worker/process cases are covered.
- Two textual root aliases, symlink substitution, root replacement, copied metadata directory, wrong root ID, and concurrent first bootstrap all fail safely.
- Stable lock names are deterministic for the same root identity/Session ID and isolated across different roots; POSIX inode identity survives ordinary process restart and is never unlinked; Windows named-object scope and release-on-process-death are tested.
- Read races cover resolve/open/path-swap, descriptor acquisition under lock, multiple reads on an already-open handle, retire after admission, and restore/purge while a descriptor remains open.
- Pending-create races cover create/create, create/retire, lazy first flush vs retire, and process death before/after first materialization.
- Lock-order tests exercise shutdown, recovery, index rebuild, journal append, and maintenance operations under contention; deadlock detection uses bounded timeouts without using timeouts as lock ownership.
- Migration crash injection covers every root-identity, namespace, journal-bootstrap, reconciliation, and capability-enable boundary. A crash must leave capability disabled until a repeatable validation succeeds.
- Rollback tests prove that pre-upgrade full-root restore is possible and that starting the legacy provider after new-protocol writes is refused.

### Implementation gate

The pinned upstream JSONL provider does not currently implement the provider-root stable lock, read admission, durable lifecycle ledger, or deployment-wide version gate described here. Its existing directory-local writer lease is not a compatibility bridge for lifecycle fencing. The lifecycle capability must remain unsupported until the provider implementation, offline migration tooling, deployment controls, and cross-process fault-injection suite ship together.


## Multi-process recovery convergence, isolation, and readiness

Recovery is a repeatable reconciliation protocol over the authoritative per-Session journal and provider artifacts, not a one-time startup script. Any process may discover work; only the process holding that Session's stable lock may reconcile it. A crash releases kernel lock ownership, not durable intent, so another process can safely resume.

### Authority and invariants

- The per-Session lifecycle journal is authoritative for lifecycle intent, generation, operation mappings, tokens, and terminal fences. Artifact/quarantine state is evidence of external effects, not independent lifecycle truth.
- Global listing indexes, startup caches, in-memory queues, PID files, and process-local recovery markers are derived hints only. None authorizes restore, purge, overwrite, or state promotion.
- Every reconciliation pass uses the same stable per-Session lock as reads, writes, and lifecycle transitions. Kernel lock ownership is the recovery claim; do not add a time-based distributed lease whose expiry could permit concurrent reconcilers.
- Recovery is idempotent: repeating it after any completed step yields the same authoritative state without repeating a non-idempotent external effect.
- Recovery never guesses intent from artifact presence/absence, recreates a missing journal, or converts corruption into an empty/live Session.
- One Session's inconsistency is scoped to that Session. Root identity, metadata namespace, or lock-protocol corruption is provider-wide and disables lifecycle capability.

### Discovery, scheduling, and lock ownership

1. Validate provider-root identity and metadata namespace before scheduling Session work.
2. Discover journal names using bounded directory iteration. Validate encoded ID/path relationships; do not trust the global index as discovery authority.
3. Use a bounded worker pool with limits for active workers, descriptors, queued IDs, bytes read per slice, and total startup work. Apply backpressure rather than allocating one task or loading one journal per Session.
4. Workers acquire one Session's stable lock, revalidate root identity and journal pathname/object identity, then validate the complete bounded journal before acting.
5. Re-read the journal from its authoritative descriptor after acquiring the lock. Discovery snapshots are stale hints, never mutation inputs.
6. Reconcile only that Session, durably append any required recovery record, then release the lock. No worker holds two Session locks.
7. Use fair scheduling with rotating shard traversal so a hot or failing ID cannot starve unrelated IDs. Retry transient I/O with bounded backoff; corruption is not a retry loop.
8. Multiple processes may discover the same work. Lock contention makes all but one defer. A crash leaves no durable owner to clean up; another process reacquires the kernel lock and resumes.

A process-local queue may coalesce duplicate IDs, but correctness cannot depend on it. Do not persist a 'recovering=true' flag as a lock substitute; diagnostic progress is advisory and cannot block a later lock holder.

### Deterministic reconciliation matrix

After validating journal chain, root identity, Session ID, generation, operation mapping, and no-follow paths, classify the observed state conservatively:

| Last durable journal state | Filesystem observation | Recovery action |
| --- | --- | --- |
| live (or validated legacy Session during offline bootstrap) | Exactly one valid live artifact at recorded generation; no quarantine destination | Keep live; bootstrap may explicitly record initial state |
| retiring intent | Live source exists; quarantine destination absent | Revalidate source identity/revision; retry the same recorded rename or record a proven pre-effect abort |
| retiring intent | Source absent; exact quarantine destination exists | Verify destination identity/generation and parent durability; record completion for the original operation |
| retired | Exact quarantine generation exists; live path absent | Keep retired; preserve token/mapping; do not repeat rename |
| retired | Live path exists or both locations exist | Mark this Session recovery-required; never overwrite, delete, or choose heuristically |
| restoring intent | Quarantine source exists; live destination absent | Revalidate token/generation; retry same no-replace promotion or prove abort |
| restoring intent | Exact live destination exists; quarantine source absent | Verify generation and parent durability; record completion for original restore |
| restored/live | Exact live generation exists; quarantine path absent | Keep live; old token remains terminal for its generation |
| purging intent | Quarantine root exists, possibly partially deleted | Resume bounded no-follow deletion under same lock and durable purge authorization |
| purging intent | Quarantine root absent | Verify parent durability and anti-resurrection fence; record purge completion |
| purged | Artifacts absent; durable terminal fence and operation mapping exist | Keep purged; never recreate via legacy fallback, index, or stale caller input |
| any state | Unexpected path, identity mismatch, symlink, duplicate generation, corruption, missing token/mapping, or unknown combination | Mark this Session unavailable/recovery-required; preserve evidence |

Retrying a recorded rename uses the durable operation ID, generation, source identity, and destination from the intent; it does not recompute a destination from mutable configuration. If preconditions cannot be proven, stop and preserve journal and artifacts. Path existence alone is not proof of durability: POSIX requires syncing both affected parent directories; Windows requires tested write-through/no-replace semantics.

### Recovery records and operation semantics

- Recovery records reference the original operation ID, kind, generation, fingerprint, and prior digest. They do not create a second user-visible operation.
- Recovery retries return the original operation result/token. They never mint a replacement retirement token because a response was lost.
- An ambiguous external effect remains outcome_unknown until reconciliation proves committed or safely not committed.
- A pre-effect abort is recorded only when it is provable no external effect occurred. Otherwise preserve the intent; never report cancelled_before_commit.
- Purge is monotonic: after anti-resurrection fence and purge intent are durable, no restore or write may reopen that generation, even during partial deletion.
- Preserve operation mappings, exact tokens, generation history, and terminal fences; routine startup does not compact or prune them.

### Readiness: provider-wide versus per-Session

- **Provider-wide ready:** root identity, metadata namespace, stable-lock protocol, journal format, and required global metadata are valid. Unrelated healthy Sessions may be served.
- **Session ready:** that Session's journal and artifact state have been validated/reconciled under its stable lock.
- **Session recovery-required:** only that ID rejects operations as appropriate; unrelated validated IDs remain available.
- **Provider recovery-required:** root identity, namespace, lock implementation, or global metadata is ambiguous/corrupt; all operations requiring lifecycle authority fail closed.

If no operation can be safely admitted until initial inventory completes, retain a provider-wide startup barrier until bounded bootstrap finishes. After bootstrap, later per-Session corruption is isolated. A listing may return validated entries with an explicit partial/degraded indication, or fail as a whole if the API cannot represent partial results. It must never silently omit corrupt IDs and claim completeness. Every operation revalidates its target under that Session's lock.

### Index rebuild and snapshot consistency

- The global index is a cache of validated per-Session state. Rebuild from bounded journal snapshots; validate each under its Session lock.
- Since Sessions can change during a multi-ID scan, each entry carries a journal sequence/generation watermark and rebuild epoch. This is eventually consistent discovery data, not a global transactional snapshot.
- Before acting on an index entry, reacquire the Session lock and validate journal sequence, generation, and artifact identity. A stale index may cause a missed/extra candidate, never an unsafe mutation.
- Publish rebuilt indexes atomically via temp-write, file sync, atomic publish, and directory sync. On failure, retain the old index marked stale.
- A globally consistent listing requires a separate snapshot protocol; independent per-Session locks do not create an atomic provider-wide view.

### Failure classification, observability, and operator repair

- Distinguish lock contention, transient I/O, capacity/backpressure, scoped Session corruption, and provider-wide identity/namespace failure. Retry only transient classes.
- Emit bounded structured diagnostics with opaque Session reference, operation ID, journal sequence, state, phase, and stable error code. Never log tokens, event payloads, prompts, frame bytes, or arbitrary caller metadata.
- Rate-limit repeated errors; retain first causal error and bounded attempt counters.
- Expose aggregate counts for queued, active, deferred/locked, recovered, degraded, and failed Sessions, plus queue age and worker saturation. Metrics must not leak tokens or content.
- Operator repair is explicit and offline: preserve byte-for-byte journal/artifact evidence, verify root identity, inspect exact mismatch, and apply a narrowly scoped repair record or restore a complete consistent backup. Never edit a journal in place or delete evidence to make startup pass.
- Repair documentation must state whether operation idempotency and token recoverability are preserved. If not provable, require an explicit data-loss/restore decision.

### Recovery conformance and fault-injection matrix

- Two or more processes start simultaneously and discover one pending intent; exactly one holds the Session lock, others defer, and no duplicate external effect or terminal record occurs.
- Kill the lock holder before/after every journal append, file sync, directory sync, rename, promotion, partial unlink, and terminal record; a new process converges deterministically.
- Crash after external rename but before terminal record; recovery recognizes exact destination and records completion without repeating the move.
- Crash during purge after each deleted entry; recovery resumes only inside recorded quarantine root and preserves the fence.
- Hold Session A's lock while recovering Session B; B progresses without global head-of-line blocking.
- Corrupt Session A while B is healthy; A becomes scoped recovery-required while B remains usable after its own admission checks.
- Corrupt root identity/lock namespace; all lifecycle operations fail closed and no worker mutates any Session.
- Test stale/missing index, concurrent rebuild, concurrent Session creation, listing during transitions, bounded consistency, and no index-authorized mutation.
- Exhaust worker, descriptor, queue, disk, and journal-size limits; verify backpressure and maintenance-required outcomes.
- Test fairness, transient retry limits, shutdown cancellation, process death, and repeated recovery; no permanent recovery flag may strand a Session.
- Verify logs/metrics contain no token or user payload and operator repair preserves original evidence.

### Implementation gate

The pinned upstream JSONL provider does not implement this recovery protocol. This is a proposed conformance contract, not runtime support. Lifecycle capability remains unsupported until stable locking, authoritative journals, deterministic reconciliation, scoped readiness, bounded scheduling, and the crash/fault-injection matrix ship together.


## Session ID reuse, incarnation identity, and stale-operation fencing

A public Session ID is a reusable lookup key, not a durable identity for one lifetime of stored data. The lifecycle protocol must distinguish the caller-visible ID from the immutable incarnation of the Session currently or historically associated with that ID. Otherwise a delayed retry, stale retirement token, queued writer callback, old index entry, or recovery task can accidentally act on a newer Session that happens to reuse the same ID.

### Identity model

Use the following identity tuple throughout the provider's durable metadata and internal operation checks:

- `providerRootId`: durable identity of the storage root.
- `sessionId`: caller-visible identifier, canonicalized once and validated on every boundary.
- `incarnationId`: immutable, provider-generated, collision-resistant identifier for one creation lifetime of that Session ID. Generate at least 128 bits from a cryptographically secure source, persist it before publishing artifacts, and reject any collision with retained or active incarnation records. It is not derived from the Session ID, path, timestamp, or process ID.
- `generation`: monotonically increasing integer within one incarnation, advanced at each lifecycle transition that changes the authoritative artifact/state epoch. It never wraps or resets within the incarnation.
- `revision`: monotonic state/journal revision used for optimistic concurrency; it is distinct from the incarnation and generation and must not be treated as either.

The immutable artifact identity is the tuple `(providerRootId, sessionId, incarnationId, generation)`, plus provider-validated object identity where the filesystem supports it. Paths and listing entries are locators, not identity.

An incarnation remains the same across retire and restore. A restore advances the generation; it does not create a new incarnation. A successful purge permanently terminates that incarnation. Re-creating the same public Session ID, if the API permits reuse, creates a new incarnation with a fresh identity and a new generation sequence. No generation value or incarnation ID is recycled.

### Creation and ID-reuse rules

1. Under the stable per-Session lock, resolve the current authoritative identity before creating anything. A live or retiring incarnation blocks a second creation. A retired incarnation may be restored only with its matching token; ordinary create must not overwrite it.
2. Allocate and durably publish the new incarnation record before making the first Session artifact visible. The record binds root ID, canonical Session ID, incarnation ID, initial generation, creation operation ID/fingerprint, and provider format version.
3. Publish the artifact using a no-replace operation and validate its resulting object identity. A path collision, stale directory, existing artifact, or retained nonterminal incarnation is a conflict, not permission to adopt the existing bytes.
4. A public Session ID may be reused only after the prior incarnation has a durable terminal `purged` fence, its purge operation mapping is durable, and no in-flight operation/handle can still mutate or reopen that incarnation. If the implementation cannot prove these conditions, ID reuse remains disabled.
5. New-incarnation publication must be atomic with respect to lookup: readers and writers see either the prior terminal incarnation or the fully initialized new incarnation, never an uninitialized gap interpreted as an ordinary empty Session.
6. During offline migration, legacy Sessions receive an incarnation only after their artifact identity and ID/path mapping are validated under the maintenance barrier. Ambiguous or duplicate legacy artifacts block that ID; migration must not infer that two directories are one incarnation or silently pick one.

If the product contract requires Session IDs to be globally unique forever, enforce that policy instead and retain a permanent ID tombstone. The protocol must choose one explicit policy; it must not accidentally permit reuse because a directory disappeared.

### Exact generation advancement rules

To keep artifact identity separate from state-transition sequencing, use these rules consistently:

| Event | Incarnation | Artifact generation | Journal revision |
| --- | --- | --- | --- |
| First successful create | Allocate new ID | Start at 1 | Advance on each durable record |
| Append/flush within the same live Session | Unchanged | Unchanged | Advance only if lifecycle journal state changes; ordinary event-log sequencing remains provider-owned |
| Retire intent and retire commit | Unchanged | Retired token binds current generation G | Advance for each durable lifecycle record |
| Restore intent and restore commit | Unchanged | Publish restored live state as generation G+1 | Advance for each durable lifecycle record |
| Retire again after restore | Unchanged | New retirement token binds G+1 | Advance for each durable lifecycle record |
| Purge | Unchanged, then terminal | Purge exactly the token's retired generation; no next generation is created | Advance through intent and terminal fence |
| Re-create the same public Session ID after terminal purge | Allocate a fresh ID | Start at 1 within the new incarnation | Start a new journal sequence namespace bound to the new incarnation |

Generation is therefore an artifact/lifecycle epoch, not a counter incremented for every intent/terminal record. Journal `sequence` and lifecycle `revision` provide ordering and optimistic concurrency within an incarnation. They must never be substituted for the artifact generation. If an implementation needs to distinguish multiple filesystem publications within one generation, add an explicit publication ID rather than overloading generation.

A restore creates a new generation even when the restored bytes are identical to the retired bytes. This makes a pre-restore token, handle, index entry, or delayed callback stale by construction. Purge terminally closes the exact retired generation and incarnation; it does not increment generation to imply a new live artifact.

### Token, operation, and journal binding

- Every retirement token is bound to `(providerRootId, sessionId, incarnationId, retiredGeneration)` and to the exact retirement operation mapping. The token is opaque and unguessable; the binding is validated from protected provider metadata, not decoded from caller-controlled token fields.
- Operation idempotency keys are scoped by `(providerRootId, sessionId, incarnationId, operationId)`. The request fingerprint includes operation kind, expected generation/revision, and all semantic options. Reusing an operation ID with a different kind or fingerprint returns `operation_id_conflict`.
- A retry for an old incarnation resolves its original operation mapping and returns the original result; it must never fall through to the current incarnation merely because the public Session ID now resolves to a newer one.
- A restore token can restore only the exact retired generation it names, and only while that incarnation remains in the matching retired state. After restore commits, the token is terminal; it cannot retire, restore, or purge the new live generation.
- Purge authorization is bound to the same incarnation and retired generation. The durable anti-resurrection fence is keyed by the full identity tuple, not by Session ID alone.
- Journal records, snapshots, global-index entries, quarantine manifests, backup metadata, and diagnostics carry incarnation ID and generation. An index keyed only by Session ID is a discovery projection and cannot disambiguate historical incarnations or authorize a destructive action.
- Keep historical operation mappings and terminal fences long enough to cover every supported retry, backup-restore, and disaster-recovery horizon. If compaction is introduced, preserve the full identity binding and old-token terminal outcomes.

### Stale handles, callbacks, and asynchronous work

Every handle and deferred mutation carries the immutable incarnation ID and generation captured at admission. The provider validates that identity before every mutation that can affect authoritative storage:

- A writer handle is admitted under the stable lock for the current live incarnation/generation. The lock is retained for the handle lifetime; queued append/flush callbacks cannot outlive that ownership.
- A mutation callback must verify that its handle identity still matches the authoritative live identity before appending. It cannot re-resolve by Session ID and silently attach to a newer incarnation.
- A read handle may finish using already-open descriptors admitted before retirement, subject to the documented pinned-read contract. It may not reopen a pathname or lazily fetch another generation after its incarnation/generation has been retired or purged.
- Background recovery, delayed cleanup, index rebuild, retries, and scheduled purge carry the full identity tuple. On lock acquisition they revalidate it against the authoritative journal before acting.
- A process restart invalidates process-local handles and callbacks. Reopened work must reconstruct authority from durable operation mapping and current incarnation, never from a serialized stale handle object.
- If a public API accepts only Session ID for a new operation, it resolves the current incarnation under the stable lock and binds the operation before releasing the lock. Token-based operations resolve the token's historical incarnation directly and never use current-ID lookup as a fallback.

This prevents the classic ABA race: ID `S` refers to incarnation A, A is purged, ID `S` is recreated as incarnation B, and a delayed purge/restore/write for A arrives. The old operation is terminal or resolves only against A's retained mapping; it cannot target B.

### Quarantine and filesystem namespace

Do not key quarantine or temporary paths solely by encoded Session ID. Use an unambiguous provider-owned namespace that includes incarnation and generation, for example:

`.lifecycle-quarantine/<shard>/<encoded-session-id>/<incarnation-id>/<generation>/`

The exact encoding must be canonical, bounded, and collision-free. The destination is persisted in the durable intent before filesystem mutation; recovery uses that exact recorded destination rather than recomputing from mutable configuration.

- No-replace rename/promotion is required. Existing destination content is never overwritten or merged.
- Before any rename, verify source object identity and expected incarnation/generation from the manifest and journal.
- Purge traversal is rooted in the recorded incarnation/generation directory, uses no-follow operations, and checks that each child remains beneath the opened root. A symlink or substituted mount/path is a scoped recovery error.
- After purge, retain the anti-resurrection fence and operation mappings even when all artifact/quarantine bytes are gone. A new incarnation receives a distinct namespace and cannot satisfy an old fence's identity.
- Never use "directory absent" as proof that a public Session ID is unused; consult the authoritative incarnation registry/journal under lock.

### Backup, restore, and disaster recovery

A consistent backup must capture the incarnation registry, per-Session journals, operation mappings/tokens, terminal fences, artifacts, quarantine data, and root identity from one provider-consistent point. Restoring only artifacts can resurrect a purged incarnation; restoring only fences can make valid data unreachable; restoring an older registry can make an ID appear reusable. Partial combinations fail closed.

If a backup is restored to a different physical root, the restore workflow must explicitly rebind or preserve root identity under a separately reviewed disaster-recovery procedure. Copying metadata and artifacts independently must not silently authorize operations under a different root.

A disaster restore may roll the durable state backward to its backup point; therefore the recovery contract must explicitly define the accepted RPO and how clients invalidate operation IDs/tokens created after that point. Never claim that a backup restore preserves post-backup idempotency or fences unless the backup protocol proves it.

### Conformance tests

- Retire A, purge A, recreate the same Session ID as B; replay A's retire/restore/purge operation IDs and tokens and prove none can read, mutate, or delete B.
- Hold a stale writer callback/read handle for A across purge and ID reuse; verify it cannot reopen or append to B.
- Race create/create, create/retire, create/purge, restore/recreate, and ID reuse across multiple processes; all decisions serialize on the stable Session lock and durable incarnation registry.
- Inject crashes before/after incarnation allocation, registry publication, artifact no-replace publication, retire intent, rename, terminal fence, and new-incarnation publication.
- Corrupt or duplicate incarnation records, reuse an incarnation ID, mismatch path/manifest/journal identity, or present a stale index entry; fail closed for the affected ID.
- Verify generation monotonicity, no wrap/reset, revision independence, token binding, operation fingerprint binding, and historical retry behavior across multiple retire/restore generations.
- Verify quarantine path uniqueness and no-replace semantics under adversarial pre-creation, symlink substitution, path swap, and partial purge.
- Restore backups with each component missing or from a different point in time; ensure partial restore never makes an old ID appear safely reusable.
- Confirm logs and metrics never expose opaque token material or user event content.

### Implementation gate

The pinned upstream Harness persistence APIs are keyed primarily by public Session ID and do not currently provide durable incarnation identity, generation-scoped lifecycle tokens, or stale-handle fencing. This section is a proposed storage protocol, not implemented upstream behavior. Do not enable lifecycle capability or Session ID reuse until the provider implements the complete identity binding and conformance suite. If that implementation is deferred, the safe initial policy is to prohibit ID reuse after purge and retain a permanent ID tombstone.


## Unified operation ordering across create, open, read, write, and lifecycle transitions

The lifecycle contract is incomplete unless ordinary persistence operations participate in the same admission protocol. A lock around only `retire`, `restore`, and `purge` leaves races with delayed create materialization, lazy reads, queued appends, and handles that outlive the call which created them. This section defines the provider-neutral ordering contract while allowing JSONL and SQLite to retain different storage implementations.

### Coordination primitives and lock order

For each canonical `(providerRootId, sessionId)`, the provider needs two logically distinct coordination roles:

1. **Stable admission gate:** a non-movable per-Session gate in the provider-owned namespace. It serializes short admission decisions and lifecycle state publication. It is never stored inside an artifact directory that may be renamed or deleted.
2. **Writer ownership lease:** the provider's existing cross-process writer exclusion, or its v2 stable equivalent, retained from successful write-handle admission until all queued writes have drained and close has completed. It prevents two writers from committing concurrently and lets lifecycle wait for admitted writers to finish.

Do not assume these roles are interchangeable. In particular, do not make every read hold an exclusive writer lease for the full read-handle lifetime merely to reuse an existing lock. That would silently change provider concurrency semantics and can cause starvation. If the platform cannot implement a required shared/exclusive primitive consistently, use an explicit provider-owned gate protocol and test its cross-process behavior rather than pretending a Windows semaphore is a reader/writer lock.

The normative acquisition order is:

1. stable admission gate;
2. writer ownership lease, only for a write admission or lifecycle drain;
3. provider storage transaction / file operation;
4. durable lifecycle journal append when the operation changes lifecycle state.

No code path may acquire the admission gate while already holding the writer lease. No path may nest two Session gates. Release in reverse order. A lifecycle operation may hold the gate while waiting for the writer lease so that new writers cannot continually enter ahead of it; it must use a bounded wait/cancellation policy and return `busy` or `cancelled_before_commit` without publishing a false terminal result. The exact gate primitive must guarantee process-death release.

A provider may internally combine the gate and writer lease only if it proves the same admission, drain, fairness, and crash semantics on every supported platform. The abstract roles remain distinct even when an implementation shares a kernel object.

### Admission and linearization rules

All operations resolve the authoritative incarnation and generation while holding the admission gate. They must not check state, release the gate, and later reopen by Session ID without revalidation.

| Operation | Admission protocol | Linearization / visibility rule |
| --- | --- | --- |
| `create(id)` | Gate; verify no live/nonterminal incarnation; durably reserve identity and creation operation; publish artifact with no-replace semantics; record ready state | The new Session becomes discoverable only after identity and artifact publication are durable |
| `open(id, 'write')` | Gate; resolve live incarnation/generation; acquire writer lease; revalidate state and identity; expose handle; release gate while retaining writer lease | Successful admission occurs only after the handle is bound to the captured identity and writer ownership is held |
| `open(id, 'read')` | Gate; resolve live identity; open the required file descriptor or materialize a consistent DB read snapshot; bind the read handle to incarnation/generation; release gate | Read admission is the successful descriptor/snapshot acquisition, not a prior metadata lookup |
| `append/flush` | Require the admitted writer lease; serialize queued writes; verify captured identity; persist provider data using provider-native commit rules | Each acknowledged flush follows the provider's durable append/commit guarantee |
| `close(writeHandle)` | Stop accepting new writes; drain queued writes; flush or report failure; release writer lease only after drain is complete | Close completion means no callback from that handle can later commit |
| `retire(id)` | Gate; resolve exact live identity; acquire/drain writer lease; revalidate revision; durably publish `retiring`; perform provider-owned quarantine; durably publish `retired`; release locks | `retired` is committed only after both the data transition and terminal lifecycle record meet the provider's durability contract |
| `restore(token)` | Gate; resolve token's historical incarnation/generation; validate terminal token state and destination; publish `restoring`; restore with no-replace; publish new live generation; release locks | New generation is visible only after artifact promotion and durable live-state publication |
| `purge(token)` | Gate; resolve exact retired identity; publish `purging` and anti-resurrection fence; delete only that generation; sync required parents; publish terminal fence/result; release locks | Purge is committed only after the generation is absent and its durable terminal fence prevents resurrection |

A failed or ambiguous storage step is not converted to success because a later pathname lookup happens to find no artifact. Use the previously defined typed outcomes and recovery journal. In particular, cancellation after a durable intent is a recovery request, not proof that the operation was cancelled before commit.

### Read handles and snapshot lifetime

A read handle is bound to the immutable incarnation/generation admitted at open. The provider must choose and document one of these models:

- **Pinned descriptor/snapshot:** open all required resources, or establish a storage snapshot that pins the generation, while holding the admission gate. Reads may finish after retirement commits using only those pinned resources. They may not lazily reopen a pathname or switch to a newer generation.
- **Re-admitted incremental reads:** each later read call reacquires the admission gate, verifies the same incarnation/generation is still readable, and obtains its own consistent descriptor/DB snapshot before releasing the gate. After the retirement barrier, a new read call fails with a typed state outcome.

Do not mix the models implicitly. A handle that pins only a header but later resolves event files by Session ID is not a pinned read. A read that materializes bytes before retirement and decodes them asynchronously may finish after retirement; the contract must say that the bytes were admitted before the barrier. Purge may reclaim provider storage only when the chosen provider model proves no later read will need to reopen it. If open descriptors remain valid across rename/unlink on a platform, that fact alone does not justify deleting other lazily accessed files.

For SQLite, the read admission point must include the transaction/snapshot that selects trace metadata and the relevant frame bytes. If the provider returns a fully materialized byte buffer from a short transaction, later decode can finish after the transaction; if it streams multiple frame queries, each query must stay inside the same snapshot or be re-admitted and generation-checked. A handle must not combine pre-retire metadata with post-restore frames from a different generation.

### Writer handles, delayed create, and close semantics

- A write handle owns the writer lease for its entire lifetime, not merely during individual append calls. The lease is acquired before the handle is returned and released only after close has rejected new writes, drained queued appends, completed the final flush, and settled all callbacks.
- A pending create is an admitted operation even before its artifact is materialized. Its reservation/operation ID is durable and visible to lifecycle arbitration. Retire cannot conclude that the Session is absent and purge/reuse its ID while a create for that identity is pending.
- A create retry uses the same durable creation operation ID and request fingerprint. It resumes or returns the original result; it does not adopt an unrelated directory/trace that appeared at the same public ID.
- A failed flush keeps the handle from reporting a successful close. If persistence outcome is ambiguous, the provider reports an unknown outcome and requires same-operation recovery; it must not release lifecycle authority as though the append were definitely absent.
- Once close resolves, no timer, promise continuation, event listener, or callback owned by that handle may append. Implementations should make close idempotent and test double-close and append-vs-close races.

### Provider-specific realization

**JSONL Provider**

- Keep the stable admission namespace outside movable Session artifact directories. The legacy in-directory `session.lock` remains a writer-ownership object only during a controlled v1 period; it is not a safe substitute for the v2 gate and must never be moved as a migration bridge.
- A v2 writer admission acquires the stable gate, validates the lifecycle journal and current incarnation/generation, then obtains the stable writer lease before returning the handle. The lease remains held through final flush and close.
- A read admission opens the exact immutable generation file(s) while holding the gate and captures their identity. If reads need multiple files or lazy generation-log access, pin them all or use re-admitted incremental reads; do not later resolve the current Session directory by ID.
- Lifecycle holds the gate before draining writer ownership, preventing new create/write admissions. It records intent before rename and uses the already-defined same-volume/no-replace rename and directory-sync protocol.
- Do not claim compatibility with a running v1 process: v1 readers and writers do not participate in the v2 admission gate. The offline migration barrier remains mandatory.

**SQLite Provider**

- The stable gate coordinates lifecycle admission with create/open/read selection; the existing DB-scoped per-Session writer lease continues to serialize write handles unless and until the provider replaces it with a proven equivalent.
- A write handle obtains the gate, validates the live incarnation/generation and pending-create state, acquires the DB-scoped writer lease, then releases the gate while retaining the lease through close.
- **The complete SQLite writer/import lock order is:** provider-root lifecycle/admission gate; DB-scoped per-Session lease under the database's `.session-locks` namespace; legacy-artifact lease or root creation/artifact guard; then the SQLite transaction (`BEGIN IMMEDIATE` where required). The pinned upstream provider acquires its DB-scoped lease before its legacy-artifact/creation lease, but its current release implementation starts both release operations concurrently with `Promise.allSettled`; it does not guarantee reverse-order release. The lifecycle contract requires reverse-order release (artifact/creation lease before DB-scoped lease), so this is an explicit implementation gap for a future provider change. The lifecycle gate must be acquired before either lease. No path may acquire the DB-scoped lease while holding the artifact/creation lease, or acquire the lifecycle gate while holding either lower-ranked lease.
- Read admission establishes a SQLite snapshot containing lifecycle state, trace identity, and frame selection. All bytes for one logical read must come from that snapshot; do not check lifecycle in one transaction and fetch frames in another unrelated snapshot.
- Retire obtains the gate before waiting for the DB-scoped writer lease, then follows the same lease order (including the artifact/creation guard needed to fence legacy import/fallback) before its SQLite transaction. It never moves the shared DB or relies on filesystem markers as the authoritative state.
- Legacy JSONL import/fallback must acquire the same gate and follow this exact order. An import that began before retirement cannot publish a trace after the retirement fence; a post-fence open cannot fall through to legacy files.

### Cross-provider conformance and race tests

Run deterministic barrier-controlled tests across multiple processes, not only in-process mocks:

1. create reservation vs retire, including crash before artifact materialization and retry after restart;
2. write-open vs retire at every point before/after writer lease acquisition and handle return;
3. append vs close, flush vs close, double close, and a callback deliberately released after close;
4. read-open vs retire, including descriptor acquisition immediately before and after the retirement barrier;
5. pinned read finishing after retire, and incremental read rejected after retire;
6. purge vs a read handle that would otherwise lazily open a second generation file;
7. restore vs old read/write handle and vs a new open by the same public Session ID;
8. SQLite read metadata/frame snapshot vs retire/restore commit, proving no cross-generation mixture;
9. SQLite legacy import vs retire, proving no post-fence import or fallback resurrection;
10. two processes racing writer admission, lifecycle drain, and cancellation; assert the documented fairness/busy behavior;
11. process kill while a writer lease is held, proving kernel release and durable append recovery;
12. process kill during close after flush but before response, proving retry/inspect returns the original append/close outcome;
13. verify no lock-order inversion by stress-testing all operation pairs with watchdog timeouts on Linux, macOS, and Windows;
14. verify all returned handles and diagnostics remain bound to the admitted incarnation/generation and never silently re-resolve by Session ID.

### Implementation gate

The pinned upstream JSONL and SQLite providers do not yet expose this complete lifecycle admission contract. Existing writer locks are not by themselves a lifecycle fence, and current read paths do not uniformly pin a generation through handle lifetime. This section is a proposed cross-provider contract, not implemented behavior. Keep destructive lifecycle capability unsupported until both providers pass the same semantic conformance suite with provider-specific storage adapters. The initial rollout must remain offline/no-mixed-version and must not weaken existing read/write compatibility to simulate support.
