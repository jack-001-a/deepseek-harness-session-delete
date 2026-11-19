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

The Harness checkout must already be built. This script deliberately resolves package exports from that checkout rather than adding Harness runtime packages as dependencies of the distributable plugin.

## What the prototype exercises

1. A child Node process mounts the real Cordis prerequisites, AgentLoop, and JSONL provider.
2. That process creates a persisted session, appends a minimal completed turn, flushes, closes the write handle, and disposes its Host context.
3. The parent process creates a fresh Host context over the same isolated session root.
4. It loads the real Session Delete \`apply()\` entrypoint and checks capability discovery.
5. It performs trash delete, lists the trash, restores the session, verifies it through the real provider, deletes it again, and purges it.

This proves a useful first integration seam: **a session materialized by one real Harness process can be consumed by the plugin running in another real Harness composition**, with a fresh provider instance and real on-disk artifacts.

## Deliberate limits

This is not yet a live-writer contention or full desktop/web Host test:

- The seed process closes its write handle before the lifecycle process deletes the artifact.
- It does not race AgentLoop teardown against delete.
- It does not claim that Session Delete acquires the JSONL provider's Host-native write lease.
- It does not validate workspace membership, pin/archive accounting, projection cache, or cross-process workspace transactions.
- It does not test crash injection during delete/restore/purge or cross-volume promotion.
- It does not make the existing plugin-only filesystem lock safe against an independent live Host writer.

Those scenarios remain gated on a public artifact lease/tombstone contract and a full Host lifecycle fixture. Do not run destructive operations against a live writer based on this prototype.
