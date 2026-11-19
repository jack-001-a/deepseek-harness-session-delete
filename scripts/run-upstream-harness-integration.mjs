#!/usr/bin/env node
/**
 * Optional integration prototype against a real DeepSeek Harness checkout.
 * The seed process closes its real JSONL handle before any destructive action.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { apply as applySessionDelete } from '../index.js'

const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT
if (!HARNESS_ROOT) {
  throw new Error('Set DSH_HARNESS_ROOT to a built deepseek-harness checkout before running this optional integration test.')
}
const harnessRoot = resolve(HARNESS_ROOT)
const HARNESS_PACKAGES = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-agent-loop-testkit': 'packages/test-support/agent-loop-testkit',
  '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
  '@deepseek-ai/dsh-session-persistence-jsonl': 'packages/session/session-persistence-jsonl',
  '@deepseek-ai/dsh-session': 'packages/core/session',
}

async function importHarnessPackage(name) {
  const packagePath = HARNESS_PACKAGES[name]
  if (!packagePath) throw new Error('No pinned workspace path configured for ' + name)
  const entrypoint = join(harnessRoot, packagePath, 'lib/index.js')
  return import(pathToFileURL(entrypoint).href)
}

async function createHostContext(sessionRoot) {
  const [{ Context }, testkit, agentLoop, jsonl, session] = await Promise.all([
    importHarnessPackage('@deepseek-ai/cordis'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop-testkit'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop'),
    importHarnessPackage('@deepseek-ai/dsh-session-persistence-jsonl'),
    importHarnessPackage('@deepseek-ai/dsh-session'),
  ])
  const ctx = new Context()
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(agentLoop.default, { agents: [] })
  await jsonl.apply(ctx, { root: sessionRoot, compression: 'none' })
  return { ctx, session }
}

const SESSION_ID = 'session-delete-real-host-fixture'

async function seedInSeparateProcess(sessionRoot) {
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--seed', sessionRoot],
    {
      cwd: harnessRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_HARNESS_ROOT: harnessRoot },
      timeout: 60_000,
    },
  )
  if (worker.error) throw worker.error
  if (worker.status !== 0) {
    throw new Error(
      'Harness seed process failed (exit ' + worker.status + ').\nstdout:\n'
        + worker.stdout + '\nstderr:\n' + worker.stderr,
    )
  }
  assert.match(worker.stdout, /seeded-and-closed/)
}

async function seedWorker(sessionRoot) {
  const { ctx, session } = await createHostContext(sessionRoot)
  try {
    const handle = await ctx.sessionPersistence.create({
      version: session.SESSION_FORMAT_VERSION,
      id: SESSION_ID,
      createdAt: Date.now(),
      cwd: harnessRoot,
      isSeeded: false,
    })
    await handle.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await handle.flush()
    await handle.close()
    process.stdout.write('seeded-and-closed\n')
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runIntegration() {
  const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-session-delete-host-'))
  let ctx
  try {
    await seedInSeparateProcess(sessionRoot)
    const host = await createHostContext(sessionRoot)
    ctx = host.ctx
    applySessionDelete(ctx, {})
    const service = ctx.get('sessionDelete')
    assert.ok(service, 'Session Delete must register on the real Cordis context')

    const capabilities = await service.describe()
    assert.equal(capabilities.supported, true)
    assert.equal(capabilities.canRestore, true)

    const removed = await service.delete(SESSION_ID)
    assert.equal(removed.removed, true)
    assert.equal(removed.trashed, true)
    assert.equal(removed.stored, true)

    const trashAfterDelete = await service.listTrash()
    assert.ok(trashAfterDelete.entries.some(entry => entry.sessionId === SESSION_ID))

    // Re-open the same durable store through a fresh Host composition. The
    // startup reconciler must safely replay committed-delete accounting.
    await ctx.fiber.dispose()
    const recoveryHost = await createHostContext(sessionRoot)
    ctx = recoveryHost.ctx
    applySessionDelete(ctx, {})
    const recoveryService = ctx.get('sessionDelete')
    const recovery = await recoveryService.reconcileStartup()
    assert.deepEqual(recovery, { deleted: 1, restored: 0, preserved: 0 })
    assert.ok((await recoveryService.listTrash()).entries.some(
      entry => entry.sessionId === SESSION_ID,
    ))
    service = recoveryService

    const restored = await service.restore(SESSION_ID)
    assert.equal(restored.restored, true)
    const snapshot = await ctx.sessionPersistence.stat(SESSION_ID)
    assert.equal(snapshot.header.id, SESSION_ID)

    const removedAgain = await service.delete(SESSION_ID)
    assert.equal(removedAgain.trashed, true)
    const purged = await service.purge(SESSION_ID)
    assert.equal(purged.purged, true)

    const remaining = await service.listTrash()
    assert.equal(remaining.entries.some(entry => entry.sessionId === SESSION_ID), false)
    // The persistence contract intentionally models stat() as an optional
    // observation: absence is returned as undefined, not thrown as an error.
    assert.equal(await ctx.sessionPersistence.stat(SESSION_ID), undefined)

    process.stdout.write(
      'PASS: real Cordis + AgentLoop testkit + JSONL provider; cross-process seed/close; plugin delete/restore/purge\n',
    )
  } finally {
    await ctx?.fiber.dispose()
    await rm(sessionRoot, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--seed') {
  await seedWorker(resolve(process.argv[3]))
} else {
  await runIntegration()
}
