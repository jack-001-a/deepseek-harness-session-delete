# Real Harness integration prototype

This is an **opt-in integration test**, not part of the default \`npm test\` suite. It runs the actual Session Delete entrypoint inside a real Cordis context composed with the upstream AgentLoop testkit and the shipped JSONL persistence provider.

## Pin and prerequisites

The prototype was designed against DeepSeek Harness commit:

\`2e39e70496aa02986ca6a820c5d497e816b69d7e\`

Use a checkout of that revision. Install its workspace dependencies and build the host libraries using the repository's documented build workflow. The following package exports must resolve from the Harness workspace:

- \`@deepseek-ai/cordis\`
- \`@deepseek-ai/dsh-agent-loop-testkit\`
- \`@deepseek-ai/dsh-agent-loop\`
- \`@deepseek-ai/dsh-session-persistence-jsonl\`
- \`@deepseek-ai/dsh-session\`

The testkit mounts the real prerequisite services; AgentLoop and JSONL persistence are loaded as production packages. No fake Cordis context, fake persistence provider, or copied Session Delete helper is used.

## Run

From this plugin checkout:

\`\`\`sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness npm run test:integration:upstream
\`\`\`

On PowerShell:

\`\`\`powershell
$env:DSH_HARNESS_ROOT = 'C:\\path\\to\\deepseek-harness'
npm run test:integration:upstream
\`\`\`

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
4. It loads the real Session Delete \`apply()\` entrypoint and checks capability discovery.
5. It performs trash delete and lists the trash.
6. It disposes that Host context, opens a fresh Host composition over the same store, dispatches the real Cordis `ready` event with `ctx.parallel('ready')`, and observes the plugin's committed-delete recovery result.
7. It restores the session, verifies it through the real provider, and deletes it again.
8. It writes a durable `.restoring` marker, promotes the trash artifact back to its original path, disposes the Host context, and opens a fresh composition.
9. The fresh Host's Cordis `ready` listener recovers the interrupted restore and the real provider verifies the session; the runner then deletes and purges it.

This proves a useful first integration seam: **a session materialized by one real Harness process can be consumed by the plugin running in another real Harness composition**, with a fresh provider instance and real on-disk artifacts.

## Verified result

The first successful real-Harness run completed on 2026-11-19:

- [Integration workflow run 44509694976](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44509694976) — passed.
- [Expanded integration workflow run 44511034933](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44511034933) — passed, including committed-delete startup reconciliation through a fresh Host context.
- [Cordis ready-event integration run 44512014722](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44512014722) — passed on the ready-listener revision; committed-delete reconciliation was triggered and awaited through `ctx.parallel('ready')`.
- [Regular CI run 44509694956](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44509694956) — all 9 Linux/macOS/Windows × Node 22/24/26 jobs passed.
- [Latest-head regular CI run 44512780418](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44512780418) — all 9 Linux/macOS/Windows × Node 22/24/26 matrix jobs passed.
- [Latest-head real Harness integration run 44512780369](https://github.com/jack-001-a/deepseek-harness-session-delete/actions/runs/44512780369) — passed with the post-promotion interrupted-restore scenario enabled; upstream native/Host builds, the 97-test unit suite, and the real Cordis/AgentLoop/JSONL runner all succeeded.
- Plugin unit suite — 97 passed, 0 failed.
- Real integration — passed using the pinned Harness revision, with a separate-process seed/close, committed-delete recovery through a fresh Host `ready` listener, restore, a simulated post-promotion interrupted restore recovered through another fresh Host `ready` listener, and final delete/purge. The interrupted-restore assertion returned `{ deleted: 0, restored: 1, preserved: 0 }`.

The latest-head run 44512780369 verifies the closed-writer artifact lifecycle described above, including committed-delete reconciliation and post-promotion interrupted-restore reconciliation through fresh Host compositions. The runner dispatches Cordis `ready` explicitly through `ctx.parallel('ready')` so the registered listener is awaited. This verifies the plugin's real event wiring, but does not reproduce the full production Host boot sequence or independently establish the ordering of every Host service. It is not evidence for live-writer contention, Host-native artifact leases, or cross-process workspace accounting.

## Deliberate limits

This is not yet a live-writer contention or full desktop/web Host test:

- The seed process closes its write handle before the lifecycle process deletes the artifact.
- It does not race AgentLoop teardown against delete.
- It does not claim that Session Delete acquires the JSONL provider's Host-native write lease.
- It does not validate workspace membership, pin/archive accounting, projection cache, or cross-process workspace transactions.
- It models the post-promotion interrupted-restore state using a durable marker and filesystem rename, then verifies recovery through a fresh Host's Cordis `ready` listener. It does not kill a process at an instruction-level fault-injection barrier, test interruption during the cross-volume copy itself, or cover crash injection during delete/purge.
- It does not make the existing plugin-only filesystem lock safe against an independent live Host writer.

Those scenarios remain gated on a public artifact lease/tombstone contract and a full Host lifecycle fixture. Do not run destructive operations against a live writer based on this prototype.
