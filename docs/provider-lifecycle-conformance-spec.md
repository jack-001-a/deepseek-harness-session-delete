# Provider lifecycle executable conformance specification

- Status: proposed acceptance specification; no provider implementation or conformance pass is claimed.
- Parent: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- Companion plan: [Provider lifecycle conformance and implementation plan](./provider-lifecycle-conformance-plan.md)
- Reviewed upstream Harness revision: `2e39e70496aa02986ca6a820c5d497e816b69d7e`

## 1. Purpose and normative language

This document turns the lifecycle contract into executable acceptance criteria for JSONL and SQLite. The shared scenario suite MUST assert identical externally observable semantics. Provider-specific suites MAY use different fixtures and fault injection, but MUST preserve the shared outcomes.

The words MUST, MUST NOT, SHOULD, and MAY are normative. A skipped, flaky, mocked, or platform-excluded test is not a pass. A provider is not lifecycle-capable until every required gate passes on Linux, macOS, and Windows.

The suite tests provider behavior through public persistence/lifecycle APIs and explicitly approved test hooks. It MUST NOT implement the behavior under test in plugin code, directly mutate provider-private storage to simulate success, or treat a fake-provider pass as evidence of built-in provider conformance.

## 2. Test harness contract

### 2.1 Process topology

Each multi-process case starts two independently initialized Harness worker processes against the same provider root. The harness parent process acts as the controller: it owns barriers, captures structured events, and may terminate either worker. The controller is not a third provider process and does not share worker memory. Processes MUST NOT share in-memory locks, service instances, or mutable test state.

Every event record emitted by the harness contains:
- case ID and monotonically increasing controller event number;
- process role and PID;
- operation ID (never secret token bytes);
- public Session ID plus test-only incarnation/generation identifiers where available;
- barrier name and outcome category;
- monotonic timestamp for diagnostics only.

Ordering assertions use controller barriers and durable observations, not wall-clock sleeps. Timestamps MUST NOT be used as the correctness oracle.

### 2.2 Deterministic barriers

Required barrier points:
- before and after admission-gate acquisition;
- before and after writer-lease acquisition;
- after durable intent append/transaction commit;
- before and after artifact rename/promotion;
- before and after parent-directory sync where applicable;
- before and after terminal journal append / SQLite commit;
- after provider commit but before caller response;
- before final flush, after flush, before close completion;
- after read descriptor/snapshot acquisition and before subsequent lazy reads.

A barrier MUST be releasable by the controller and MUST have a watchdog. A timeout is a test failure with captured process stacks/logs, not a pass or an inferred `busy` result.

### 2.3 Fault injection

Inject failures at every durable boundary, including:
- process kill (SIGKILL on POSIX; forced process termination on Windows);
- short write, EINTR, disk-full/write failure;
- file sync and containing-directory sync failure;
- SQLite busy/locked, transaction rollback, and ambiguous commit response;
- rename/no-replace failure, destination collision, and parent sync failure;
- malformed/truncated journal tail and complete-record checksum failure;
- permission/ACL change, symlink substitution, and provider-root identity mismatch.

The test must distinguish a known pre-commit failure, a committed operation with lost response, and an outcome-unknown condition. Never map all three to a generic failure.

### 2.4 Fixture hygiene

Each case uses a unique temporary provider root and records its root identity. Cleanup runs only after assertions and evidence capture. A cleanup failure is reported separately and MUST NOT erase evidence from a failed case. No test may use a shared developer or production directory.

## 3. Canonical assertions

Every shared case MUST assert the applicable items below:

1. **Identity:** every result and handle remains bound to the admitted provider root, Session ID, incarnation, and generation.
2. **History:** surviving Sessions expose byte/logically equivalent event histories, including ordering and metadata required by the public API.
3. **Visibility:** list/stat/open/read agree with the lifecycle state at the defined linearization point.
4. **No resurrection:** retired or purged identities cannot reappear through create races, legacy import, stale indexes, retries, or restart.
5. **Idempotency:** retrying the same operation ID and identical fingerprint returns the original result; reusing it with a different kind/fingerprint returns `operation_id_conflict`.
6. **Isolation:** operations on unrelated Session IDs preserve exact history and remain usable unless provider-root-wide corruption is detected.
7. **Durability:** an acknowledged commit survives process restart under the documented storage durability model.
8. **Failure typing:** outcomes are one of the documented typed results; ambiguity is `outcome_unknown`, never guessed success or absence.
9. **Fail closed:** corruption, identity mismatch, unsupported capability, or ambiguous backing continuity never triggers destructive fallback.
10. **Resource bounds:** recovery and cleanup obey configured worker, file-descriptor, memory, and journal limits.

## 4. Shared scenario catalogue

Each case is run against every built-in provider and on all three operating systems. Provider adapters map the shared fixture operations onto their public API; they do not weaken assertions.

| ID | Scenario | Controlled interleaving | Required result |
|---|---|---|---|
| S-001 | Unsupported provider | Capability absent; request retire | `unsupported`; no file, DB, or plugin-side destructive mutation |
| S-002 | Legacy subclass compatibility | Instantiate provider subclass without override | Source-compatible; capability is undefined |
| S-003 | Active writer drain | A holds write handle and queues events; B requests retire | B waits or returns typed `busy`; no acknowledged event lost |
| S-004 | Writer admission race | B owns lifecycle gate; A requests write-open | A cannot cross the fence; after retire commit, write-open is rejected |
| S-005 | Append vs close | A queues append while close begins | Either append is included before close completes or rejected; never commits after successful close |
| S-006 | Flush vs close | Pause after durable flush before close response; kill A | Retry/inspect returns the original durable outcome; no duplicate append |
| S-007 | Double close | Invoke close concurrently twice | Both calls converge on one close outcome; lease released exactly once |
| S-008 | Delayed callback | Schedule callback, complete close, then release callback | Callback cannot append or reopen by Session ID |
| S-009 | Create reservation vs retire | Pause create after durable reservation before materialization; request retire | Operations serialize; no phantom absence, duplicate incarnation, or orphan publication |
| S-010 | Lost create response | Kill caller after provider create commit | Same creation operation ID recovers original identity/result |
| S-011 | Read admission before fence | Acquire pinned descriptor/snapshot, then retire | Existing admitted read may finish under documented pinned-read model |
| S-012 | Read admission after fence | Commit retire, then open/read | New read admission is rejected with typed state outcome |
| S-013 | Incremental read re-admission | Read first chunk, retire, request next chunk | Later chunk rejected; no silent generation switch |
| S-014 | Lazy multi-file read vs purge | Admit read that would open second file later; race purge | Purge waits for pin or later read fails; no missing-file ambiguity or cross-generation data |
| S-015 | Retire lost response | Kill caller after provider commit before response | Same operation ID / inspect operation returns exact original token |
| S-016 | Retire retry | Retry identical request after terminal retirement | Original token and result returned |
| S-017 | Operation ID conflict | Reuse operation ID with different kind/fingerprint | `operation_id_conflict`; no second mutation |
| S-018 | Stale revision | Submit operation with old expected revision | `revision_conflict`; no mutation |
| S-019 | Restore while absent | Retired artifact absent; restore exact token | Original history becomes live exactly once in next generation |
| S-020 | Restore lost response | Kill caller after restore commit | Retry/inspect converges on same new generation |
| S-021 | Restore destination collision | Place unrelated destination identity before restore | Fail closed; never overwrite or adopt collision |
| S-022 | Old token after restore | Reuse prior retirement token after successful restore | No effect on live generation |
| S-023 | Re-retire after restore | Retire restored generation with new operation ID | New token binds next generation; old token remains historical |
| S-024 | Purge vs admission | Pause purge after durable fence; race read/write/create | No operation crosses the purge fence or resurrects identity |
| S-025 | Purge lost response | Kill caller after terminal purge commit | Retry returns original terminal result |
| S-026 | Same-ID recreation | Purge old incarnation, then create same public ID | New incarnation; all old tokens/handles/callbacks remain stale |
| S-027 | ABA stale callback | Delay old-generation purge/cleanup until new incarnation exists | Callback cannot address new incarnation |
| S-028 | Two-process same-session recovery | Both processes start recovery for same journal | One recovery owner; other observes converged result |
| S-029 | Different-session recovery | Corrupt one Session journal; recover another healthy ID | Corrupt ID isolated; healthy ID remains usable |
| S-030 | Provider-root corruption | Corrupt root identity / metadata namespace | Provider-wide lifecycle readiness disabled; no fallback |
| S-031 | Stale global index | Delete or corrupt rebuildable index | Rebuild from authoritative journals; index never authorizes deletion |
| S-032 | Journal torn tail | Truncate final record at every byte boundary | Only provably incomplete final tail may be truncated under exclusive lock |
| S-033 | Complete journal corruption | Damage checksum/sequence/hash chain in complete record | `corruption`; preserve evidence; no scan-forward or empty replacement |
| S-034 | Journal append ambiguity | Kill around append and sync, retry same operation | Recover exact committed/not-committed/unknown state without new operation ID |
| S-035 | Recovery resource bound | Seed many journals and bounded worker configuration | Worker/fd/memory limits respected; progress is fair and resumable |
| S-036 | Backup consistency | Restore partial combinations of ledger, artifacts, quarantine, root identity | Inconsistent backup fails closed; no inferred reconstruction |
| S-037 | Plugin outbox handoff | Provider commit precedes plugin token/projection persistence; restart plugin | Operation-specific recovery repairs projection without duplicate mutation |
| S-038 | Provider replacement | Replace active Cordis persistence service between discovery and operation | Cached capability rejected unless source identity still matches active service |
| S-039 | Mixed-version process | Keep v1 process alive while v2 lifecycle is enabled in test environment | Deployment gate rejects enablement; v2 must not claim cross-version safety |
| S-040 | Cancellation boundaries | Cancel before intent, after intent, and after commit | Only proven pre-commit cancellation returns `cancelled_before_commit`; later ambiguity is recoverable |

### 4.1 Operation-ledger retention and exact recovery

The public capability contract includes an exact `inspectOperation(id, operationId)` query. `inspectById(id)` reports only the current lifecycle state for a public Session ID and MUST NOT be used as a substitute for recovering a particular committed operation after same-ID restore/re-retire cycles.

Operation-ID deduplication records, or compact authoritative tombstones containing the request fingerprint and committed outcome, MUST outlive every possible caller retry. Compaction MUST NOT make an old operation ID appear unused. Reusing a retained operation ID with a different request fingerprint MUST continue to return `operation_id_conflict`.

Add the following required scenario:

| ID | Scenario | Controlled interleaving | Required result |
|---|---|---|---|
| S-041 | Operation ledger compaction and stale retry | Commit an operation, compact provider metadata, then retry its original operation ID; also retry after a later restore/re-retire of the same public ID | Original result or terminal outcome is recovered; conflicting reuse is rejected; no newer incarnation is affected |

## 5. JSONL-specific suite

These tests verify the provider-owned filesystem protocol, not plugin trash behavior.

| ID | Test | Required invariant |
|---|---|---|
| J-001 | Stable lock identity across artifact rename | Coordination object remains in non-movable provider namespace |
| J-002 | Legacy in-directory lock migration | No lock file is moved/unlinked as a bridge; offline barrier is enforced |
| J-003 | No-follow open and ownership validation | Symlink/path substitution and foreign-owned files fail closed |
| J-004 | Same-volume no-replace quarantine | Retire cannot overwrite an existing quarantine destination |
| J-005 | Parent directory durability | Both affected parent directories are synced before terminal commit |
| J-006 | New journal/shard creation | File contents and containing directory entry are durable before acknowledged use |
| J-007 | Partial purge resume | Repeated recovery deletes only the fenced generation and converges |
| J-008 | Per-Session corruption isolation | One bad journal does not block healthy independent Session journals |
| J-009 | Journal identity binding | Path-encoded ID, envelope Session ID, incarnation, and root identity must agree |
| J-010 | Token recovery | Lost response can recover original token bytes from protected durable metadata |
| J-011 | Lock process death | Kernel releases lease after owner death; successor validates durable state before proceeding |
| J-012 | Cross-platform semantics | POSIX and Windows implementations satisfy the same external admission and recovery results |

## 6. SQLite-specific suite

SQLite tests MUST preserve the shared database and shared Segment graph semantics. They MUST NOT assume a Session owns a disjoint set of rows.

| ID | Test | Required invariant |
|---|---|---|
| Q-001 | Schema v1 to v2 migration | Exact v1 schema/data validated; migration transactional; version marker written last |
| Q-002 | Ambiguous migration commit | Reopen and inspect schema/version; never blindly rerun destructive migration |
| Q-003 | Lifecycle transaction atomicity | Tombstone/root transfer and operation mapping commit atomically |
| Q-004 | Restore root transfer | Tombstone root becomes trace root without changing logical history |
| Q-005 | Purge reachability | Reclaim only segments unreachable from all live and retained tombstone roots |
| Q-006 | Shared ancestor preservation | Purging one fork never deletes ancestor frames still required by another Session |
| Q-007 | Descendant preservation | Purging parent does not destroy child/grandchild histories |
| Q-008 | Bounded fork cut | Ancestry ranges remain exact when child forks at an ancestor prefix |
| Q-009 | Delete trigger authorization | Only provider-owned GC transaction can delete protected rows; no broad trigger removal |
| Q-010 | FK integrity | Foreign keys remain enabled and integrity checks pass after each injected boundary |
| Q-011 | Read snapshot consistency | Lifecycle state, trace head, and selected frame bytes come from one coherent snapshot |
| Q-012 | Read vs purge | In-flight materialized read follows documented pre-barrier semantics; later reads reject |
| Q-013 | Routing marker reconciliation | Marker and DB lifecycle state converge; marker-only or row-only ambiguity fails closed |
| Q-014 | Legacy JSONL fallback fence | Retired ID cannot reappear through fallback or import |
| Q-015 | Legacy import vs retire | Import and lifecycle gate serialize; no post-fence trace publication |
| Q-016 | Unrelated Session preservation | Retire/restore/purge leaves unrelated traces and histories byte/logically unchanged |
| Q-017 | WAL crash recovery | Kill around commit/checkpoint; database reopens with consistent lifecycle state |
| Q-018 | Logical vs forensic purge | API/documentation never claims secure erasure from row deletion alone |
| Q-019 | SQLite total lock order | Barrier-controlled processes prove lifecycle gate -> DB-scoped Session lease -> legacy-artifact/creation lease -> SQLite transaction, then reverse-order release (artifact/creation before DB-scoped); no concurrent/out-of-order release, leaked lease, or deadlock across create, write-open, legacy import, and retire |
| Q-020 | Busy/unknown commit | Busy is retryable; ambiguous commit is inspected/recovered, never assumed rolled back |

## 7. Test result and evidence format

Every run publishes a machine-readable manifest with:
- source commit and provider build identifier;
- OS, architecture, runtime version, filesystem/database mode;
- case ID, attempt number, result, skip reason (if any);
- fault/barrier schedule and actual observed order;
- expected and observed typed outcome;
- before/after logical-history digests for all affected Sessions;
- recovery action and final lifecycle state;
- artifact references for logs and crash evidence, with token bytes and user event payloads redacted.

A case is **PASS** only when all assertions complete. **FAIL** means an assertion or watchdog failed. **SKIP** means the environment could not execute it and does not count toward the release gate. **FLAKY** is treated as FAIL until the nondeterminism is explained and the test is deterministic.

CI summary MUST report counts by provider, OS, runtime, and suite. A green aggregate cannot hide a skipped required platform or provider-specific suite.

## 8. Release gate checklist

- [ ] Shared suite S-001 through S-041 passes for JSONL and SQLite on Linux, macOS, and Windows.
- [ ] JSONL suite J-001 through J-012 passes on all supported platforms.
- [ ] SQLite suite Q-001 through Q-020 passes on all supported platforms.
- [ ] No required case is skipped, flaky, mocked, or replaced by a unit-only approximation.
- [ ] Process-kill recovery passes at every durable boundary.
- [ ] Backup/restore and mixed-version rollout gates are tested operationally.
- [ ] Unsupported providers return typed `unsupported` without mutation.
- [ ] API docs and plugin UX accurately distinguish logical deletion from forensic erasure.
- [ ] Maintainer review accepts the API seam, lock protocol, migration, and failure taxonomy.

Until every item is checked with attached CI evidence, lifecycle capability MUST remain disabled for destructive plugin operations.
