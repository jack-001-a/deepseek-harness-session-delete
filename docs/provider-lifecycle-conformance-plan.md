# Provider lifecycle conformance and implementation plan

- Status: proposed implementation plan; no upstream provider API or adapter is claimed to exist
- Parent design: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- Concrete API proposal: [Provider-owned lifecycle capability](./provider-lifecycle-api-proposal.md)
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
- **Fault injector:** deterministic barriers at provider transaction boundaries and durable phase boundaries. The current `FaultPlan` is only a one-shot schedule descriptor; it does not inject faults into a Provider. A real provider adapter must connect each scheduled point to an approved provider test hook and prove the requested action occurred. Avoid sleep-based race tests.
- **Assertions:** event history and metadata equality, normal list/read/open visibility, retirement token stability, no collateral Session changes, and recovery convergence.

Each scenario must run on Linux, macOS, and Windows. Platform-specific lock assertions belong in provider tests; the shared suite asserts semantic outcomes only.


### Provider fault-hook adapter contract

The harness fault schedule is not itself a Provider fault injector. An adapter that
claims fault-injection support must expose an explicit `faultInjection` object with
`supported: true` and the asynchronous `arm`, `waitForHit`, and `disarm` methods.
The contract request identifies a named point, one of the phases
`before-commit`, `after-commit-before-response`, or `outcome-unknown`, an action,
and the stable operation ID.

A scheduled point counts as exercised only when `waitForHit` returns a correlated
record containing the provider-issued fault ID, exact point/phase/action/operation ID,
`hit: true`, `actionApplied: true`, and a non-empty provider boundary ID. Missing
hooks, timeouts, mismatched records, or an action that was not applied are failures;
they must never be converted to a skipped PASS. Prefer the shared `withProviderFault`
runner, which performs disarm after both hit-verification and scenario failures. A
successful `disarm()` must explicitly return `true`; `false`, `undefined`, or a thrown
error is a cleanup failure and fails the scenario. If both the scenario and cleanup
fail, both causes must remain observable (for example via `AggregateError`) rather
than allowing cleanup to hide the original failure.

This is an adapter protocol contract, not proof that the hook is placed at a real
filesystem sync or SQLite commit instruction. Each Provider must separately document
and test the mapping from its named boundary to the actual durable operation, including
the pre-commit, committed-response-loss, and outcome-unknown semantics. The fixture
tests for this contract do not count as Provider lifecycle conformance evidence.


### Independently reviewed durability-boundary map

A Provider's `boundaryId` string is correlation metadata, not proof of a durable boundary.
Each provider-specific conformance adapter must be paired with a trusted boundary map
maintained by the conformance suite (not generated from the adapter response). For every
fault point, that map records:

- provider identity and exact provider version/build;
- lifecycle operation, named point, and semantic phase;
- the actual durability primitive (for example file sync, containing-directory sync,
  atomic rename, provider journal commit, or SQLite transaction commit);
- a source reference identifying the implementation function responsible for that
  primitive; and
- the exact provider source commit reviewed for that mapping.

The hit record must return the same fields. The harness compares it against the
independently maintained expectation and rejects missing or mismatched metadata. A
provider cannot make an arbitrary string pass by returning it as its own `boundaryId`.

This comparison is still not a substitute for source review and provider-specific
black-box tests. The map must be reviewed against the exact provider source revision,
and tests must establish the externally observable durability semantics around the
mapped instruction (including restart/recovery). Until a real provider mapping is
reviewed and exercised, the boundary remains unverified and no Provider conformance
claim is permitted. The current fixture only tests that the adapter protocol enforces
the map; it does not provide a JSONL or SQLite boundary mapping.

## Required scenario matrix

| Scenario | Process A | Process B | Required result |
|---|---|---|---|
| Active writer | Holds write handle and buffers events | Requests retire | Retire waits or returns typed busy; no data loss |
| Writer drain | Flushes/closes handle | Retries retire | Retirement begins only after final batch is durable |
| New writer race | Retire owns lifecycle fence | Calls `open(id, 'write')` | Writer is rejected or serialized after retirement |
| Create race | Retire and create same ID start at barrier | Competing operation | Exactly one linearized outcome; no duplicate generation |
| Lost retire response | Provider commits, caller is killed before response | Retries the same operation ID / calls `inspectOperation(id, operationId)` | Same provider token recovered; `inspectById` is diagnostic current-state lookup only |
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
- **Recovery lookup retention:** `inspectOperation(id, operationId)` must retain enough exact outcome identity to recover a lost response until the plugin outbox can no longer legitimately reference that operation. `inspectById(id)` reports only current lifecycle state and cannot correlate historical outbox operations. Token/operation compaction needs an explicit retention rule.
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
## SQLite schema v1 → lifecycle schema v2 migration protocol

The reviewed upstream SQLite implementation currently declares `SCHEMA_VERSION = 1`, `APPLICATION_ID = 0x44535043`, and refuses any nonmatching non-empty database. Schema v1 has `segments`, `traces`, `frames`, and `segment_ancestors`; it protects frame and ancestor rows with unconditional no-delete triggers, while ancestry and frame-update immutability are separately enforced. The lifecycle proposal therefore requires an explicit, versioned migration; it must never initialize an empty replacement database over an existing incompatible file.

### Migration invariants

- Preserve every existing trace header byte-for-byte (or preserve its exact parsed semantic value if a future canonicalization is explicitly specified), every `inherited_count`, every Segment UUID and parent/range field, every frame payload/codec/range, every ancestor-index row, and every `.segments` routing marker.
- Do not rewrite, re-compress, reframe, renumber, or re-parent existing Session history as part of this migration.
- Keep `application_id` unchanged. Advance `user_version` from 1 to 2 only in the same SQLite transaction that installs the complete v2 schema and trigger set.
- Keep the existing no-update/no-reparent and append-only frame-update guards. Relax only the two delete guards needed for provider-owned GC, and replace them with a private, transaction-scoped GC authorization check.
- Never perform filesystem marker rewrites or JSONL imports as part of the SQLite DDL transaction. Those are separate resources and are reconciled after database migration using the routing-marker recovery protocol above.
- Unsupported versions, foreign application IDs, malformed v1 layouts, failed preflight checks, and ambiguous databases remain untouched and fail closed.

### Recommended v2 schema additions

Use provider-private, `STRICT` tables with explicit constraints and indexes:

- `session_lifecycle`: one row per Session identity; lifecycle state, revision/generation, current or former tail Segment reference, retained header, inherited count, opaque token digest, and timestamps used for audit (timestamps are not deduplication expiry). A retired row retains the Segment root until purge.
- `session_lifecycle_operations`: unique `(session_id, operation_id)` mapping to the exact operation kind, terminal/intermediate outcome, generation, and retirement token reference/digest. This survives restore and later retirement generations; it is not replaced by a single `inspectById` row.
- `session_lifecycle_tokens`: unique opaque token digest mapped to Session and generation, with constraints preventing token reuse across identities or generations.
- `session_lifecycle_fences`: terminal purged-ID anti-resurrection identity. It must remain authoritative even after the Session's trace and Segment rows are reclaimed; it has no FK to a reclaimable Segment.
- `gc_authorization`: a private, normally empty transaction-local-in-practice permit table used by delete triggers. It must be populated and cleared inside the same `BEGIN IMMEDIATE` transaction; a committed permit row is an integrity failure and blocks startup.

Exact column layout and token encoding remain an implementation decision, but uniqueness, referential ownership, generation scoping, and durable anti-resurrection semantics are mandatory. Avoid a foreign key from a terminal purged-ID fence to `traces` or `segments`, because those rows are intentionally reclaimed.

### Atomic v1 → v2 migration sequence

1. Open the existing database without creating a replacement. Set `foreign_keys=ON`, `synchronous=FULL`, and WAL mode using the existing bounded busy/retry policy. Obtain the SQLite writer reservation with `BEGIN IMMEDIATE`; concurrent initializers must serialize here.
2. Read `application_id` and `user_version` again inside the transaction. If `(application_id, user_version) == (expected, 2)`, validate v2 and return idempotently. If `(expected, 1)`, continue. If the database is empty `(0, 0)`, use the separate fresh-create path. Any other pair fails closed without modifying the file.
3. Validate the exact expected v1 schema objects and required columns/indexes/triggers. Reject unknown tables/triggers or unexpected object definitions unless a documented forward-compatible allowlist explicitly permits them. Do not assume `user_version=1` proves the schema is intact.
4. Run pre-migration checks inside the reserved transaction: `PRAGMA quick_check` (or `integrity_check` where startup budget permits), `PRAGMA foreign_key_check`, required-column/object checks, and application-level graph validation. Verify every trace tail exists, every parent chain is acyclic and range-valid, frame ranges are contiguous/valid under the existing format rules, and `segment_ancestors` matches the transitive parent/range closure. A failure aborts before DDL.
5. Create lifecycle, operation, token, terminal-fence, and GC authorization tables and their indexes. Existing v1 rows are not copied or rewritten; live v1 traces are logically live by default and need no synthetic retirement history.
6. Replace only `frames_no_delete` and `ancestors_no_delete` with guards that reject deletion unless the private GC authorization row exists. Keep `frames_no_update`, `segments_no_reparent`, `ancestors_no_update`, and `segments_index_ancestors` unchanged. Add explicit trigger/schema validation so ordinary append/write paths cannot enable GC.
7. Validate the complete v2 object set, check that the GC authorization table is empty, re-run `foreign_key_check`, and verify the v1 trace/Segment/frame/ancestor counts and stable identity digests are unchanged.
8. Set `PRAGMA user_version = 2` last, still inside the same transaction, then COMMIT. SQLite transactional DDL makes schema objects and version advancement atomic: a crash before commit rolls back all v2 changes; a crash after commit exposes the complete v2 schema. An ambiguous COMMIT result marks the provider outcome unknown and requires close/reopen plus version/schema inspection before any retry.
9. After the DB transaction commits, run the independent marker reconciliation protocol. Do not import JSONL or delete/rewrite `.segments/*.json` as part of migration. A failure in marker reconciliation leaves v2 committed and records repair debt; it does not roll back the database migration.

### Narrowly authorized Segment GC

The v2 delete guards should not be dropped. Replace unconditional denial with a guard that checks a private authorization row scoped to the current SQLite transaction. A purge transaction inserts the permit, removes the relevant tombstone root and operation references according to retention rules, deletes only unreachable frame and ancestor-index rows, deletes now-unreferenced Segments from leaves toward the root, verifies no live trace/tombstone/child still references each candidate, then removes the permit before COMMIT. The permit must never be committed, and a trigger must reject a delete if the permit is absent.

Keep `segments_no_reparent` and all ancestry update protections permanently. GC must explicitly remove `segment_ancestors` rows in both `segment_uuid` and `ancestor_uuid` roles before deleting a Segment; it must not rely on cascading behavior that v1 did not define. Foreign keys remain enabled on every connection. Any FK violation or unexpected remaining reference aborts the whole purge transaction.

Because a normal SQL caller with write access to the private database could theoretically manufacture a permit, this is an internal integrity guard, not a security boundary against a hostile local process with database-file write access. The database is provider-private; do not expose the authorization table or arbitrary SQL surface through the public lifecycle capability.

### Crash and rollback matrix

| Failure point | Required durable result | Restart behavior |
|---|---|---|
| Before `BEGIN IMMEDIATE` | v1 unchanged | Retry migration |
| After writer reservation, before DDL | v1 unchanged | SQLite rolls back abandoned transaction; retry |
| During lifecycle-table/index creation | v1 unchanged after rollback | Detect v1 and retry; no partial v2 accepted |
| After delete-trigger replacement, before version bump | v1 unchanged after rollback | Old triggers restored by transactional DDL; retry |
| During pre-commit validation | v1 unchanged after rollback | Fail closed with diagnostic; repair/restore source DB |
| During COMMIT with unknown client outcome | v1 or complete v2, never accepted partial schema | Close connection; reopen and inspect `(application_id,user_version)` plus full schema fingerprint before retry |
| After v2 COMMIT, before marker reconciliation | complete v2 database; markers may be stale/missing | Run idempotent marker reconciliation; do not rerun v1 DDL or import over existing lifecycle state |
| During GC after permit insert but before permit removal | no partial purge after rollback | Permit insert and all deletes roll back together |
| Attempt GC delete without permit | statement aborts | Session data remains unchanged |
| Process dies after purge COMMIT but before caller response | complete terminal outcome/fence persisted | Resolve by `(session_id, operation_id)`; never execute a second purge generation |

### Required migration tests

- Build representative v1 fixtures with empty DB, single trace, multiple independent traces, forked/shared ancestors, bounded-prefix forks, grandchild branches, empty and non-empty frames, and legacy JSONL identities alongside SQLite rows.
- Snapshot all v1 logical data before migration and compare after migration: headers, inherited counts, trace tails, Segment UUID/parent/ranges, frame bytes/codecs/ranges, ancestry closure, marker bytes, and unrelated JSONL contents.
- Inject process termination after each DDL/trigger/version boundary. Reopen with a fresh process and assert the database is either valid v1 or fully valid v2, never a mixed schema.
- Run two independent processes attempting v1→v2 simultaneously; one performs the migration, the other observes and validates v2 without duplicate DDL or data changes.
- Test unknown `application_id`, future `user_version`, malformed v1 schema, missing tables, extra unexpected triggers, corrupt graph, FK violations, and failed quick/integrity checks. Verify byte-for-byte database preservation where no transaction was committed.
- Test migration with an external WAL reader and with a busy writer. It must wait/fail within the established timeout, never switch to DELETE journal mode, replace the database file, or unlink WAL/SHM files.
- Verify ordinary append/update paths cannot delete frames or ancestry rows; authorized GC can delete only unreachable rows; missing permit, stale permit, wrong Session scope, and accidental permit leakage all abort.
- Verify lifecycle tombstones preserve the exact original root through restore; purge of one branch preserves shared ancestors and siblings; purged-ID fences and operation mappings remain after graph reclamation.
- Run all tests on Linux, macOS, and Windows, and test restart recovery rather than only catching exceptions in-process.

### Rollout constraint

Do not ship a lifecycle-capable consumer against schema v1. The v2 migration, lifecycle tables, routing reconciliation, guarded GC, and crash-injection suite must land and pass together in the provider implementation. Until then, the design remains proposal-only and the current SQLite provider must continue to refuse unsupported lifecycle operations.
## SQLite Segment graph GC: reachability, ordering, and writer serialization

The Segment graph is a shared predecessor DAG, not a Session-owned tree. A Segment can be an ancestor of multiple branches, and a fork can point to a bounded prefix of an ancestor. The `segment_ancestors` table is a transitive range index (`segment_uuid` descendant, `ancestor_uuid` ancestor); it is not itself the ownership authority. `traces.tail_segment_uuid` and retained lifecycle tombstone roots define which histories remain required.

### Correctness predicate

A Segment is reclaimable only if it is not reachable by following `parent_segment_uuid` from any retained root. The root set includes every live trace tail and every restorable retired lifecycle root. Operation records, token records, and terminal purged-ID fences must not accidentally retain a Segment root after the operation's retention policy releases it; conversely, an in-progress purge must not release its root before the purge transaction reaches its defined terminal commit.

Do not use any one of these weaker predicates: no trace points directly to the Segment; no tombstone points directly to it; it has no frames; or it is not the current tail of the purged Session. A live descendant may depend on it through one or more parent edges, and another child may fork from a bounded prefix.

### Recommended mark-and-sweep transaction

Use one `BEGIN IMMEDIATE` transaction for lifecycle state transition, root-set change, reachability calculation, and GC. SQLite's single-writer reservation serializes this transaction against other writers to the same database, including fork/append/create/restore/purge, provided every such provider path uses this same database transaction and performs lifecycle admission inside it.

1. Validate `(session_id, operation_id)`, expected lifecycle generation/revision, and the exact retirement token. If the operation already has a durable terminal outcome, return that outcome without rerunning GC.
2. Verify the target is in the required retired state. For purge, transition it to `purging` and remove its restorable root only within this same uncommitted transaction. A rollback restores both the prior state and root.
3. Build the root set from all live `traces.tail_segment_uuid` values plus all lifecycle rows whose state retains history for restore or recovery. Include any provider-defined migration/recovery roots explicitly; do not infer roots from operation history alone.
4. Compute the transitive parent closure from those roots using a recursive CTE or an equivalent bounded, cycle-detecting traversal. The retained set is the union of roots and every ancestor reached by repeatedly following `segments.parent_segment_uuid`.
5. Candidate set = every Segment not in the retained closure. Before deleting anything, validate that the candidate graph is acyclic, all parent references resolve, all frame ranges are valid, and `segment_ancestors` agrees with the parent graph for the affected closure. If validation fails, abort the entire transaction.
6. Reclaim candidates in leaf-first batches: select candidate Segments that have no remaining child Segment (`child.parent_segment_uuid = candidate.segment_uuid`), delete their `frames`, delete every `segment_ancestors` row where the candidate appears in either `segment_uuid` or `ancestor_uuid`, then delete the Segment. Repeat until no candidates remain. If candidates remain but no candidate leaf exists, treat this as graph corruption/cycle and roll back; never fall back to arbitrary deletion order.
7. Before commit, assert that no remaining row references a deleted Segment, no retained root was deleted, no live trace/tombstone lost its reachable closure, all foreign keys pass, and the GC authorization table is empty.
8. Persist the terminal purged outcome, operation mapping, and permanent anti-resurrection fence in the same transaction as root release and graph reclamation. Commit once. The purge linearization point is this commit; before it, restore/recovery can still win after rollback, and after it, restore must reject.

The full mark-and-sweep may scan a large database. An incremental candidate walk can be introduced only if it is proven equivalent: start at the purged root, stop when any retained root or any remaining child references a candidate, and continue to the parent only after the child has been safely deleted. It must still account for multiple children, bounded-prefix forks, all tombstone roots, and stale/unrooted descendants. Prefer the simpler full closure as the correctness baseline before optimizing.

### Why the leaf-first deletion order matters

`segments.parent_segment_uuid` is a foreign key to `segments.segment_uuid`. Deleting a parent before its children violates referential integrity. For every candidate leaf, remove its frames first, then all closure-index rows in both roles, then the Segment row. When a candidate is a parent of a retained Segment, that child is reachable from a retained root and the parent must be in the retained closure; it must never enter the candidate set.

The `segment_ancestors` cleanup must include both predicates: `segment_uuid = candidate` and `ancestor_uuid = candidate`. Removing only descendant rows leaves foreign-key references in the ancestor role; removing only ancestor rows leaves rows owned by the deleted descendant. Never disable foreign keys to make GC pass.

### Fork, restore, purge, and append race semantics

- **Fork vs purge:** both must acquire the same SQLite writer reservation. If fork commits first, its new child trace is a root and the parent's required closure is retained. If purge commits first, a later fork must fail lifecycle admission and must not create a child from the purged identity.
- **Restore vs purge:** both validate and change lifecycle state inside `BEGIN IMMEDIATE`. The first successful commit wins. If restore commits first, purge retry sees `live` and fails its retired-state precondition. If purge commits first, restore sees the terminal purged fence and fails permanently.
- **Append vs retire:** an append admitted and committed before retire is included in the retained tail. If retire commits first, a later append must fail lifecycle admission. Do not rely on a process-local writer lease alone.
- **Fork vs retire:** fork must validate the source lifecycle state in the same transaction that creates the child Segment/trace root. A preflight read outside the write transaction is a TOCTOU race.
- **Two purges:** unique `(session_id, operation_id)` plus generation-scoped lifecycle state ensures the same retry returns the same result, while a different operation ID cannot purge a later restored generation by accident.
- **Reader vs purge:** already materialized BLOB bytes may finish decoding under the previously specified read admission semantics. A new read transaction after retire/purge commit must observe lifecycle state and reject. Do not keep a SQLite cursor/statement open across asynchronous decode unless a reader-lifetime protocol is added.

### GC authorization must be row-scoped

Replace the unconditional delete triggers with provider-private guards, not an unrestricted boolean switch. A transaction-local-in-practice `gc_authorization` row should identify the exact GC operation and the specific Segment UUID being reclaimed. `frames` and `segments` delete triggers require a matching permit for `OLD.segment_uuid`; `segment_ancestors` delete trigger requires a permit for the candidate UUID in either `OLD.segment_uuid` or `OLD.ancestor_uuid`. Insert permits only after the candidate set has been validated, and remove them before commit. The final empty-permit assertion is mandatory.

This authorization is an integrity guard against accidental provider code paths, not a security boundary against a hostile process that can write arbitrary SQL to the private database. Do not expose this table or arbitrary SQL capability publicly. A missing, stale, mismatched-operation, or leaked permit must abort the transaction or block startup.

### Required adversarial graph and concurrency tests

- One root with a linear chain; purge it and verify every Segment/frame/ancestry row is reclaimed.
- Two live traces sharing an ancestor through sibling branches; purge one branch and verify the sibling and shared prefix remain byte-identical.
- A bounded-prefix fork where the child ends before the parent's tail; purge the parent and verify the child's inherited range and reads remain exact.
- A grandchild fork with multiple children at different ancestor depths; delete one branch and verify the other branch's full closure remains.
- A retired but restorable Session sharing ancestors with a live Session; verify retirement keeps its root and restore is byte-for-byte exact.
- Purge a retired root while another retired root shares its ancestry; retain shared ancestors until the second root is purged.
- Deliberately corrupt `segment_ancestors` in a fixture; GC must detect mismatch and roll back without deleting graph data.
- Inject failure after permit insert, after each frame deletion, after each of the two ancestry-index deletion roles, after Segment deletion, before terminal fence insert, and during COMMIT. Every pre-commit failure leaves the original root and graph intact.
- Fork/append/restore/purge races across independent processes with deterministic barriers around writer acquisition and commit. Assert exactly the serialization outcomes above.
- Attempt direct SQL deletes without a permit, with a permit for another Segment, and with a stale operation ID; all must fail.
- After every test, run `PRAGMA foreign_key_check`, verify closure equality against a recursive traversal of `parent_segment_uuid`, and compare unaffected Session event streams byte-for-byte.
- Run on Linux, macOS, and Windows. Include restart-after-SIGKILL cases; in-process exception tests alone do not establish crash safety.

Do not implement incremental or background GC until the single-transaction correctness baseline passes these graph and process-race tests. If GC later becomes chunked across commits, introduce an explicit durable `purging` state and a persisted candidate/work cursor; each chunk must remain invisible to reads and must resume idempotently after restart. Never expose a partially reclaimed graph as a valid live or restorable Session.
## SQLite graph integrity diagnosis and repair boundaries

The fixed upstream SQLite implementation treats `segments.parent_segment_uuid` / `parent_end_seq` / `base_seq` as the primary immutable graph edges. `segment_ancestors` is a derived transitive range index populated by the `segments_index_ancestors` AFTER INSERT trigger. Read paths use the index to locate candidate ancestors, but also walk parent metadata and validate offsets. Therefore SQLite's page-level integrity checks are necessary but not sufficient to establish Session graph correctness.

### Integrity layers (run in this order)

1. **Database structure:** verify the expected `application_id`, schema version, exact table/index/trigger definitions, `PRAGMA quick_check` (or `integrity_check` for a full audit), and `PRAGMA foreign_key_check`. Any non-`ok` result blocks lifecycle operations and GC.
2. **Row-level constraints:** validate every Segment row's root/non-root shape, nonnegative sequence values, non-self parent, existing parent, and `child.base_seq = parent.base_seq + child.parent_end_seq`. Validate each trace tail exists and its inherited count and header identity are well-formed.
3. **Parent graph:** walk every trace tail and every retained lifecycle root through parent edges with a visited set. Reject cycles, missing parents, invalid prefix bounds, impossible sequence arithmetic, and any path that does not terminate at a root Segment. A cycle in an immutable parent graph is corruption even if SQLite accepts the rows.
4. **Frame ranges:** for each Segment, order frames by `start_seq`; require valid positive intervals, no overlap, and exact coverage of every logical range that a trace or descendant claims to read. A gap outside every retained logical range may be unreachable garbage, but it must not be silently treated as valid history. Check `frame.start_seq` against the Segment's local coordinate system and ensure the frame end does not exceed the Segment's committed local event extent.
5. **Derived ancestry index:** recompute expected `(descendant, ancestor, end_seq)` rows from the parent graph and compare exact set equality with `segment_ancestors`. This checks missing rows, extra rows, incorrect range values, and rows whose endpoint is not an ancestor.
6. **Cross-Session consistency:** verify all live trace tails and restorable tombstone roots resolve to complete, readable histories; verify shared ancestors are consistent across every descendant. Do not assume a graph that validates for one trace validates for all roots.

### Frame continuity and event-count rules

Frames are inserted consecutively within a Segment by the provider append path: the next frame starts at the previous frame's end, beginning at the supplied local start. A forked child Segment has its own local coordinate space beginning at zero; `base_seq` maps that local space to the inherited global sequence. `parent_end_seq` is the exclusive prefix endpoint in the parent. These coordinate systems must not be mixed when validating ranges.

Validation must be range-aware. For a requested logical interval, translate it into each Segment's local interval, collect overlapping frames in order, and require exact coverage with no gap or overlap. This matches the read path's fail-on-incomplete behavior. A full audit should additionally establish that each retained trace's entire claimed event range is covered, not merely the range of the last successful read.

Do not infer the event count solely from `MAX(end_seq)` when validating corruption: a missing leading or middle frame can leave the maximum unchanged. Derive expected coverage from the trace's inherited count, Segment base, parent cut, and all ordered frame intervals; compare both lower and upper boundaries.

### What may be repaired automatically

**Potentially repairable: `segment_ancestors` only.** It is a deterministic derived index if and only if the complete parent graph and all sequence/range metadata have first passed validation. Under an exclusive provider maintenance lock and one `BEGIN IMMEDIATE` transaction, the provider may:

- Snapshot the exact parent graph and current trace/lifecycle roots.
- Recompute the complete expected transitive closure and `end_seq` values from parent edges, detecting cycles and invalid offsets before changing any row.
- Compare expected and actual index contents and record a diagnostic report.
- If the parent graph is valid and the only discrepancy is the derived index, delete and rebuild the entire `segment_ancestors` table in the same transaction (or rebuild into a shadow table and atomically swap only if schema constraints/triggers and foreign keys are preserved).
- Re-read and compare exact set equality, run `foreign_key_check`, verify unchanged Segment/trace/frame row counts and stable identity digests, then commit.

Do not repair a small subset of index rows by guessing which rows are missing. A full deterministic rebuild is easier to reason about and avoids leaving unknown stale entries. Keep the `ancestors_no_update` / `ancestors_no_delete` protections; any repair authorization must be a separate provider-private, row-scoped maintenance permit, distinct from GC authorization. A failed rebuild rolls back to the original index and must leave the provider unavailable for lifecycle mutation until diagnosis.

### What must fail closed (no automatic data rewrite)

- Missing Segment rows, broken parent references, parent cycles, or inconsistent `base_seq` / `parent_end_seq` arithmetic.
- Missing, overlapping, malformed, or out-of-range frame payloads in any retained history.
- Trace tail/header identity mismatch, invalid inherited count, or a trace whose logical range cannot be reconstructed exactly.
- `segment_ancestors` mismatch when the primary parent graph itself is invalid or ambiguous.
- Unexpected schema objects, altered triggers, wrong application ID/version, failed SQLite integrity checks, or foreign-key violations.
- Any uncertainty about whether a committed operation or external marker publication occurred.

Do not synthesize empty frames, truncate a trace to the last readable event, infer missing events from neighboring Sessions, rewrite parent edges, or choose one of multiple conflicting histories. Those actions are data-loss policies, not integrity repairs, and require an explicit separately reviewed recovery/import workflow with operator-visible evidence and backups.

### Startup and runtime behavior

- On startup, perform cheap database and schema checks before exposing the provider. Run full graph/frame/index audit before enabling lifecycle GC; a configurable background audit may supplement but must not replace the pre-GC safety check.
- If only the derived ancestry index is inconsistent and the primary graph validates, mark the provider as maintenance-required and run the deterministic rebuild under exclusive maintenance ownership. Do not serve fork/cut/read/GC paths that rely on the index during repair.
- If any primary graph, frame, or trace invariant fails, mark the provider unhealthy and fail closed. Preserve the database and WAL/SHM files for diagnosis; do not unlink, replace, vacuum, or checkpoint as a purported repair.
- Emit diagnostics with database identity, schema version, affected Session/Segment IDs, invariant name, and operation ID where applicable. Avoid logging frame payloads or sensitive event content.
- After repair, rerun the entire audit and verify byte-identical reads for every retained trace before returning the provider to service.
- Never mutate filesystem routing markers as part of the SQLite repair transaction. Reconcile markers only after the database audit/repair commits, using the separately specified marker recovery protocol.

### Required integrity and repair tests

- Valid chain, fork, bounded-prefix fork, sibling branches, grandchild branches, and shared-ancestor fixtures produce exact closure equality.
- Delete one ancestry row, add an extra row, change one `end_seq`, and attach a valid-looking row to a non-ancestor; each discrepancy is detected.
- Rebuild a corrupted derived index and prove parent rows, trace rows, frame BLOB bytes, event streams, marker bytes, and operation mappings are unchanged.
- Inject process termination during index rebuild; restart observes either the original index or the complete rebuilt index, never a partial closure.
- Parent cycle, missing parent, wrong base sequence, invalid parent cut, trace tail missing, and foreign-key violation all block repair and GC.
- Frame gap at the beginning, middle, and end; overlapping intervals; duplicate starts; invalid codec; truncated payload; and out-of-range frame are detected without rewriting data.
- A trace with a valid `MAX(end_seq)` but a missing interior frame must still fail full coverage validation.
- SQLite `quick_check` success combined with a semantically corrupt parent graph or frame coverage must still fail the application-level audit.
- Two processes racing repair with fork/append/GC: repair owns exclusive maintenance state; mutators wait or fail typed unavailable, and no process observes a half-rebuilt index.
- After any successful repair, run full graph/frame audit, `foreign_key_check`, and byte-for-byte read comparisons for all retained roots on Linux, macOS, and Windows.

Repair policy summary: rebuild only a proven-derived index from a validated primary graph; preserve and quarantine any database whose primary graph or event bytes are ambiguous. Integrity tooling must never convert uncertainty into silent data loss.
## SQLite lifecycle schema rollout: old-process fencing and downgrade policy

The upstream SQLite Provider at the pinned Harness revision checks `application_id` and `user_version` during `SqliteStore.initialize()`. Once initialized, ordinary read/write operations use the open `DatabaseSync` connection and prepared statements; they do not re-check `user_version` before every transaction. Consequently, changing `user_version` to v2 does **not** fence an already-running v1 process. SQLite `BEGIN IMMEDIATE` serializes writers only while the transaction is held; after migration commits, an old process can acquire the writer lock and continue issuing v1 SQL.

### Compatibility matrix

| Process / database combination | Required behavior |
| --- | --- |
| v1 binary starts on v1 database | Supported under the v1 contract |
| v2 binary starts on v1 database | Run the explicit migration only under the maintenance procedure below |
| v2 binary starts on v2 database | Supported after schema, graph, and marker reconciliation checks |
| v1 binary starts on v2 database | Refuse at initialization due to unsupported schema version; leave DB intact |
| v1 process already open when v2 migration starts | Unsupported; migration must not proceed until that process is stopped |
| v1 process resumes after v2 migration | Unsafe; deployment must prevent restart/downgrade until all v2 lifecycle features are disabled and a separately validated downgrade exists |
| v1 and v2 processes concurrently access the same DB | Unsupported; never claim mixed-version compatibility |

### Mandatory offline migration protocol

1. Enter provider maintenance mode at the deployment/orchestration layer. Stop routing new Session work to every process using the database.
2. Drain and close all v1 Session handles, append queues, SQLite connections, and background reconciliation tasks. Wait for process termination, not merely a health-check state or an application-level 'idle' flag.
3. Confirm no old process/container/service can restart against this database during the migration window. A deployment-wide maintenance lock or orchestrator barrier must cover every host sharing the database and its filesystem.
4. Preserve a consistent, recoverable backup of the database and required WAL state using a SQLite-supported backup/snapshot procedure. Do not copy only the main DB file while WAL writers/readers may exist; do not unlink WAL/SHM files.
5. Run migration with the already-specified `BEGIN IMMEDIATE` protocol, revalidating application ID, version, exact schema objects, graph, frames, and foreign keys inside the transaction.
6. Commit schema v2, close the migration connection cleanly, reopen using the v2 implementation, run the full v2 integrity audit, recover lifecycle operations, and reconcile routing markers.
7. Only after all checks succeed, start v2 processes and reopen Session traffic. Keep the deployment barrier until every serving process is confirmed to run the v2-compatible build.
8. If any step fails or the commit outcome is unknown, keep the service in maintenance mode. Reopen and inspect the database state; never start a v1 binary against a possibly migrated database.

The database writer lock is a transaction serialization mechanism, not a deployment-wide process fence. The migration tool cannot reliably discover or stop an old process that holds a connection but is currently idle, nor can it prevent that process from reconnecting after the migration. The deployment layer must establish quiescence.

### Runtime defense in the v2 implementation

- Check schema identity/version on every newly opened connection before preparing lifecycle statements.
- Keep schema migration out of ordinary provider initialization when lifecycle features are enabled; use an explicit administrative migration entry point with a clear maintenance-required result.
- Ensure the v2 implementation refuses unsupported/future schema versions without attempting downgrade, repair-by-recreation, or database replacement.
- Lifecycle-aware operations must validate lifecycle state and generation in the same transaction as their trace/Segment mutation. Do not rely on schema version as per-operation authorization.
- Expose a clear compatibility/maintenance diagnostic so operators can distinguish unsupported schema, maintenance in progress, and corrupt storage.
- Document that all processes sharing a database must run a compatible provider build; a shared DB path does not imply mixed-version safety.

Do not add a purported SQL trigger fence for old processes unless the provider has a proven connection/session identity mechanism that lets new v2 writes be distinguished from old v1 writes. A global trigger that blocks legacy writes would also block legitimate v2 writes; a marker table alone is not a process fence. Likewise, a process-local lock, file-existence check, or SQLite busy timeout cannot prevent an already-open v1 connection from writing after migration.

### Downgrade and rollback policy

Schema v2 is a forward-only lifecycle boundary once lifecycle metadata or destructive operations are committed. There is no automatic v2-to-v1 downgrade.

- Before migration commits, a failed migration transaction must leave a valid v1 schema and rows; after verifying this by reopening, operators may restore v1 service.
- After v2 commits but before any lifecycle operation is enabled, rollback to v1 is still **not automatically supported**. It requires a separately designed and tested reverse migration that proves no v2-only objects, metadata, fences, operation mappings, or trigger semantics are lost. Until then, recover forward with v2 or restore a verified pre-migration backup under a documented data-loss decision.
- After any retire/restore/purge lifecycle operation, do not downgrade to v1. V1 has no semantics for tombstones, operation-generation mappings, purged-ID fences, or GC authorization. Starting v1 could resurrect retired identities, ignore fences, or mutate graph data without lifecycle admission.
- Never downgrade by dropping v2 tables, setting `user_version=1`, deleting triggers, copying only the main database file, or recreating an empty database.
- A backup restore is a disaster-recovery action with an explicit recovery point and possible loss of post-backup writes; it is not a schema downgrade. Restore only after all processes are stopped and the DB/WAL state is consistent.

### Mixed-version and downgrade test requirements

- Keep a v1 connection open across a simulated migration attempt; prove the migration procedure refuses to run until the process is stopped. The test harness must model deployment quiescence rather than assume `BEGIN IMMEDIATE` fences future old writes.
- After v2 migration, start a fresh v1 process and verify it refuses with the unsupported-schema error without changing DB bytes, schema objects, WAL, markers, or lifecycle tables.
- Demonstrate why an already-open v1 process is unsafe: a test-only legacy writer can issue a valid v1 append after the v2 migration lock is released unless the deployment barrier keeps it stopped. This is a negative compatibility test, not a supported runtime mode.
- Start multiple v2 processes after migration and verify concurrent lifecycle operations serialize correctly under the provider's shared DB transaction protocol.
- Inject failure before migration commit and verify v1 restart succeeds with unchanged logical contents; inject ambiguous commit and verify the migration tool does not automatically start either version.
- After creating tombstones, operation mappings, fences, and at least one purged Session, verify downgrade is refused and v1 startup is never attempted by the orchestrator.
- Test backup/restore with WAL activity and marker reconciliation; verify the restored DB and markers represent one declared recovery point.
- Verify maintenance barrier release happens only after v2 audit and marker reconciliation succeed; on every failure path the barrier remains held.

Rollout invariant: no lifecycle consumer, guarded GC, or v2-only operation may be enabled until every process sharing the database is on the v2-compatible build, schema migration and integrity audit have completed, and marker reconciliation has succeeded.
