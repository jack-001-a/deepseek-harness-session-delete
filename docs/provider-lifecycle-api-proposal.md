# Proposed upstream API: provider-owned Session lifecycle capability

- Status: proposal for upstream contract review; not an implementation claim
- Parent: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- Companion: [Provider lifecycle conformance specification](./provider-lifecycle-conformance-spec.md)
- Reviewed upstream baseline: `deepseek-ai/deepseek-harness` master at `2e39e70496aa02986ca6a820c5d497e816b69d7e`

## 1. Current seam and compatibility constraint

The reviewed `SessionPersistence` service exposes `create`, `open`, `flush`, `stat`, and `list`. It also exposes a process-local `identity: symbol`, stable through Context proxies and distinct after service replacement. It does not expose provider-owned retirement, restoration, or purge.

The lifecycle API must be additive:

- Existing third-party subclasses remain valid without implementing lifecycle methods.
- Existing `SessionHandle` and append-only event semantics remain unchanged.
- No lifecycle behavior is inferred from package version, `snapshot.location`, filesystem layout, SQLite schema, or the presence/absence of an artifact.
- A provider that does not advertise the capability remains fully usable for ordinary persistence, but destructive lifecycle actions are unavailable.

The existing snapshot `location` is observational metadata for diagnostics/export. It is not a mutation capability, a stable identity, or authorization to manipulate provider storage.

## 2. Recommended capability-discovery shape

Prefer one optional capability on the active service instance over package-version checks or a global provider registry:

```ts
export abstract class SessionPersistence extends Service {
  readonly identity: symbol = Symbol('sessionPersistence')

  /** Absent unless this active provider implements the complete lifecycle contract. */
  get lifecycle(): SessionLifecycleCapability | undefined {
    return undefined
  }

  // Existing methods remain unchanged.
}
```

A provider overrides the getter only after its durable lifecycle state has been opened and recovery has reached a safe, ready state. Before the service has completed startup, the getter returns `undefined`; after startup, its result is stable for that service instance. Before exposing the capability, each provider process must acquire the shared cross-process root-epoch lease and validate the atomic recovery metadata envelope; it holds that lease until shutdown drains all handles and operations. Disaster-recovery cutover requires the exclusive form of the same gate, so it cannot overlap a live old-epoch provider process. If recovery fails or detects ambiguous/corrupt state, lifecycle remains unavailable (ordinary non-destructive persistence may remain usable only if the provider can prove it is safe). A replacement service has a new `identity` and a newly discovered capability.

`recoveryEpoch` is an opaque durable namespace discriminator, not a process-local service version. `inspect`, `inspectOperation`, and token-based mutations are scoped to the capability's current epoch; a prior-epoch token or operation ID must be rejected as foreign/stale rather than resolved against a restored ledger. Historical records may remain for audit but cannot authorize current mutations.

Consumers capture both the active service reference and its `identity` before beginning a workflow. Before a later phase or retry, they verify that the currently resolved service still has the same identity. A replaced service invalidates the old capability reference; the consumer must rediscover capability and reconcile by operation ID rather than continuing through a stale provider object.

This shape is a recommendation for review, not a claim about an accepted upstream signature. An equivalent typed optional capability is acceptable if it preserves the same instance-binding and compatibility properties.

## 3. Minimal semantic surface

The capability should expose only provider-owned lifecycle operations and observations. It must not expose storage paths, lock objects, database handles, Segment IDs, or provider-private journal records.

```ts
export interface SessionLifecycleCapability {
  /** Opaque durable identity of the provider storage root; stable across recovery. */
  readonly providerRootId: string
  /**
   * Opaque durable recovery epoch for this provider root.
   * Stable across ordinary process/service restarts; rotated by an approved
   * disaster-recovery rollback before lifecycle readiness is exposed.
   * Distinct from providerRootId and SessionPersistence.identity (process-local).
   */
  readonly recoveryEpoch: string
  retire(
    id: SessionId,
    options: {
      operationId: string
      expectedRevision?: SessionPersistenceRevision
      signal?: AbortSignal
    },
  ): Promise<SessionRetirement>

  restore(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement>

  purge(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement>

  inspect(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>

  inspectById(
    id: SessionId,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>

  inspectOperation(
    id: SessionId,
    operationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>
}

declare const sessionRetirementTokenBrand: unique symbol
export type SessionRetirementToken = string & {
  readonly [sessionRetirementTokenBrand]: true
}

export type SessionRetirementState =
  | 'retired'
  | 'restored'
  | 'purged'

export interface SessionRetirement {
  readonly id: SessionId
  readonly token: SessionRetirementToken
  readonly state: SessionRetirementState
  /** Opaque provider revision for this lifecycle record. */
  readonly revision: string
}
```

The exact branding and exported type names are open to upstream review. The semantic requirements below are normative for any accepted shape.

### Why each operation exists

- `retire` establishes the provider-owned fence and returns the opaque restore/purge token.
- `restore` makes the retired generation live again without requiring a live artifact to exist first.
- `purge` permanently removes the retired logical generation according to the provider's documented retention and erasure guarantees.
- `inspect` resolves a lost response when the caller retained the token.
- `inspectById` observes the current lifecycle record for a Session.
- `inspectOperation` recovers the exact provider commit when the caller crashed after provider commit but before persisting the returned token; this avoids ambiguity when the same public Session ID is retired again after a restore.

A separate public `recover()` is not required in the minimal surface. Provider startup must complete or safely refuse its own durable recovery before exposing the capability. Consumers must not be asked to implement provider recovery.

## 4. Idempotency and lost-response contract

`retire` requires a caller-generated `operationId`, unique within the provider-root namespace. The caller persists it before invoking `retire` and reuses the exact same value after timeout, process death, transport failure, or unknown response. Its provider deduplication record (or a compact, equally authoritative tombstone) must outlive every possible caller retry; silently expiring the key and later treating it as new is forbidden. `restore` and `purge` are keyed by the opaque retirement token and do not require a second operation ID: the token identifies the exact retired generation and makes retries idempotent. A provider may add optional operation IDs to those methods for audit/deduplication, but that is an additive extension, not a requirement of this minimal API. Any optional key must be durably bound to the token, operation kind, and request fingerprint. Storage compaction may discard bulky result payloads only if it preserves enough durable identity and outcome information to resolve retries and reject conflicting reuse.

For each operation that supplies an `operationId` (mandatory for `retire`, optional for `restore`/`purge` extensions), the provider stores a durable mapping with the lifecycle transition:

1. Same operation ID + same operation kind + same canonical request fingerprint returns the original committed result.
2. Same operation ID with a different kind, Session identity, token, or expected revision returns a typed operation-ID conflict and performs no mutation.
3. A committed `retire` whose response was lost is recoverable by retrying the same operation ID or calling `inspectOperation(id, operationId)`. `restore` and `purge` retries use the original retirement token. `inspectById(id)` may report the current state, but MUST NOT be used to reconstruct the exact result of a historical retirement.
4. A timeout or cancellation after the commit boundary is not evidence of rollback. The result is recoverable or explicitly `outcome_unknown`.
5. Reusing a retirement token cannot restore or purge a different Session incarnation.

The fingerprint is provider-defined but must bind at least the operation kind and target identity. It must not include transient values such as an AbortSignal or wall-clock timestamp.

Tokens are opaque bearer capabilities. They must be unguessable, scoped to one provider root and one Session incarnation, and protected at rest according to the provider's threat model. They must never contain a path or expose lock/database internals.

## 5. Linearization and admission rules

The API is unsafe unless all of the following are defined and tested:

### 5.1 Create and write admission

- `create(id)` and `open(id, 'write')` participate in the same provider-owned admission protocol as `retire`.
- A pending create is fenced even before its artifact is materialized.
- Once retirement linearizes, no new writer or creator may publish the retired incarnation.
- An already admitted writer either drains and closes before retirement commits, or retirement returns a documented typed busy/cancelled result. It must never delete while an admitted writer can still commit.

### 5.2 Read admission

- A read admitted before the retirement fence may finish under a provider-defined pinned-read rule.
- Every later read admission, including a later chunk requested through an already-open lazy read handle, observes the retired state and is rejected with a typed state result.
- Retirement must not silently switch an existing handle to a different incarnation.
- The provider must state whether the fence waits for in-flight read calls or for longer-lived read pins. The choice must be identical in externally observable behavior across providers.

### 5.3 Restore and purge

- Restore reserves the same logical Session ID for the retired incarnation before publishing it live.
- Restore cannot overwrite an unrelated destination or adopt a colliding incarnation.
- Purge fences all new admissions before reclaiming data.
- After purge linearizes, old handles, callbacks, tokens, and delayed cleanup work cannot affect a later recreation with the same public Session ID.
- A new Session created with the same public ID receives a distinct incarnation; old-generation work must fail closed.

### 5.4 Revision checks

`expectedRevision` is compared by the provider at the same atomic boundary that admits retirement. A mismatch returns a typed revision conflict and performs no mutation. The provider must not treat the existing snapshot revision as a cross-provider or cross-instance globally ordered sequence; it is currently documented as opaque and service-instance-scoped.

## 6. Typed outcomes

The provider must preserve distinctions between at least:

- unsupported capability (capability absent; no destructive fallback);
- not found;
- writer contention / busy;
- cancellation proven to occur before commit;
- revision conflict;
- operation-ID conflict;
- already retired, restored, or purged;
- storage I/O failure before commit;
- corruption or provider-root identity mismatch;
- outcome unknown after an ambiguous commit boundary.

A generic rejected Promise is insufficient where it prevents the caller from deciding whether to retry, inspect, or stop. In particular, an ambiguous commit must never be translated to not-found, success, or a generic retry-safe error.

## 7. Provider-specific invariants

### JSONL

- The cross-process coordination object must remain stable while the lifecycle transition runs. The lifecycle operation must not move, unlink, replace, or copy the lock identity.
- Quarantine and restore operate on provider-owned generations while preserving the stable coordination namespace.
- Directory-entry durability, no-replace promotion, symlink/path substitution defenses, and interrupted journal recovery are provider responsibilities.
- A missing live artifact is not proof of retirement.

### SQLite

- Lifecycle transitions use transactions over provider-owned metadata; they never move, truncate, or delete the shared database to remove one Session.
- Retirement records preserve the logical root needed for restore.
- Purge uses reachability-aware Segment garbage collection. Shared ancestors remain while referenced by any live or restorable retired Session.
- Routing markers, legacy JSONL import/fallback, and tombstones participate in one identity protocol so retired IDs cannot reappear.
- The lock order is lifecycle/admission gate -> DB-scoped per-Session lease -> legacy-artifact lease or root creation/artifact guard -> SQLite transaction. The pinned upstream SQLite provider acquires the DB-scoped lease before the artifact/creation lease, but currently starts both release operations concurrently via `Promise.allSettled`; it does not guarantee reverse-order release. The lifecycle contract requires releasing the artifact/creation lease before the DB-scoped lease. No code path may reverse acquisition order or acquire the gate while holding either lease; release both leases on every failure path.
- The pinned SQLite handle also does not yet provide an atomic close-admission boundary for routed live events: `receive()` can still enqueue while `closing` is set and until `closed` is set after the drain loop's final empty-buffer observation. Since the buffer's scheduler is disabled once `closing` is set, an event callback in the finalization gap can remain buffered while `close()` releases the leases. A conforming implementation must seal event admission before the final drain/empty check and must not report close success while any accepted event remains uncommitted.
- Schema migration is explicit, versioned, data-preserving, and recoverable after ambiguous commit. Schema/bootstrap migration is maintenance-gated and must not run concurrently with mixed-version readers or writers.
- Logical row reclamation is not forensic erasure. WAL files, pages, snapshots, and backups may retain old bytes; user-facing claims must state this limitation.

## 8. Plugin integration protocol

The plugin owns trash UI, retention policy, and its own projection/accounting. The provider owns the lifecycle truth.

1. Resolve the active `ctx.sessionPersistence` instance and capture its `identity`.
2. Require `persistence.lifecycle`; if absent, disable destructive actions and do not fall back to filesystem or SQL operations.
3. Persist a unique `operationId` in plugin-owned durable state before calling `retire`.
4. Call provider `retire` and persist the returned opaque token through an idempotent outbox/projection.
5. If the process dies between provider commit and plugin projection, rediscover the active capability and recover using `inspectOperation(id, operationId)`. `inspectById(id)` is only a current-state query; it is not a substitute for exact operation recovery when the public Session ID may have been restored and retired again.
6. Reconcile provider state before publishing trash metadata as authoritative.
7. Before restore/purge, verify the active persistence identity again and use the original opaque retirement token for the transition and all retries. A new operation ID is not required; if the provider supports optional IDs for these methods, persist and reuse that optional key.
8. Keep the existing plugin-level cross-process lock for plugin metadata/accounting only. It is not a substitute for native provider admission fencing.
9. Bind every outbox record to both `providerRootId` and the provider's durable `recoveryEpoch`, in addition to the process-local service `identity`. The process-local symbol detects service replacement; it MUST NOT be persisted or treated as a durable storage-root identity.
10. Persist an outbox phase before each side effect: `prepared` means no provider call has been dispatched; `dispatch_started` means the call may have reached the provider; `provider_result_recorded` means the exact result/token is durably captured; `projection_applied` means plugin projection publication completed. The transition to `dispatch_started` must be durable before invoking the provider.
11. If the active capability reports a different durable root recovery epoch, quarantine all old-epoch entries before dispatch or projection workers run. Never call `inspectOperation` or retry an old operation ID against the new epoch as if it were the same provider namespace.
12. Resolve quarantined entries explicitly: a `prepared` entry can be shown for re-authorization only; `dispatch_started` without a recorded result remains outcome-unknown; recorded old-epoch results/tokens are historical evidence and cannot authorize current projection or provider mutation. Re-authorizing work requires a new user/operator intent and a new operation ID after checking current state.
13. Preserve the original entry, old epoch, operation ID, request fingerprint, token/result digest if present, and reconciliation decision in an audit record. If the restore point cannot establish whether the old operation is represented, discarded, or must be re-authorized, keep recovery blocked rather than guessing.


Provider state is authoritative for live/retired/purged. Plugin metadata is a replayable projection and must never independently authorize destructive storage mutation.

## 9. Upstream acceptance gates

Do not enable a built-in provider until:

- the optional capability shape and compatibility story are accepted;
- operation-ID, token, revision, and typed-outcome semantics are specified;
- create, write, pending-create, and lazy-read admission are covered by deterministic multi-process tests;
- lost responses are recovered at every durable boundary;
- same-ID recreation and stale-generation callbacks are tested;
- JSONL stable lock identity and filesystem durability tests pass;
- SQLite shared-Segment reachability, migration, legacy import, and unrelated-Session preservation tests pass;
- Linux, macOS, and Windows suites pass against each real built-in provider;
- plugin outbox recovery is tested across a process crash.

A fake provider may validate test orchestration only. It cannot satisfy a real provider gate.

## 10. Explicit non-goals

- No plugin-side raw filesystem or SQLite fallback.
- No package-version-based capability inference.
- No promise of forensic erasure from ordinary logical purge.
- No change to append-only Session event semantics or the existing SessionHandle API.
- No claim that this proposal has been accepted or implemented by upstream.


## Root epoch lease semantics

The shared root-epoch lease is held for the lifetime of each serving provider process, from before recovery-envelope validation/capability readiness until all admission is stopped and all handles and operations have drained at shutdown. It is distinct from the per-Session admission gate used by ordinary operations. The root lease is outermost in the lock hierarchy; per-Session gates, writer leases, and provider transactions are acquired beneath it. The root lease is not reacquired per operation.

The durable logical `providerRootId` is distinct from the current physical `storageRootBinding`. The latter must identify the actually opened storage root and protected metadata namespace using platform-appropriate volume/filesystem and directory-object identity, not a textual path alone. Revalidate it through opened handles or equivalent race-resistant directory-relative operations; pathname check-then-open is insufficient. An approved full-root disaster-recovery relocation may update the physical binding while preserving providerRootId, but only under the offline exclusive root gate with explicit trusted restore authorization and a declared restore point. The operation must rotate recoveryEpoch and publish the new storageRootBinding in the same atomic recovery envelope. Copying only metadata, changing a mount/path, or observing an unexplained object-identity change never authorizes rebinding and must fail closed.

A serving process MUST NOT upgrade its shared lease to exclusive or acquire the exclusive gate while holding any lower-ranked lock. Disaster recovery is an offline coordinator workflow: prevent new old-build starts, stop and drain all old-epoch provider processes, then acquire the exclusive form of the same cross-process gate and publish the atomic recovery envelope containing providerRootId, new recoveryEpoch, prior epoch, storageRootBinding, transition ID, and restore-point identity. A recovery process crash releases kernel ownership; the next coordinator validates the durable envelope and resumes by transition ID. No PID/expiry lease or process-local mutex is equivalent.

Each supported OS must prove concurrent shared holders, exclusive-wait behavior, exclusion of new shared entrants during cutover, independent process-death release, and exclusive-owner crash release. A Windows exclusive-only semaphore/mutex does not satisfy this API contract. If a platform cannot demonstrate the required semantics, the provider must not expose lifecycle capability or claim online recovery support there.


### Windows root-gate primitive investigation (candidate only)

Microsoft documents `LockFileEx` as supporting shared and exclusive byte-range locks, with blocking acquisition unless `LOCKFILE_FAIL_IMMEDIATELY` is requested. The OS releases locks when the locking process terminates or the locking handle closes, but crash-time release may be delayed by system resources. This makes a dedicated lock-file byte range a plausible Windows candidate, not a selected or validated implementation. See [Microsoft `LockFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) and [Locking and Unlocking Byte Ranges](https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files).

Important limits must be part of the contract: byte-range locks do **not** prevent reads or writes through memory-mapped views; shared locks deny write access to the locked range even for the process that acquired the shared lock; and the lock is not a substitute for application-level admission/fencing. Therefore the reserved range must be a coordination-only region that the implementation never reads, writes, or maps while locked. All participants must use the same canonical file identity and range. Do not claim fairness or starvation freedom unless the actual filesystem/OS protocol proves it; use bounded watchdogs to detect hangs, not to infer lock fairness. Test process termination and handle-close behavior separately, including inherited/duplicated handles, but do not assume an inherited handle necessarily extends the original process's lock lifetime. Test local filesystems and each supported SMB/filesystem mode independently. The implementation must use a correctly awaited synchronous or OVERLAPPED acquisition path, explicitly unlock on graceful shutdown, and fail closed on unsupported or ambiguous behavior.

### Trusted disaster-recovery authorization and single-use transition

A restore authorization is a control-plane decision, not a boolean, a caller-supplied string, a file copied inside the backup, or possession of the root gate. The recovery coordinator must validate a cryptographically authenticated authorization artifact issued by the deployment's separately administered recovery authority. The verification trust anchor must be provisioned outside the restored provider root and protected from modification by the restore operation; if trust configuration is missing, stale, ambiguous, or unavailable, recovery fails closed. Checksums or hash chains stored beside provider metadata are not proof of authorization.

The authenticated artifact must bind, at minimum: the exact `providerRootId`; the expected prior `recoveryEpoch`; the declared restore-point identifier and integrity digest; the intended target `storageRootBinding`; a unique transition ID; a cryptographically random single-use nonce; the authorized action (including whether physical-root relocation is permitted); issuer/key identity; and a bounded validity interval. The coordinator validates issuer trust, signature, scope, restore-point integrity, target binding, validity, and revocation policy before accepting the transition. It must not broaden scope, substitute a restore point, or reinterpret an authorization for a different root/epoch/target. If reliable time or revocation state required by policy cannot be established, fail closed.

The authorization authority must also provide a durable, anti-rollback nonce registry or equivalent monotonic control-plane state outside the provider root. A signature alone is insufficient: restoring an older provider-root backup must not roll back nonce consumption and make an already-used authorization replayable. The coordinator first reserves the nonce at that authority, bound immutably to the exact transition tuple. Reservation is idempotent for that tuple and permanently rejects any different tuple using the same nonce. After the recovery envelope is durably published, the coordinator commits the reservation at the authority. The authority must retain committed nonce state across provider-root restore, ordinary compaction, and control-plane restart; if the registry cannot be reached or its state cannot be proven, provider lifecycle readiness remains disabled.

The envelope records the authorization nonce (or collision-resistant digest), issuer/key identity, external reservation ID, transition ID, and decision/audit digest alongside the new epoch and physical binding. It also advances a durable append-only local recovery audit chain; each envelope references the prior audit head and the new transition record. The local chain is useful for evidence but is not the anti-replay authority. A nonce is single-use across all transitions for that logical root. Replaying the same authorization with the same transition ID after publication is an idempotent resume/read of that exact transition, not a second use. Reusing its nonce with a different transition ID, restore point, prior epoch, target binding, or action is rejected. Concurrent coordinators serialize under the exclusive root gate; only the exact authorized transition may publish.

A coordinator crash before envelope publication leaves the external reservation bound to the same transition but not committed; a successor may resume only that identical transition with the same still-valid authorization and reservation. A crash after durable envelope publication but before external commit leaves readiness disabled; a successor verifies the exact envelope and idempotently commits the same reservation before readiness. Once committed, a successor only verifies and resumes that transition without republishing or rotating the epoch again. Temporary files, staging directories, process-local flags, and local logs are never evidence that authorization was consumed or that cutover succeeded. If the envelope, local audit chain, and external reservation cannot be reconciled exactly, keep lifecycle readiness disabled and require an explicit operator repair/new authorization; do not mint a replacement nonce or infer success.

The recovery audit must preserve the authorization digest, issuer/key identity, nonce digest, transition ID, exact prior/new epoch and physical bindings, restore-point identity, validation outcome, and operator decision. Do not log the raw authorization artifact, signing secret, or bearer credentials. The provider root itself must not be able to mint or self-approve relocation authority.

### External recovery authority consistency and reservation state machine

The external nonce authority is part of the safety boundary and MUST provide linearizable, durable compare-and-set semantics for every nonce reservation, commit, and abort. A deployment may implement this with a consensus-backed quorum or another mechanism that proves a single serialization order; an eventually consistent multi-primary database, asynchronous replica acknowledgment, local cache, or last-writer-wins merge is not sufficient. A successful reserve/commit/abort response is returned only after the required durable quorum acknowledgment. Reads used for recovery decisions must be linearizable or carry a verifiable fencing/version token at least as new as the acknowledged write. If quorum, authoritative read, or fencing cannot be established, the coordinator fails closed and must not publish an envelope.

Each authority record has a monotonic authority generation and exactly one immutable transition tuple: `providerRootId`, prior `recoveryEpoch`, restore-point digest, target `storageRootBinding`, action, nonce, transition ID, authorization digest, and reservation ID. Its state machine is `ABSENT -> RESERVED -> COMMITTED` or `ABSENT -> RESERVED -> ABORTED`; `COMMITTED` and `ABORTED` are terminal. A reservation cannot expire, be reassigned, or be garbage-collected merely because a coordinator lease or wall-clock timeout elapsed. This avoids a delayed old coordinator publishing after another coordinator has taken over. A successor may resume a RESERVED record only for the identical tuple and reservation ID.

Authorization validity, issuer trust, and revocation are checked at the linearizable reserve operation. Once RESERVED, the authority's durable decision is the authorization to finish that exact transition; the original artifact's time window need not remain open during crash recovery. A reservation may be abandoned only by an explicit, separately authorized, linearizable ABORT operation. ABORT is terminal and permanently burns the nonce; the authority must reject any later COMMIT or different tuple. The coordinator must obtain a definitive COMMITTED state before enabling provider readiness. If an abort races envelope publication, the same serialization protocol must ensure either (a) ABORT wins and envelope publication is prohibited, or (b) the envelope transition has already durably published and ABORT is rejected; there is no state in which an ABORTED nonce can authorize a published transition.

Control-plane failover must preserve the committed consensus history and fencing generation. A replica restored from an older snapshot must not serve writes or authoritative reads until it has rejoined and caught up to the current quorum history. Loss of quorum is unavailability, not permission to elect an isolated writer. Disaster recovery of the authority itself requires a separate, independently authorized control-plane recovery procedure with monotonic generation advancement and explicit reconciliation of all outstanding RESERVED records; it must not reset nonce history or make prior COMMITTED/ABORTED records reusable. If the authority's history is irreconcilable, all affected provider roots remain recovery-required until operator reconciliation establishes a single authoritative history.
