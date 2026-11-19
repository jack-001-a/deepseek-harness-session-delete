# Provider lifecycle conformance and implementation plan

- Status: proposed implementation plan; no upstream provider API or adapter is claimed to exist
- Parent design: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- Upstream contract reviewed at: `deepseek-ai/deepseek-harness` commit `2e39e70496aa02986ca6a820c5d497e816b69d7e` (the current reviewed master tip at inspection time)
- SQLite implementation evidence: [sqlite.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-sqlite/src/sqlite.ts), [persistence.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-sqlite/src/persistence.ts), and [structure.spec.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-sqlite/tests/structure.spec.ts)

## Why this plan exists

The public `SessionPersistence` service currently exposes `create`, `open`, `flush`, `stat`, and `list`. `create` and `open(id, 'write')` obtain writer ownership; `open` requires an existing stored Session. There is no public lifecycle capability that fences create/write admission while the live artifact is absent, nor a provider-owned retire/restore/purge operation.

The built-in JSONL and SQLite implementations have different storage models. The tests below must exercise the real provider implementation and its cross-process boundary. Plugin-local locks, mocks, and direct manipulation of provider-private files or database tables are not substitutes.

## API contract gates

Do not start adapter implementation until the upstream API review resolves these questions:

1. **Capability discovery:** how consumers obtain an optional lifecycle capability from the active `SessionPersistence` instance without breaking existing providers.
2. **Stable operation identity:** how a caller persists an idempotency key before calling `retire`, and how the provider returns the same retirement token after a lost response.
3. **Recovery lookup:** how a caller discovers a committed retirement by `SessionId` when it crashed before persisting the provider-issued token.
4. **Writer admission:** whether `retire` waits for an active writer or returns a typed busy result; in either case, no later `create` or `open('write')` may pass the lifecycle fence.
5. **Restore while absent:** how the provider retains stable identity and admits restore while normal `open` correctly reports not-found.
6. **Revision semantics:** which revision is compared, when it changes, and how stale callers are rejected.
7. **Terminal states:** exact idempotency and typed errors for already-restored, already-purged, missing, corrupt, and unsupported state.
8. **Cancellation:** whether cancellation is honored only before durable commit or can request a recoverable abort after preparation begins.
9. **Recovery ownership:** when provider startup recovery runs and how callers await it before listing or mutating Sessions.
10. **Lock order:** especially SQLite's database Session lock, root creation guard, and legacy JSONL import coordination.

The API must document linearization points for retire, restore, and purge. Without those points, concurrency tests cannot distinguish a correct serialization from a timing-dependent pass.

## Conformance suite structure

The upstream suite should be provider-neutral at the scenario layer, with provider-specific fixtures and fault injection beneath it:

- **Shared scenarios:** lifecycle state machine, typed outcomes, writer/create exclusion, stable ID, idempotency, revision conflict, process death, and recovery.
- **JSONL fixture:** two independent Harness processes using the same configured JSONL root; observe lock identity only through provider-supported test hooks, not plugin code.
- **SQLite fixture:** two independent Harness processes using the same SQLite root/database; seed unrelated Sessions and legacy JSONL imports to detect collateral effects and lock-order bugs.
- **Fault injector:** deterministic barriers at provider transaction boundaries and durable phase boundaries. Avoid sleep-based race tests.
- **Assertions:** event history and metadata equality, normal list/read/open visibility, retirement token stability, no collateral Session changes, and recovery convergence.

Each scenario must run on Linux, macOS, and Windows. Platform-specific lock assertions belong in provider tests; the shared suite asserts semantic outcomes only.

## Required scenario matrix

| Scenario | Process A | Process B | Required result |
|---|---|---|---|
| Active writer | Holds write handle and buffers events | Requests retire | Retire waits or returns typed busy; no data loss |
| Writer drain | Flushes/closes handle | Retries retire | Retirement begins only after final batch is durable |
| New writer race | Retire owns lifecycle fence | Calls `open(id, 'write')` | Writer is rejected or serialized after retirement |
| Create race | Retire and create same ID start at barrier | Competing operation | Exactly one linearized outcome; no duplicate generation |
| Lost retire response | Provider commits, caller is killed before response | Retries same operation ID / inspectById | Same provider token recovered |
| Absent restore | Session is retired; live artifact absent | Calls restore(token) | Original Session becomes live with exact history |
| Restore writer race | Restore owns fence | Attempts create/write same ID | No competing live generation |
| Lost restore response | Provider commits restore, caller killed before response | Retries / inspects token | State converges to live exactly once |
| Purge race | Purge owns fence | Attempts read/write/create | No resurrection or partial visibility |
| Lost purge response | Provider commits purge, caller killed before response | Retries purge(token) | Terminal purged state; no collateral deletion |
| Provider restart | Process killed at every durable phase | Fresh process starts | Recovery converges to valid live/retired/purged state |
| Plugin handoff | Provider retire commits before plugin metadata commit | Plugin restarts | Outbox recovers token by operation ID or Session ID |
| Unsupported backend | No lifecycle capability advertised | Plugin requests delete | Typed unsupported result; no storage mutation |

## Provider-specific assertions

### JSONL

- The Session coordination identity is stable across retire and restore.
- A held lease is never invalidated by moving, unlinking, or replacing its lock object.
- A new writer cannot lock a new inode while an old writer still owns the retired Session identity.
- Generation staging and promotion are durable before the provider publishes retired/live state.
- Recovery never mistakes a missing generation file for a committed retirement.

### SQLite

The reviewed implementation is not a set of Session-owned row bundles. It is a shared, predecessor-linked Segment graph:

- `traces.tail_segment_uuid` points to a Session's tail Segment.
- Each `segments` row has at most one `parent_segment_uuid`; multiple child Segments can share the same parent and a fork can attach at a bounded prefix inside an ancestor.
- `frames` belong to Segments, while `segment_ancestors` stores the transitive ancestor/range index used by reads and fork-cut selection.
- Foreign keys connect traces, segments, frames, and both columns of `segment_ancestors`. `exclusive_trace_head` prevents two traces from using the same tail.
- The current schema installs `frames_no_delete` and `ancestors_no_delete` triggers, plus immutable ancestry/update guards. Schema version 1 is refused when an incompatible version is encountered; startup does not silently migrate it.

Therefore, a correct purge cannot mean “delete the target trace's tail and its ancestors.” It must perform reachability-aware reclamation:

1. Add a provider-owned retirement/tombstone record that retains the Session header, inherited count, operation/token identity, and former tail Segment reference. In one `BEGIN IMMEDIATE` transaction, transfer the root reference from `traces` to this tombstone; do not garbage-collect its history during retirement.
2. Restore atomically transfers the retained root reference from the tombstone back into `traces`, preserving the exact Segment head and event history.
3. Purge first removes the tombstone root reference at its defined linearization point. A Segment is reclaimable only when no live trace or retained tombstone uses it as a root and no remaining Segment points to it as a parent.
4. Reclaim only the now-unreferenced tail-to-root chain. For each Segment, remove its frames and all `segment_ancestors` rows that reference it in either role, then delete the Segment; stop at the first still-referenced ancestor.
5. Keep shared ancestors and their frames intact while any live or retired Session still needs them for reads or restore. A retired Session remains a GC root until its purge commits.
6. Run integrity checks after each fault-injected transaction boundary. A partial graph must never become visible as a valid live Session.

This requires a deliberate schema migration: the current no-delete triggers prohibit physical reclamation, and the existing schema-version gate refuses incompatible layouts. Migration must preserve all existing trace headers, Segment ancestry, frames, and routing records. Do not drop immutability guards wholesale; retain no-update/no-reparent protections and narrow delete permission to provider-owned garbage collection.

Additional SQLite requirements:

- The shared database remains openable and healthy throughout single-Session retire/restore/purge; unrelated Session IDs preserve exact logical histories and remain writable.
- The `.segments` routing marker must agree with lifecycle state. Today a marker whose trace row is absent is treated as missing/corrupt state by listing; retired/purged tombstones need an explicit list/selection interpretation, or the marker must be durably retired in coordination with the DB state.
- `SqliteSessionPersistence.open()` falls back to legacy JSONL when the Session is not selected in SQLite. A retired Session must not silently reappear through that fallback: lifecycle tombstones must fence both SQLite and legacy JSONL identity/import paths.
- Existing writer leases combine a database-scoped per-Session lock with the root artifact/creation guard. They do not by themselves fence read handles or an unmaterialized pending create. Lifecycle admission must cover those paths explicitly.
- Reads materialize event slices through SQLite transactions; define whether a read already in progress may finish before retirement linearizes, and ensure later reads/opens cannot observe retired data. Do not assume an open read handle holds a lease for its entire lifetime.
- Legacy JSONL import racing retire is serialized; stale imported history cannot republish a retired Session. Specify one global lock order for lifecycle, DB Session lease, root creation guard, and migration ownership.
- Database busy/unknown-transaction outcomes are typed and recovery-safe; unknown commit outcome fails closed until provider restart/recovery.
- Segment sharing/fork lineage is accounted for: purge one Session must not remove any Segment still reachable from another Session's tail.
- Define purge semantics precisely. Transactional row/graph removal is logical deletion, not proof of forensic erasure: SQLite pages, WAL files, filesystem snapshots, and backups may retain old bytes. Do not promise secure physical erasure unless a separate, tested database-wide sanitization or cryptographic-erasure design provides it without harming unrelated Sessions.

## Implementation sequence

### Gate 0 — Contract review

- Finalize capability shape, operation ID semantics, linearization points, and typed errors.
- Add public API types and documentation only after maintainers agree on semantics.
- Confirm backward compatibility for providers that do not implement lifecycle capability.

### Gate 1 — Shared conformance harness

- Implement process fixture, deterministic barriers, process-kill helper, state assertions, and OS matrix.
- First run scenarios against a deliberately minimal fake provider only to validate test orchestration; fake-provider success is not a provider conformance result.

### Gate 2 — JSONL adapter

- Implement lifecycle state and writer/create fencing within the JSONL provider.
- Add stable identity, absent-artifact restore, idempotency, and phase-by-phase crash recovery.
- Pass all shared scenarios on all supported OSes before enabling consumers.

### Gate 3 — SQLite adapter

- Implement lifecycle state in the SQLite provider's own transactional model.
- Implement a schema-versioned migration that safely enables provider-owned GC while preserving existing data and immutable-update invariants.
- Define tombstone and routing-marker behavior, including preventing legacy JSONL fallback from resurrecting retired IDs.
- Implement reachability-aware Segment reclamation with deterministic fork/descendant tests and fault injection between trace removal, frame deletion, ancestry-index deletion, and Segment deletion.
- Define in-flight read and pending-create linearization; fence all later open/create/import paths.
- Specify logical purge versus forensic erasure and make user-facing claims match the implemented guarantee.
- Pass all shared scenarios plus SQLite-specific graph-integrity, migration, routing, legacy-import, and collateral-preservation tests.

### Gate 4 — Plugin integration

- Feature-detect provider capability at runtime.
- Persist operation ID before provider mutation.
- Reconcile provider state and plugin trash/accounting via an idempotent outbox.
- Remove provider-private filesystem/database assumptions from destructive plugin paths only after both adapters pass.

## Release gates

A provider is not lifecycle-capable until:

- the shared conformance suite passes on Linux, macOS, and Windows;
- provider-specific storage integrity tests pass;
- process-kill recovery passes at every durable boundary;
- API documentation identifies linearization points and typed failure modes;
- unsupported providers demonstrably fail closed.

This plan is not evidence that any gate has passed. It is the proposed work breakdown and acceptance contract.


## Gate 0 outcome: recommended capability seam

The upstream review resolves the placement question sufficiently for a concrete proposal:

- The public seam is `packages/session/session-persistence/src/index.ts`, exported from the root of `@deepseek-ai/dsh-session-persistence`.
- Both shipped providers subclass that service. Cordis exposes the active provider instance as `ctx.sessionPersistence`; the SQLite provider internally composes a JSONL reader for legacy import.
- The package's documented design is intentionally a seam, not a backend framework: each provider owns its storage runtime. Therefore lifecycle semantic types belong in the shared persistence package, while lifecycle execution remains provider-owned.
- Prefer a **concrete, non-abstract** `getLifecycleCapability(): SessionLifecycleCapability | undefined` method on `SessionPersistence`, defaulting to `undefined`. Built-in providers override it. This keeps existing third-party subclasses source-compatible and makes unsupported capability explicit without creating a second Cordis service that could be paired with the wrong persistence instance.
- Do not add mandatory abstract lifecycle methods, inspect provider package versions/names, or infer support from storage paths. Consumers resolve the capability from the active `ctx.sessionPersistence` and fail closed on `undefined`. Cached capabilities must be invalidated when the service's existing `identity` changes.
- Export the capability interface and shared result/error types from the persistence package root. Do not leak JSONL lock details, SQLite schema/Segment IDs, paths, or implementation classes into the shared package.

This is a recommendation based on the reviewed upstream source, not a change to upstream code. The upstream package currently has no lifecycle method or lifecycle capability.

### Fork and descendant reachability matrix (SQLite)

The shared scenario layer must explicitly exercise the graph cases below. Each fixture records the trace roots, tail Segment IDs, parent links, and bounded fork cuts before the operation; after it, assert exact logical histories for every surviving live or restorable Session and assert that only unreachable private suffixes were reclaimed.

| Fixture / operation | Required invariant |
|---|---|
| Parent with one child forked at parent's tail; purge parent | Child history remains complete; shared tail/ancestors remain reachable from child |
| Parent with child forked at an ancestor prefix; purge parent | The ancestor prefix and child-private suffix remain intact; only parent-private suffix may be reclaimed |
| Parent → child → grandchild; purge middle child | Parent and grandchild histories remain complete; segments shared with either remain |
| Parent → child → grandchild; purge parent | Descendants remain readable even when their lineage root is retired/purged |
| Parent live, child retired; purge parent | Child tombstone remains a GC root and can still restore its exact history |
| Parent retired, child live; restore parent | Restored parent and live child both retain their exact overlapping histories |
| Parent retired, child purged, then purge parent | Parent's retained root protects its history until its own purge; then only unreachable segments are reclaimed |
| Two sibling children share a common ancestor; purge either sibling | Common ancestor and other sibling's branch remain intact |
| Multiple siblings fork at different bounded cuts in one ancestor | Range/ancestor index updates do not truncate or over-delete overlapping prefixes |
| Repeated retire/restore/purge with duplicate operation IDs | Root transfer occurs once; retry cannot double-release a shared root or reclaim a still-referenced Segment |

The tombstone is a root, not merely metadata: retire transfers the trace root to the tombstone; restore transfers it back; purge removes it. The GC test oracle must compute reachability from **all** live trace roots and all restorable retired tombstone roots, then verify that a Segment is deleted only when it is outside that root closure and has no remaining child edge.

### SQLite routing-marker crash consistency

The SQLite routing marker is a filesystem sidecar, so it cannot participate atomically in a SQLite transaction. The lifecycle design must not describe a DB commit plus marker rewrite as one atomic transaction. Prefer keeping the marker as a durable routing/identity record and making the SQLite lifecycle row/tombstone authoritative for live/retired/purged state. Retire/restore/purge should not require an unsafe marker rename or deletion. On every selection/list path, consult the DB lifecycle state before deciding whether to return a live trace, hide a retired/purged Session, or permit legacy JSONL fallback.

The DB transaction and marker publication/reconciliation need explicit crash semantics. In particular:
- A marker whose trace row is absent may correspond to a valid retired/purged tombstone, not necessarily corruption.
- A retired or purged ID must be fenced from JSONL fallback and legacy import, including after provider restart.
- A marker must never cause a tombstone to appear in normal live listing.
- If a marker is missing after a DB commit, reconciliation must be deterministic and must not make an ID visible through the wrong backend.
- Keep a durable identity fence for purged IDs for as long as legacy artifacts or delayed import paths could otherwise resurrect that ID; define retention/compaction only when resurrection is impossible by construction.

These are additional acceptance requirements; the reviewed provider currently has no lifecycle tombstone or marker reconciliation protocol.

## Gate 0 contract refinements

The proposed public capability signature is specified in the parent ADR's **Concrete capability contract** section. Reviewers should resolve these semantics before adapter work:

- **Retire idempotency:** `operationId` is caller-persisted before the provider call, scoped durably to the Session identity, and returns the same token after a lost response. Reusing it for another Session is a typed conflict. A retry of an already committed operation returns its committed result before evaluating the original expected revision again.
- **Revision scope:** `expectedRevision` uses the existing opaque `SessionPersistenceRevision` and is valid only for the same active persistence instance and Session ID. It protects a stale in-process UI/action; it is not a cross-restart concurrency token.
- **Terminal retries:** repeated restore and purge return their already-committed outcomes. Restore-after-purge and purge-after-restore are typed terminal conflicts, never implicit resurrection or destructive retries.
- **Recovery lookup retention:** `inspectById` must retain enough outcome identity to recover a lost response until the plugin outbox can no longer legitimately reference that operation. Token/operation compaction needs an explicit retention rule.
- **Startup readiness:** provider-owned incomplete-phase recovery completes before the provider exposes `ctx.sessionPersistence` as ready. Do not expose a plugin-callable generic `recover()` method whose invocation could race another process or bypass provider startup ordering.
- **Cancellation:** every method documents whether abort is observed only before linearization or can interrupt an in-progress operation. After a commit may have happened, callers must resolve ambiguity through the same operation ID or token inspection, not by generating a new operation ID.
- **Capability lifetime:** a capability obtained from a persistence instance cannot be used after that service is replaced. Consumers reacquire from the current instance; tests must replace the provider and prove no cached capability routes work to the old backend.



### Exact lost-response recovery scenario

Add a deterministic test that retires Session X with operation A, loses the response after provider commit, restores X, then retires X again with operation B. Recovery for operation A must return A's original token and terminal state; recovery for B must return B's distinct token. `inspectById(X)` may report only the current lifecycle record and must not be used to correlate either outbox item. Run the same sequence across provider restart and verify operation mappings survive until the configured outbox-recovery retention boundary.
## Provider capability compatibility and discovery tests

The recommended discovery seam is a concrete, non-abstract method on the existing `SessionPersistence` service:

```ts
getLifecycleCapability(): SessionLifecycleCapability | undefined {
  return undefined
}
```

The default is intentionally unsupported. This preserves existing third-party subclasses and the repository's many test doubles that provide only the current persistence contract. The method is not a second Cordis service: capability discovery must begin from the exact active `ctx.sessionPersistence` instance whose storage is being mutated.

Add these Gate 0 compatibility tests before implementing either adapter:

| Test | Setup | Required result |
|---|---|---|
| Legacy subclass source compatibility | Compile a minimal third-party subclass implementing only the existing abstract methods | It still type-checks without lifecycle overrides |
| Default unsupported behavior | Instantiate that subclass and call capability discovery | Returns `undefined`; no storage operation is attempted |
| Explicit provider capability | Instantiate a provider that overrides discovery | Returns a stable capability object bound to that provider instance |
| Mock persistence compatibility | Inject existing lightweight test doubles through Cordis | Existing tests remain valid; destructive consumers fail closed when capability is absent |
| Service replacement | Resolve capability A, replace `ctx.sessionPersistence` with provider B | Consumer rejects/reacquires; capability A cannot mutate B's storage |
| Repeated discovery | Resolve capability more than once from one provider instance | Stable identity/semantics; no duplicate coordinator or lease runtime is created |
| Provider composition | Mount SQLite with its internal JSONL legacy reader | The exposed capability belongs to the outer SQLite persistence service and governs both SQLite and fallback/import paths |
| Package entry-point contract | Import public capability types from the persistence package root | No provider-private module path or implementation dependency is required |

The service's existing `identity` symbol is process-local and changes on provider replacement. Consumers that retain a capability must retain the originating service identity and verify it against the currently active service immediately before each lifecycle operation. Do not treat the identity or `SessionPersistenceRevision` as a durable cross-process token.

The public package should own only provider-neutral interfaces, opaque tokens, typed outcomes/errors, and operation semantics. Provider packages own capability construction, durable operation indexes, recovery, locks, tombstones, and storage-specific tests. Avoid importing either concrete provider into the shared persistence package.

A fake provider passing these compatibility tests proves only that discovery is backward-compatible; it does not count toward lifecycle conformance. A provider is lifecycle-capable only after its real multi-process adapter suite and platform matrix pass.
## SQLite WAL read admission, purge ordering, and handle lifetime

The reviewed SQLite implementation currently materializes the requested trace metadata and frame BLOBs inside one short `DEFERRED` read transaction. The transaction commits before asynchronous frame decompression and event parsing. A `SqliteSessionHandle` does not pin a WAL read transaction for its entire open lifetime; it calls the store for each read. This distinction should drive the lifecycle contract rather than assuming that an open read handle is a long-lived SQLite snapshot.

Define the read linearization point as the lifecycle-state check performed in the same SQLite read transaction that selects the trace metadata and frame BLOBs:

- If a read transaction establishes its snapshot before the retire transaction commits, that read is admitted and may return its already-materialized events after retirement commits. Decompression/parsing after the snapshot is not a new storage read.
- If retirement commits before the read transaction establishes its snapshot, the read must observe the retired state and fail with a typed retired/not-found outcome. It must not fall through to legacy JSONL.
- A read handle opened before retirement has no perpetual entitlement. Every subsequent `read()` repeats the transactional lifecycle check; opening a handle is not a lifecycle lease.
- Purge may delete rows after retirement has committed without waiting for decompression of bytes already copied into the admitted read's memory. It must not allow a later read on that same handle to acquire a fresh snapshot.
- The lifecycle row/tombstone lookup, trace lookup, and frame selection must share one SQLite transaction/snapshot. A separate preflight lifecycle query followed by a later trace/frame query is racy.

SQLite WAL permits a writer to commit while an older reader retains its snapshot. Therefore the conformance suite must not assert that retire/purge waits for every already-admitted read to finish decoding. Instead it must assert snapshot consistency and deny every post-retire admission. A read that began before retirement but had not yet established its database snapshot is not admitted; it must observe the retired state.

Required deterministic WAL tests:

| Scenario | Required result |
|---|---|
| Reader begins transaction and captures frames; retire commits before decode completes | Reader returns the complete pre-retire slice; retire succeeds without corrupting the read |
| Retire commits before a new read transaction starts | New read fails as retired; no legacy fallback occurs |
| Existing read handle calls `read()` again after retire | Second call fails; prior successful open does not bypass lifecycle state |
| Purge commits after a read has copied frame BLOBs but before decode completes | That admitted read may finish; later reads fail and no deleted rows are re-read |
| Reader is paused before its first lifecycle/trace SELECT; retire commits; reader resumes | Reader sees retired state in its newly established snapshot and is denied |
| Two independent processes race read admission and retire | Outcomes correspond to a single serial order at the SQLite snapshot/commit boundary; no partial trace/frame view |
| Long-lived external WAL reader prevents checkpoint progress | Logical purge remains correct; checkpoint busy/incomplete is reported as maintenance state, not mistaken for failed logical purge |

Do not add a provider-wide read lease solely to wait for asynchronous decompression: the selected frame bytes are already detached from SQLite. If implementation instead streams rows lazily or retains SQLite statements/cursors across awaits, this assumption no longer holds and the design must add explicit reader lifetime coordination before purge.

## WAL checkpointing and physical-byte claims

Logical purge is a database transaction that removes the retired root and unreachable graph rows. It is not forensic erasure. In WAL mode, old page images may remain in the `-wal` file until checkpoint/reuse; database pages, filesystem snapshots, backups, copy-on-write layers, and storage-device remapping may retain historical bytes after checkpointing. A successful `wal_checkpoint(TRUNCATE)` is a space-reclamation/maintenance result, not proof that every prior copy of the bytes was overwritten.

Keep these outcomes separate:

- **Logical purge committed:** lifecycle tombstone is terminally purged, the live trace/root is absent, and unreachable Segment/frame/ancestry rows are gone according to the reachability oracle.
- **Checkpoint pending or blocked:** one or more readers may prevent full checkpoint/truncation. This does not roll back an already committed logical purge and must be observable as maintenance debt.
- **Forensic erasure:** unsupported unless a separately designed and independently validated mechanism covers WAL, DB pages, backups, snapshots, and storage behavior. Do not advertise this guarantee from SQL `DELETE`, `VACUUM`, or checkpoint success alone.

Tests should hold a second connection's WAL read transaction open while purging, inspect checkpoint result codes, release the reader, and then verify that checkpoint can make progress. They must assert logical state independently of physical WAL file size. Never make a test's pass condition depend on a WAL file shrinking to zero as proof of deletion.

## Tombstone and operation-record retention

Retirement tombstones and idempotency records have different lifetimes and must not be compacted as one unit:

- A retired Session tombstone remains a Segment GC root and remains restorable until purge commits. Purge removes its data-root role and allows unreachable graph reclamation, but a minimal terminal lifecycle identity fence must remain while any legacy JSONL artifact, delayed importer, routing marker, or stale caller could otherwise resurrect the ID.
- A committed `operationId` mapping must continue resolving to its original token/outcome even if that Session is subsequently restored and retired under a different operation ID. `inspectById` is not a substitute.
- The provider cannot infer that the plugin outbox has finished reconciliation merely because a token was inspected once. Do not expire operation mappings based on wall-clock age alone.
- If operation payloads are compacted, retain a durable deduplication tombstone keyed by `(SessionId, operationId)` so an old retry cannot execute a second retirement. Define an explicit acknowledgement/retention protocol before deleting even that key; absent such a protocol, retain the compact mapping.
- Purged-ID fences may be compacted only after the provider can prove all legacy artifacts and all delayed create/import paths capable of publishing that ID are gone or permanently rejected. A time-based TTL alone is insufficient.

Required retention tests include: provider restart after commit but before caller token persistence; retire A → restore → retire B → recover A and B independently; purge followed by delayed legacy import; stale retry after operation compaction; and provider upgrade with old routing markers still present.
## SQLite commit-to-routing-marker crash recovery

The reviewed upstream SQLite adapter has a deliberate two-resource publication sequence: SQLite commits the Session row/frames first, then `publish(id)` durably publishes `.segments/<sha256(id)>.json`. The marker is written to a unique temporary file, file-synced, then atomically published (hard-link on POSIX; the provider's Windows-specific publication helper on Windows), followed by directory sync on POSIX. The SQLite commit and filesystem marker publication are not one atomic transaction.

An important existing behavior narrows the recovery problem: `selected(id)` does not treat a missing marker as proof that the Session is JSONL-backed. When the marker is absent, it checks the SQLite database and returns the SQLite snapshot if a row exists; only an absent SQLite row can proceed to legacy JSONL selection. Conversely, a marker that exists but has no corresponding SQLite row is treated as missing/corrupt storage rather than silently falling back. `list()` also detects marker filenames that do not correspond to a known SQLite row.

Therefore the marker is a durable routing/identity guard and database-loss detector, not the sole authority for deciding whether a SQLite row exists. Lifecycle-aware implementations must preserve that distinction and must not turn marker repair into a path that imports legacy data over a retired or purged identity.

### Recovery authority and rules

1. The SQLite lifecycle/trace tables are authoritative for a committed SQLite identity while the configured database is present and passes integrity/schema checks. The marker is a derived durable routing record naming the configured database path.
2. A committed live SQLite row with a missing marker is a recoverable publication gap. Startup reconciliation may recreate the marker using the same durable temp-file + atomic-publish + directory-sync protocol. Until repaired, reads must continue to resolve the SQLite row, never import JSONL over it.
3. A retired identity must have a durable tombstone/anti-resurrection record in SQLite. Missing marker must not cause fallback/import to treat its legacy JSONL artifact as live. Lifecycle lookup must precede legacy fallback, and a terminal purged-ID fence must outlive any stale import route.
4. A marker with no live row is not automatically an orphan to delete. It may represent a retired/purged identity whose tombstone/fence is authoritative, an incomplete/unknown commit outcome, a damaged database, or a genuine missing database. Reconcile it against lifecycle tombstones and database health; if no authoritative explanation exists, fail closed and preserve evidence.
5. A configured database missing while markers remain is a restore-required condition. Do not create a new empty database and do not delete markers to make startup succeed.
6. A marker whose `database` path differs from the configured database remains an identity/configuration error. Never rewrite it automatically to point at a different database.
7. Temporary `.route-*.tmp` files are not committed routing records. They may be cleaned only after validating the naming convention and ensuring no active publisher owns them; use a provider-wide startup/reconciliation lock or age-independent ownership protocol, not a blind wildcard deletion while other processes may be publishing.
8. Marker reconciliation must be idempotent and safe under multiple provider processes. Acquire the same per-Session creation/artifact guard (or a dedicated provider-owned reconciliation lease) before publishing or changing one identity's route. Atomic create-if-absent handles duplicate publishers; an existing marker must be parsed and identity-checked, never overwritten.

### Required crash-injection matrix

| Crash/fault point | Durable state after restart | Required recovery |
|---|---|---|
| Before SQLite transaction commits | No committed trace/tombstone; no marker expected | Retry same operation ID; legacy identity remains unchanged |
| SQLite COMMIT succeeds; process dies before marker temp file creation | SQLite row/tombstone exists; marker absent | Discover authoritative lifecycle state; publish marker for live SQLite row; never import legacy over retired/purged identity |
| Temp marker created but file not synced | SQLite state exists; incomplete temp may remain | Ignore temp as uncommitted; recreate marker from authoritative DB state |
| Temp file synced; crash before atomic publication | SQLite state exists; durable temp may remain; final marker absent | Reconcile from DB and atomically publish final marker; clean temp only under ownership protocol |
| Atomic link/Windows publication succeeds; crash before directory sync | Final marker may or may not survive power loss | Re-read DB and marker on restart; idempotently republish if absent; validate if present |
| Directory sync succeeds; caller dies before receiving success | DB and marker exist | Retry with same operation ID returns original durable outcome/token |
| Retire/purge commit succeeds; marker publication/cleanup fails | Tombstone or terminal fence is authoritative | Keep lifecycle state; report repair debt; do not roll back or expose legacy fallback |
| Marker exists but trace row is absent and tombstone/fence exists | Retired/purged identity | Apply lifecycle-specific list/open semantics; marker is not interpreted as live trace |
| Marker exists but database is missing | Database unavailable | Fail closed with restore-required error; preserve marker and legacy artifacts |
| Two processes reconcile/publish same missing marker | One or both attempt atomic create | Exactly one marker is created; loser validates the winner; no replacement or truncation |
| Existing marker points to a different DB path | Configuration/storage identity mismatch | Fail closed; no automatic rewrite |

### Startup reconciliation ordering

Run reconciliation only after database open, schema/version validation, and recovery of in-flight lifecycle operations. Then:

- Scan authoritative lifecycle records and trace rows in a consistent DB snapshot; classify each identity as live, retired/restorable, purging/incomplete, or purged/terminal.
- For live SQLite rows, ensure a valid marker exists and points to the configured DB. Missing markers are repaired atomically.
- For retired and purged identities, preserve the tombstone/fence and apply the documented marker retention policy; do not recreate a live-looking route unless the route format explicitly encodes lifecycle state.
- Scan existing marker filenames. Validate each marker against the configured DB and the authoritative lifecycle/trace inventory. Unknown marker-only identities fail closed unless an explicit durable tombstone/fence explains them.
- Reconcile legacy JSONL identities only after the SQLite lifecycle inventory is authoritative. A matching retired/purged identity must block migration/import even if its marker is missing.
- Publish a reconciliation-complete watermark only after all records in the scan are processed. If the process dies midway, rerun the idempotent scan; do not rely on an in-memory `publishedRoutes` cache across restart.

Do not make startup reconciliation depend solely on the marker directory scan: it cannot discover a committed SQLite row whose marker was never published. Conversely, do not use the JSONL listing as authority for an identity already represented in SQLite lifecycle state.

Tests must inject process termination at every publication boundary on POSIX and Windows, restart a fresh provider instance, and verify `open`, `stat`, `list`, `create`, and legacy migration behavior. Include concurrent startup reconciliation by two processes, database restore to a different configured path, stale temp files, corrupt marker JSON, and marker/database path mismatch.
