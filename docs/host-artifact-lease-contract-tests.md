# Host artifact lease contract test specification

- Status: **acceptance specification only**; no Host integration test is implemented here.
- Depends on: PR #13 Host-native lease ADR and PR #14 provider compatibility matrix.
- Target: a future provider-owned artifact lease / tombstone capability.
- Required evidence: two or more independent, real DeepSeek Harness processes using the shipped persistence provider.

## 1. Purpose and acceptance boundary

This specification defines the evidence required before Session Delete may claim that delete, restore, purge, retention cleanup, or crash recovery are coordinated with native Harness writers.

The test subject is the complete integration boundary: production Harness lifecycle, production JSONL persistence provider, provider-owned artifact lease/tombstone API, and the Session Delete transaction coordinator.

A passing test must demonstrate exclusion across independent OS processes. Separate provider objects in one process, mocked Cordis contexts, and plugin-only filesystem-lock tests are not Host integration evidence.

Until this suite exists and passes, the current guarantee remains limited to cooperating plugin instances. The cases below are acceptance criteria, not a report that the capability or tests already exist.

## 2. Required test topology

### Processes

Use a controller plus at least two child processes:

- **Controller:** creates an isolated temporary store, seeds fixture data, starts participants, coordinates barriers, injects abrupt termination, and verifies final state.
- **Writer process:** starts a real Harness instance, opens a real session write handle, emits identifiable events, and reports lifecycle milestones over IPC.
- **Lifecycle process:** starts a second real Harness instance and invokes the production Session Delete operation or provider lease API.
- **Competing process:** when required, attempts write-open, create/materialization, restore, or purge from a third process.

Participants must not share an in-memory Harness context, provider instance, file descriptor, lock object, or session handle. Share only the isolated store path, Session ID, immutable configuration, and explicit IPC messages.

### Deterministic coordination

- Use IPC barriers and acknowledgements (READY, LEASE_ATTEMPTED, WRITE_QUEUED, CLOSE_STARTED, CLOSE_RESOLVED, OPERATION_COMMITTED), not timing-only sleeps.
- Bound every barrier and operation. A timeout is a failure with process output and state snapshots; it is never permission to force-unlock or remove a lock file.
- Use unique Session IDs and isolated store roots. Never run concurrent cases against the same ID.
- Record PID, process start identity where available, hostname, provider identity/version, platform, Node version, Session ID, operation phase, and transaction ID.
- Use test-only fault injection that delegates to the real provider. It must not replace the lease with an in-memory mutex, fake semaphore, or mock lock file.
- If a stable real Harness fixture cannot be built in CI, mark the integration lane unavailable with a tracked prerequisite. Do not replace it with mock-only tests and report success.

## 3. Contract invariants

- **I1 — Stable exclusion identity:** one Session ID has one exclusion identity across live, staging, trash, restore, and retirement locations. Path or inode changes must not create a second independently acquirable lease.
- **I2 — Writer drain:** lease acquisition cannot resolve while a writer owns the session. After close resolves, all accepted writes and the mutation chain are durable; the final accepted event batch is neither lost nor duplicated.
- **I3 — No mutation on contention:** if another process owns the writer lease, lifecycle operations do not move, truncate, replace, or remove the log, coordination state, trash artifact, or manifest.
- **I4 — No split brain:** a process holding an old descriptor/inode cannot coexist with a new writer that acquired a different lock identity for the same Session ID after rename, copy, promotion, or lock-path recreation.
- **I5 — Evidence-based recovery:** recovery uses durable transaction state and verified source/target contents. Absence of a log, lock file, manifest, or marker alone does not prove commit.
- **I6 — Safe retirement:** purge cannot unlink provider-owned coordination state while a lease is active. Permanent retirement requires a provider-owned operation that excludes new opens/creates.
- **I7 — Fail closed:** unsupported providers reject operations requiring the capability before destructive filesystem mutation. Support is not inferred from locate(), open('write'), package version, provider name, or private lock files.
- **I8 — Separate workspace boundary:** a session artifact lease is not cross-process serialization for workspace membership, pin, archive, or projection-cache registries unless a separate Host contract guarantees it.

## 4. Required automated cases

The identifiers below are stable test IDs. Every case runs against the real provider and independent processes unless marked provider-unit.

### A. Writer ownership and close

| ID | Interleaving | Required assertions |
|---|---|---|
| LEASE-001 | A holds a materialized session write handle; B requests artifact lease. | B remains pending or returns typed contention; no destructive operation starts; bytes and metadata remain unchanged. |
| LEASE-002 | A queues multiple writes, including a uniquely identifiable final batch, then begins close; B requests lease during drain. | B cannot acquire before close resolves; all accepted events are durable and appear once. |
| LEASE-003 | A owns write handle; B attempts write-open and C attempts create/materialization. | Both paths obey the same exclusion identity; neither creates a second writable artifact. |
| LEASE-004 | Repeat acquisition after normal close and after abrupt writer process death. | Normal close drains before release. Process-death behavior follows documented provider semantics; no live owner is stolen and no dead owner blocks forever. |
| LEASE-005 | Two processes request the lease simultaneously behind a start barrier. | At most one succeeds; the loser receives typed contention. |

### B. Delete and live-writer races

| ID | Interleaving | Required assertions |
|---|---|---|
| DELETE-001 | A holds native writer; B invokes delete-to-trash. | Delete aborts/defer before manifest or artifact mutation; live log, session directory, and trash index remain unchanged. |
| DELETE-002 | B owns artifact lease; A attempts write-open and C attempts create while delete runs. | All new writer/create attempts are excluded until commit/release; no second writer appears at the original path. |
| DELETE-003 | Pause delete after lease acquisition but before moving data; attempt competing write-open. | Competing open cannot acquire; lease remains bound to the same Session ID. |
| DELETE-004 | Cross-volume copy, verify, promote, then source cleanup; attempt competing open at every boundary. | Writer remains excluded throughout; source is removed only after target verification; provider coordination state is not replaced or unlinked without provider authorization. |
| DELETE-005 | POSIX: hold writer handle while a fault-injection test renames the containing directory, then create a directory at the old path. | Reproduce the historical inode/path split if the API permits it. A conforming API must prevent a second writer from acquiring a distinct identity. |
| DELETE-006 | Delete a session whose log has never been materialized. | Provider behavior is explicit. Operation fails closed unless artifact capability supports this state; do not assume open('write') can lease a missing log. |

### C. Restore and absent-artifact races

| ID | Interleaving | Required assertions |
|---|---|---|
| RESTORE-001 | Log is in trash and absent live; B requests restore lease while C attempts create/materialization. | Provider arbitrates by stable Session ID despite absent live log; exactly one lifecycle owner proceeds. |
| RESTORE-002 | B owns restore lease and stages/promotes log; C attempts write-open after target directory creation but before commit. | C remains excluded; no new lock identity is created at the original path. |
| RESTORE-003 | C wins lease or creates a new live artifact before B restore begins. | B does not overwrite/delete C's artifact; trash copy remains and restore accounting stays pending/conflicted. |
| RESTORE-004 | Interrupt after target staging, after promotion, and before manifest/accounting commit. | Recovery distinguishes phases using durable markers and content verification; divergent copies are preserved; no speculative reattach occurs. |
| RESTORE-005 | Target directory exists but has no log; coordination state may exist or be provider-managed. | Restore uses public artifact capability, not direct manipulation of private lock files or guessed Windows semaphore names. |

### D. Purge, retirement, and retention

| ID | Interleaving | Required assertions |
|---|---|---|
| PURGE-001 | A holds native writer while B purges matching trash entry. | Purge cannot delete provider coordination state or a live artifact; it returns contention or uses documented provider retirement. |
| PURGE-002 | B owns provider retirement/tombstone; C attempts open/create during purge. | C is excluded until retirement is durable; post-retirement behavior is a typed retired/not-found result as specified. |
| PURGE-003 | Kill B after tombstone, after trash cleanup, and before final retirement commit. | Reconciliation resumes idempotently; plugin filesystem code does not unlink an active provider lease sentinel. |
| PURGE-004 | Run retention concurrently with writer and explicit restore. | Retention uses the same lifecycle capability; restore and purge cannot both commit for one Session ID. |

### E. Crash-recovery matrix

Abruptly terminate the lifecycle process at each durable boundary, then start a fresh Harness process and run production reconciliation.

| ID | Kill point | Required post-restart result |
|---|---|---|
| CRASH-001 | Before transaction marker is durable. | No artifact mutation is assumed; original state remains authoritative. |
| CRASH-002 | Marker durable, before staging. | Recovery recognizes an unstarted transaction and safely retries or aborts. |
| CRASH-003 | During cross-volume copy. | Partial staging is not promoted; source remains authoritative. |
| CRASH-004 | Copy complete, before verification. | Source and staging remain; recovery verifies before promotion. |
| CRASH-005 | Verification complete, before promotion. | Only verified staging may be promoted while lifecycle ownership is held. |
| CRASH-006 | Target promoted, source still present. | Recovery compares complete content and transaction identity; source is removed only when equivalence is proven. |
| CRASH-007 | Source removed, manifest/accounting pending. | Recovery completes accounting idempotently and does not touch a changed artifact. |
| CRASH-008 | Restore target promoted, trash artifact still present. | Recovery verifies both copies and cleans trash only when transaction identity and content match. |
| CRASH-009 | Restore committed, before workspace reattach. | Accounting retries; reattach success is not claimed prematurely. |
| CRASH-010 | Purge after tombstone, before physical cleanup. | ID remains retired/excluded; cleanup is retryable and idempotent. |

For each crash case assert transaction ID, manifest phase, provider lease/tombstone state, source/target existence, content hashes, and workspace accounting outcome. Preserve ambiguous artifacts; never choose authority using mtime or file size alone.

### F. Platform and provider compatibility

| ID | Platform/provider | Required assertions |
|---|---|---|
| PLATFORM-001 | POSIX JSONL provider. | Verify actual flock behavior and lock-file inode identity; rename/unlink/recreate cannot permit split-brain acquisition. |
| PLATFORM-002 | Windows JSONL provider. | Verify real named kernel semaphore behavior across processes; prove stable identity across supported lifecycle operations without assuming POSIX inode semantics. |
| PLATFORM-003 | Each supported Node LTS. | Run process-level contract tests on the supported Node matrix and record runtime/provider versions. |
| PROVIDER-001 | Provider advertises artifact lease. | Full contract suite passes before destructive integration is enabled. |
| PROVIDER-002 | Provider lacks artifact lease. | Delete/restore/purge fail before filesystem mutation; live and trash artifacts remain unchanged. |
| PROVIDER-003 | Provider advertises capability but reports unsupported at runtime. | Fail closed with actionable diagnostic; no plugin-lock fallback. |
| PROVIDER-004 | Lease acquisition returns contention or I/O error. | Preserve typed distinction and retry semantics; permission errors are not treated as stale ownership. |

### G. Workspace accounting boundary

| ID | Interleaving | Required assertions |
|---|---|---|
| ACCOUNT-001 | Two Harness processes mutate membership/pin/archive while one owns session artifact lease. | Record actual Host behavior. Do not credit the session lease with workspace-registry serialization. |
| ACCOUNT-002 | Artifact delete commits, then workspace accounting fails. | Artifact transaction stays committed; accounting remains pending/retryable; retry does not repeat file movement. |
| ACCOUNT-003 | One process mutates workspace while the other has stale in-memory state. | Reconciliation must not overwrite newer external state from stale memory. If Host lacks cross-process registry transactions, document the gap. |

## 5. Fault-injection requirements

The future integration must expose test-only injection at semantic boundaries:

- after provider lease acquisition;
- after durable transaction marker;
- before/during/after staging copy;
- after copy completion and after content verification;
- after atomic promotion;
- before/after source-generation cleanup;
- before/after restore manifest commit;
- before/after tombstone or retirement commit;
- before/after workspace accounting and projection-cache cleanup.

Injection must not bypass the real provider lease. The controller must terminate child processes abruptly so cleanup handlers do not run.

## 6. Test evidence and diagnostics

Retain for every run:

- test ID and scenario parameters;
- OS, filesystem type where detectable, Node/Harness/provider versions;
- process IDs and exit codes;
- IPC timeline with monotonic timestamps;
- operation and transaction IDs;
- provider capability declaration and typed errors;
- before/after directory listings and content hashes, not raw session contents;
- lease state exposed by supported provider diagnostics;
- crash point and recovery outcome.

A timeout, mock-only run, inability to observe the real lease, or silently skipped platform is not a pass.

## 7. CI rollout and release gate

1. **Provider contract lane:** lease contention, close-drain, absent-artifact, and process-death tests against the real provider on Linux, macOS, and Windows.
2. **Harness integration lane:** delete/restore/purge and crash matrix with two real Harness processes on each supported platform.
3. **Fault-injection lane:** deterministic crash points and cross-volume staging on separate volumes where CI permits. If a second volume is unavailable, report that case as untested; same-volume rename is not a substitute.
4. **Provider compatibility lane:** capability-present and capability-absent behavior for every provider supported by the plugin.
5. **Release gate:** do not enable or advertise Host-native destructive-operation protection until all required cases pass for the exact provider/platform combination. Unsupported providers remain fail-closed.

## 8. Current implementation status

| Item | Status |
|---|---|
| Plugin-only lock tests | Existing tests cover independent Node processes, symlink aliases, and stale-owner recovery. |
| Real Harness process fixture | Not established by current plugin tests. |
| Real JSONL provider lease contention tests | Not implemented here. |
| Cross-process close-drain final-event test | Not implemented here. |
| Artifact lease for temporarily absent session | No public capability verified. |
| Delete/restore/purge crash matrix with two Harness processes | Not implemented here. |
| POSIX and Windows provider contract matrix | Not implemented here. |
| This document | Acceptance specification only. |

The next implementation prerequisite is a supported Harness integration fixture plus the provider-owned artifact lease/tombstone API. Until both exist, do not add runtime lease integration or relax the operational warning in the compatibility matrix.
