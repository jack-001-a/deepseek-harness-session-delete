# Upstream Harness integration-fixture feasibility

- Reviewed: 2026-11-19
- Upstream repository: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Reviewed upstream revision: [`2e39e70496aa02986ca6a820c5d497e816b69d7e`](https://github.com/deepseek-ai/deepseek-harness/commit/2e39e70496aa02986ca6a820c5d497e816b69d7e)
- Scope: determine what can be reused for Session Delete's future real multi-process integration suite
- This is a source inspection report, not a claim that this plugin has run upstream tests

## Executive finding

**A provider-level real two-process test harness already exists upstream.** Building every process primitive from scratch is unnecessary.

The missing piece is narrower: no inspected upstream test currently starts two independent full Host compositions and drives this plugin's delete/restore/purge transactions against a live native session writer. Existing tests cover the provider lease in separate processes, and the generic live-write contract covers flush/close behavior inside one Cordis context. These are useful building blocks, but they do not yet prove the end-to-end plugin/Host lifecycle contract.

Therefore, the next step should be a small integration fixture that composes the existing provider process harness with a deterministic Host lifecycle fixture—not a new lock implementation and not a mock of the provider lease.

## Existing upstream building blocks

All paths below are pinned to the reviewed upstream revision above.

| Building block | Existing source | What it proves | What it does not prove |
|---|---|---|---|
| JSONL real two-process lease E2E | [`packages/session/session-persistence-jsonl/tests/lease.two-process.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-jsonl/tests/lease.two-process.e2e.ts) | Child Node process mounts the built JSONL provider, creates/materializes a session and holds the kernel write lease; parent process is denied write-open, can read, and can take over after child SIGKILL | No graceful close-drain race; no Host agent-loop lifecycle; no Session Delete operation |
| JSONL process fixture | [`tests/fixtures/lease-holder.mjs`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-jsonl/tests/fixtures/lease-holder.mjs) | Plain Node child can import built packages and hold a real provider lease with an isolated shared root | It is a provider fixture, not a full Harness app fixture |
| JSONL lease implementation | [`src/lease.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-jsonl/src/lease.ts) | POSIX flock + inode verification and Windows named semaphore branch; documents lease lifetime and absence of automatic expiry | It is provider-private implementation and must not be copied into this plugin |
| Generic handle contract | [`packages/session/session-persistence/tests/contract.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence/tests/contract.ts) | Reusable provider contract, including fresh backend remount over the same storage | Fresh backend instances are not necessarily independent OS processes |
| Generic live-write contract | [`packages/session/session-persistence/tests/live-write-contract.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence/tests/live-write-contract.ts) | Routes published events, flush barrier, retained background failures, session/disposed drain, and close semantics | These tests use a Cordis context in one test process; they do not race close against a second process |
| SQLite process E2E | [`packages/session/session-persistence-sqlite/tests/legacy-open.two-process.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session/session-persistence-sqlite/tests/legacy-open.two-process.e2e.ts) | Independent Node processes coordinate import ownership, contention, process death, and retry | SQLite import ownership is not the JSONL artifact lease and does not validate Session Delete's file operations |
| Headless agent-loop fixture | [`apps/cli/tests/profiles/headless/tests/harness.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/apps/cli/tests/profiles/headless/tests/harness.ts) | A reusable Cordis composition mounts AgentLoop, test dependencies, and optionally the real JSONL provider | It is a test harness composition, not a production desktop/web Host boot; it includes testkit dependencies and should be adapted deliberately |
| E2E test discovery | [`vitest.e2e.config.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/vitest.e2e.config.ts) | Upstream E2E config discovers `packages/*/*/tests/**/*.e2e.ts` and runs built-artifact child-process tests | Does not itself provide a full Host lifecycle fixture |

## Important semantic details from the existing tests

### JSONL lease

The provider's current two-process test is particularly valuable because the child imports the built package under plain Node, while the parent mounts another provider instance in a separate process. It verifies:

1. The child holds a materialized session write handle.
2. Parent write-open rejects with `SessionAlreadyOwnedError`.
3. Parent read remains possible.
4. Killing the child releases the kernel lease.
5. Parent can then acquire write ownership and append.

The test does **not** prove graceful close drains a final live event batch before a lifecycle operation acquires ownership. The shared live-write contract covers drain/close semantics, but only within one Cordis context. A new cross-process close-drain test remains necessary.

The provider's POSIX lock is tied to the lock-file inode and the implementation verifies the path still names the locked inode. The Windows branch uses its native named semaphore. Treat these as provider-owned details; the plugin must not reach into `session.lock` or recreate either mechanism.

### Host lifecycle fixture

The headless `codingHarness()` fixture demonstrates how upstream tests compose a Cordis context, AgentLoop, testkit dependencies, and optionally JSONL persistence. It is a practical starting point for a deterministic lifecycle worker, but it is not a ready-made two-process Host integration fixture.

For a Session Delete integration test, first construct a no-network Host fixture that uses the real session lifecycle and real persistence provider while replacing only external model/tool dependencies through the supported testkit seams. Then launch that fixture in two child Node processes sharing only the isolated store root and test coordination channel.

Do not use a live model API as a prerequisite for a lock/lifecycle test. Do not replace the provider or lease with a fake mutex.

## Gap analysis

| Requirement | Existing upstream coverage | Remaining work |
|---|---|---|
| Two OS processes, same JSONL root | Yes | Reuse the process-control pattern |
| Native provider lease contention | Yes, JSONL | Extend with lifecycle race scenarios |
| Kernel lease released on abrupt process death | Yes, JSONL | Reuse; retain platform-specific assertions |
| Graceful close drains final accepted live batch | Generic single-process contract | Add two-process close-vs-lease barrier test |
| Full AgentLoop / session lifecycle in a child process | Headless fixture exists in-process | Adapt to deterministic no-network child worker |
| Session Delete plugin loaded into that Host | Not found in inspected upstream fixtures | Compose plugin into the test Host, or create fixture in this plugin repo |
| Delete/restore/purge against live writer | Not found | New integration cases required |
| Crash recovery through production plugin startup reconciliation | Plugin unit tests exist; no real Host two-process integration found | Launch fresh Host child after each injected crash phase |
| Workspace membership/pin/archive cross-process consistency | Not proven by session lease tests | Test separately; session lease is not a workspace transaction |
| Artifact lease for temporarily absent artifact / tombstone | No public capability verified in inspected sources | Requires Host API design before runtime integration |

## Recommended implementation sequence

1. **Reuse the JSONL E2E pattern.** Keep the child-process launcher, isolated temp root, line/IPC barriers, process termination, and built-package loading approach.
2. **Create a deterministic Host worker.** Start a real Cordis/AgentLoop session lifecycle with real JSONL persistence. Replace only model/network dependencies with supported testkit adapters.
3. **Mount Session Delete into the lifecycle worker.** Use the production plugin entrypoint and actual delete/restore/purge services, not copied helper functions.
4. **Add close-drain contention first.** Writer child buffers a uniquely identifiable final event batch and starts graceful disposal/close; lifecycle child requests the provider-supported lifecycle capability. Assert lifecycle ownership is not granted until the final batch is durable.
5. **Add delete and restore races only after a public artifact capability exists.** The current `open(id, 'write')` cannot claim a temporarily absent artifact. Do not work around this by manipulating provider-private locks.
6. **Add process-kill crash phases.** Reuse the upstream child-process controller and verify recovery from a fresh Host process.
7. **Run the real provider matrix.** Linux/macOS/Windows and supported Node versions; report cross-volume cases only where CI actually supplies separate volumes.

## Decision

The fixture feasibility question is no longer blocked by absence of all upstream process infrastructure. The JSONL provider E2E and headless AgentLoop test composition provide credible starting points.

The remaining blocker is the public Host artifact lifecycle contract, not the mechanics of spawning two Node processes. Proceed with a **test-only Host composition prototype** if it can be built without private APIs. Keep destructive runtime integration disabled until the provider exposes an artifact lease/tombstone capability that also covers absent artifacts and retirement.
