# Provider lifecycle evidence map

- Status: empirical evidence ledger; not an upstream implementation claim
- Contract proposal: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- API proposal: [Provider lifecycle API proposal](./provider-lifecycle-api-proposal.md)
- Acceptance criteria: [Provider lifecycle conformance specification](./provider-lifecycle-conformance-spec.md)
- Real integration prototype: [Session Delete PR #17](https://github.com/jack-001-a/deepseek-harness-session-delete/pull/17)
- Reviewed upstream revision: `deepseek-ai/deepseek-harness@2e39e70496aa02986ca6a820c5d497e816b69d7e`

## Purpose

The lifecycle proposal defines a provider-owned mutation and admission contract. The downstream Session Delete integration prototype now supplies real Host/Provider evidence for the currently available seam. This document connects those observations to the proposed contract without promoting plugin-level behavior into Provider conformance.

The evidence is intentionally split into three levels:

1. **Provider storage behavior** — exercised through the actual upstream persistence service and handles.
2. **Plugin lifecycle behavior** — exercised through the real Session Delete plugin composed into Cordis/AgentLoop/JSONL.
3. **Provider lifecycle capability** — must be implemented and exposed by the upstream provider; plugin behavior cannot substitute for it.

## Reproducible integration evidence

The latest recorded real Harness run is [44681203814](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44681203814), on Session Delete commit `4b2b45698e011d36d78e2b915d87714b3cd62dbc`.

The companion cross-platform workflow [44681203862](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44681203862) passed all nine Linux/macOS/Windows × Node 22/24/26 jobs. This matrix validates the repository's regular CI; the real Harness integration run itself is a Linux integration job, not a nine-cell provider conformance matrix.

The integration manifest artifact was downloaded and inspected. Its ZIP SHA-256 is:

```text
1943cb5871f440d7728a612cf80d35ba859a461086506082fe9dcf1799b80d3e
```

Manifest schema version 2 reports 11 PASS and 4 SKIP, with top-level status `PARTIAL`. The four skips are explicit unsupported-contract outcomes, not passing tests.

## Evidence matrix

| Contract area | Current evidence | Classification | What it does not prove |
|---|---|---|---|
| Cross-process seed and reopen | One real Harness process materializes and closes a Session; a separate composition consumes it | Provider storage PASS | Lifecycle mutation safety |
| Writer exclusion | While a real writer is held, a competing write-open receives `SessionAlreadyOwnedError`; read coexistence is checked | Provider writer-ownership PASS | A delete/restore/purge operation participates in that lease |
| Kernel lease release | The writer owner is terminated with SIGKILL; a successor writer can acquire and close | Provider writer-ownership PASS | Destructive-operation fencing |
| Delete to trash, list, restore, purge | Real plugin operations run against the actual JSONL provider | Plugin lifecycle PASS | Provider-native lifecycle conformance or support for SQLite/third-party providers |
| Committed delete recovery | Process dies after the real artifact move and before plugin workspace accounting; fresh Host startup reconciles | Plugin recovery PASS | Provider-owned atomic retirement or fencing of concurrent writers |
| Restore interruption recovery | Process dies after promotion and before plugin accounting; fresh Host startup reconciles | Plugin recovery PASS | Provider-owned restore transaction |
| Delete copy-staging interruption | Real delete transaction marker is present; child creates a private `.partial` staging copy and is killed before promotion; fresh Host removes the uncommitted trash entry | Bounded plugin recovery PASS | A forced cross-device `rename()` / EXDEV failure or production Provider copy fallback |
| Provider RETIRE / RESTORE / PURGE | Public persistence seam has no lifecycle capability | SKIP: `provider-lifecycle-api-unavailable` | Any Provider-native lifecycle guarantee |
| Purge interruption recovery | Plugin purge has no durable transaction marker/replay contract | SKIP: `purge-recovery-contract-unavailable` | Crash-safe recursive purge |

## Required contract gates still unproven

The real integration evidence does not close the central gap identified by the ADR. In particular, it does not demonstrate:

- an atomic provider-owned admission fence shared by create, pending create, read-open, write-open, close/drain, retire, restore, and purge;
- that retirement waits for or safely refuses an already admitted writer before mutation;
- read-handle generation pinning or rejection of lazy reads after retirement;
- durable provider-owned lifecycle intent, recovery, operation-ID idempotency, and exact lost-response lookup;
- incarnation/generation fencing against stale callbacks and Session ID reuse (ABA);
- JSONL stable coordination identity across quarantine/restore and crash recovery;
- SQLite transactional tombstones and reachability-safe Segment garbage collection;
- provider lifecycle conformance on Linux, macOS, and Windows.

These remain implementation and acceptance gates, not documentation-only assumptions.

## Safety interpretation

Until the upstream provider exposes and passes the lifecycle contract:

1. Keep destructive lifecycle capability unavailable for providers that do not explicitly advertise it.
2. Do not treat the plugin filesystem lock as a substitute for the Provider writer lease or admission gate.
3. Do not manipulate JSONL lock files, move provider-private Session directories, or edit SQLite tables from the plugin.
4. Do not run destructive operations against a live writer based on the current prototype.
5. Keep provider-native lifecycle cases as SKIP; do not relabel plugin-level PASS cases as Provider conformance.
6. Keep purge interruption recovery unsupported until a durable intent/replay protocol exists.

## Next acceptance step

The next meaningful milestone is an upstream-reviewed API contract followed by provider-owned implementation work. The acceptance order should be:

1. Agree on the additive capability and compatibility behavior.
2. Agree on operation identity, idempotency, typed outcomes, and linearization points.
3. Implement the shared admission/fencing protocol in each provider.
4. Implement provider-specific durable lifecycle state and startup recovery.
5. Run the shared multi-process suite and provider-specific fault matrix against real JSONL and SQLite implementations on all supported operating systems.
6. Enable destructive plugin actions only for an active provider instance that advertises the complete capability and has completed recovery.

A green plugin integration run is necessary evidence for the consumer boundary, but it is not a substitute for these provider gates.
