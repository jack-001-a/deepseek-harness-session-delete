# Real Harness integration prototype

This is an **opt-in integration test**, not part of the default `npm test` suite. It runs the actual Session Delete entrypoint inside a real Cordis context composed with the upstream AgentLoop testkit and the shipped JSONL persistence provider.

## Pin and prerequisites

The prototype was designed against DeepSeek Harness commit:

`2e39e70496aa02986ca6a820c5d497e816b69d7e`

Use a checkout of that revision. Install its workspace dependencies and build the host libraries using the repository's documented build workflow. The following package exports must resolve from the Harness workspace:

- `@deepseek-ai/cordis`
- `@deepseek-ai/dsh-agent-loop-testkit`
- `@deepseek-ai/dsh-agent-loop`
- `@deepseek-ai/dsh-session-persistence-jsonl`
- `@deepseek-ai/dsh-session-persistence` (exports the typed `SessionAlreadyOwnedError`)
- `@deepseek-ai/dsh-session`

The testkit mounts the real prerequisite services; AgentLoop and JSONL persistence are loaded as production packages. No fake Cordis context, fake persistence provider, or copied Session Delete helper is used.

## Run

From this plugin checkout:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness npm run test:integration:upstream
```

On PowerShell:

```powershell
$env:DSH_HARNESS_ROOT = 'C:\\path\\to\\deepseek-harness'
npm run test:integration:upstream
```

The Harness checkout must already be built. For the pinned upstream revision, prepare it from the Harness repository root with Node 24.9+ and pnpm 11.28.5:

```sh
pnpm install --frozen-lockfile
pnpm run build:native-system
pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries
```

The last command emits the real Host package libraries, including the Cordis, AgentLoop testkit, and JSONL provider exports consumed by this runner. The script deliberately resolves package exports from that checkout rather than adding Harness runtime packages as dependencies of the distributable plugin. The repository's `upstream-integration` workflow automates this Linux setup against the pinned commit.

## What the prototype exercises

1. A child Node process mounts the real Cordis prerequisites, AgentLoop, and JSONL provider.
2. That process creates a persisted session, appends a minimal completed turn, flushes, closes the write handle, and disposes its Host context.
3. The parent process creates a fresh Host context over the same isolated session root.
4. It loads the real Session Delete `apply()` entrypoint and checks capability discovery.
5. A second real Host process opens the session for write. The parent proves a read handle can coexist, then verifies a competing write-open rejects with the exported `SessionAlreadyOwnedError` class.
6. The controller sends `SIGKILL` to the live writer process. The parent then successfully opens and closes a successor write handle, proving the provider's kernel lease is released on process death.
7. Only after the writer probe has ended does the plugin perform trash delete and list the trash.
8. It disposes that Host context, opens a fresh Host composition over the same store, dispatches the real Cordis `ready` event with `ctx.parallel('ready')`, and observes the plugin's committed-delete recovery result.
9. It restores the session, verifies it through the real provider, and deletes it again.
10. A separate real Host child writes the `.restoring` marker and promotes the trash artifact back to its original path.
11. The controller kills that child with `SIGKILL` at the explicit post-promotion stdout barrier, before graceful Host disposal, accounting replay, or marker cleanup.
12. A fresh Host composition's Cordis `ready` listener recovers the interrupted restore and the real provider verifies the session; the runner then deletes and purges it.


This proves a useful first integration seam: **a session materialized by one real Harness process can be consumed by the plugin running in another real Harness composition**, with a fresh provider instance and real on-disk artifacts.

## Verified result

The first successful real-Harness run completed on 2026-11-19:

- [Integration workflow run 44509694976](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44509694976) — passed.
- [Expanded integration workflow run 44511034933](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44511034933) — passed, including committed-delete startup reconciliation through a fresh Host context.
- [Cordis ready-event integration run 44512014722](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44512014722) — passed on the ready-listener revision; committed-delete reconciliation was triggered and awaited through `ctx.parallel('ready')`.
- [Regular CI run 44509694956](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44509694956) — all 9 Linux/macOS/Windows × Node 22/24/26 jobs passed.
- [Latest-head regular CI run 44514626100](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44514626100) — all 9 Linux/macOS/Windows × Node 22/24/26 matrix jobs passed.
- [Cross-process writer ownership integration run 44517187039](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44517187039) — passed on commit `a7404d2`; all 97 unit tests passed and the real runner verified read coexistence, typed `SessionAlreadyOwnedError`, `SIGKILL` lease release, ready-hook recovery, and purge.
- [Cross-process writer ownership CI run 44517187020](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44517187020) — all 9 Linux/macOS/Windows × Node 22/24/26 matrix jobs passed.
- [Latest-head real Harness integration run 44514626145](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44514626145) — passed on the controller-driven `SIGKILL` revision; pinned upstream dependency install, native addon and Host library builds, all 97 unit tests, and the real Cordis/AgentLoop/JSONL integration runner succeeded.
- [Earlier real Harness integration run 44512780369](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44512780369) — passed with the modeled post-promotion interrupted-restore scenario, before the controller-driven `SIGKILL` barrier was added.
- Plugin unit suite — 97 passed, 0 failed.
- Real integration — passed using the pinned Harness revision, with a separate-process seed/close, committed-delete recovery through a fresh Host `ready` listener, restore, a simulated post-promotion interrupted restore recovered through another fresh Host `ready` listener, and final delete/purge. The interrupted-restore assertion returned `{ deleted: 0, restored: 1, preserved: 0 }`.

The runner additionally verifies the pinned JSONL provider's cross-process writer-ownership contract: while a child process holds a real write handle, a parent-process read succeeds and a competing write-open rejects with `SessionAlreadyOwnedError`; after the controller kills the owner with `SIGKILL`, the parent can acquire and close a successor writer. This tests provider-level writer exclusion and kernel release on process death only. It does not test or imply that Session Delete can fence a live writer during destructive mutation. The runner dispatches Cordis `ready` explicitly through `ctx.parallel('ready')` so the registered listener is awaited. This verifies the plugin's real event wiring, but does not reproduce the full production Host boot sequence or independently establish the ordering of every Host service. Cross-process workspace accounting remains outside this prototype.

## Machine-readable conformance manifest

The integration workflow uploads `provider-conformance.json` as a run artifact, including when the integration step fails. Schema version 2 records the pinned upstream commit, runtime environment, run start/finish timestamps, measured run duration, and individual case outcomes with evidence.

The top-level status is deliberately conservative:

- `PASS`: every recorded case passed.
- `PARTIAL`: the runner completed without a failure, but at least one case was skipped.
- `FAIL`: an integration assertion, Host disposal, or fixture cleanup failed.

A skipped provider lifecycle probe includes a stable `reasonCode`. For the currently pinned upstream revision, `provider-lifecycle-api-unavailable` means the public provider API does not expose the required lifecycle operation and admission fence. Plugin-level delete/restore/purge tests are reported separately and must not be interpreted as provider lifecycle conformance.

The artifact is evidence from one real integration run, not a release gate by itself. A `PARTIAL` result is expected until the upstream provider exposes a testable lifecycle contract.

## Upstream write-ownership boundary

The pinned Harness persistence seam exposes `create`, `open`, `stat`, and `list`; `open(id, 'write')` returns a write handle whose ownership is released by `close()`. A competing write-open rejects with `SessionAlreadyOwnedError`. The shipped JSONL provider implements this ownership with a kernel lock held for the write handle's lifetime (POSIX `flock` on the stable `session.lock` inode; Windows named kernel semaphore). The lock is acquired for an existing artifact at write-open, and the kernel releases it when the owning process exits.

This is a writer-ownership contract, not a public artifact-deletion/mutation lease. The persistence API described by the pinned revision does not expose a public operation to atomically fence new write opens while a delete/restore transaction moves or removes the artifact. The provider's lock implementation is internal; Session Delete's own filesystem lock is a separate coordination domain and cannot prove that a Harness writer is absent. In particular, removing a live POSIX lock file can let a later writer lock a replacement inode while the old writer still holds the original inode. Windows uses a kernel semaphore rather than a lock file, so filesystem inspection is not a portable ownership probe.

Consequently this prototype deliberately closes the seed writer before destructive operations and does not claim live-writer safety. Do not attempt to solve this by deleting `session.lock`, probing for its existence, or copying provider-private lock code into the plugin. A production-safe integration needs an upstream provider-owned mutation/fencing contract that serializes delete/restore against write-open across processes, defines crash recovery and rollback, and is testable on POSIX and Windows. The acceptance test should hold a real writer in process A, prove process B cannot begin destructive mutation or admit a replacement writer, then release/kill A and verify the provider-coordinated mutation can recover without split lock identity.

## Deliberate limits

This is not yet a destructive live-writer fencing or full desktop/web Host test:

- The seed process closes its write handle before the lifecycle process deletes the artifact; the writer-contention probe is completed and its child owner is killed before any destructive action.
- It does not race AgentLoop teardown against delete.
- It does not claim that Session Delete acquires or participates in the JSONL provider's Host-native write lease.
- It does not validate workspace membership, pin/archive accounting, projection cache, or cross-process workspace transactions.
- The runner now prepares the post-promotion interrupted-restore state in a separate real Host child process and the controller sends `SIGKILL` after the child reports the completed marker+rename barrier. A fresh Host then verifies recovery through its Cordis `ready` listener. This is one deterministic process-death point, not a general instruction-level fault-injection framework; it does not test interruption during the cross-volume copy itself or crash injection during delete/purge.
- It does not make the existing plugin-only filesystem lock safe against an independent live Host writer.

Preventing Session Delete from beginning a destructive operation while a live Harness writer exists remains gated on a public provider-owned artifact lease/tombstone contract and a full Host lifecycle fixture. The writer probe above validates only the provider's own write-open exclusion. Do not run destructive operations against a live writer based on this prototype.
