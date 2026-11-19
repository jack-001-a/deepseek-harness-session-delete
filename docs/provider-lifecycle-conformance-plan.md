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
