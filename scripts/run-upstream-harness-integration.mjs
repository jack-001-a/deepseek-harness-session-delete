#!/usr/bin/env node
/**
 * Optional integration prototype against a real DeepSeek Harness checkout.
 * The runner probes upstream writer ownership separately and closes it before destructive actions.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence',
  '@deepseek-ai/dsh-session': 'packages/core/session',
}

async function importHarnessPackage(name) {
  const packagePath = HARNESS_PACKAGES[name]
  if (!packagePath) throw new Error('No pinned workspace path configured for ' + name)
  const entrypoint = join(harnessRoot, packagePath, 'lib/index.js')
  return import(pathToFileURL(entrypoint).href)
}

async function createHostContext(sessionRoot) {
  const [{ Context }, testkit, agentLoop, jsonl, persistence, session] = await Promise.all([
    importHarnessPackage('@deepseek-ai/cordis'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop-testkit'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop'),
    importHarnessPackage('@deepseek-ai/dsh-session-persistence-jsonl'),
    importHarnessPackage('@deepseek-ai/dsh-session-persistence'),
    importHarnessPackage('@deepseek-ai/dsh-session'),
  ])
  const ctx = new Context()
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(agentLoop.default, { agents: [] })
  await jsonl.apply(ctx, { root: sessionRoot, compression: 'none' })
  return { ctx, persistence, session }
}

const SESSION_ID = 'session-delete-real-host-fixture'

// Keep trash isolated per test store. The plugin's default is a shared
// sibling .trash directory, which would otherwise leak state across runs.
function trashRootFor(sessionRoot) {
  return join(dirname(sessionRoot), basename(sessionRoot) + '-trash')
}

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

async function verifyCrossProcessWriterOwnership(ctx, persistence, sessionRoot) {
  const worker = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--hold-writer', sessionRoot],
    {
      cwd: harnessRoot,
      env: { ...process.env, DSH_HARNESS_ROOT: harnessRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  const closed = new Promise(resolvePromise => {
    worker.once('close', (code, signal) => resolvePromise({ code, signal }))
  })

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const timeout = setTimeout(() => {
      worker.kill('SIGKILL')
      finish(new Error(
        'Writer owner process timed out before acquiring its lease.\nstdout:\n'
          + stdout + '\nstderr:\n' + stderr,
      ))
    }, 60_000)

    worker.stdout.setEncoding('utf8')
    worker.stderr.setEncoding('utf8')
    worker.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.includes('writer-held\n')) finish()
    })
    worker.stderr.on('data', chunk => { stderr += chunk })
    worker.once('error', error => finish(error))
    worker.once('close', (code, signal) => {
      finish(new Error(
        'Writer owner process exited before the lease barrier (exit '
          + code + ', signal ' + signal + ').\nstdout:\n'
          + stdout + '\nstderr:\n' + stderr,
      ))
    })
  })

  let probeError
  try {
    const reader = await ctx.sessionPersistence.open(SESSION_ID, 'read')
    assert.equal(reader.header.id, SESSION_ID)
    await reader.close()

    await assert.rejects(
      ctx.sessionPersistence.open(SESSION_ID, 'write'),
      error => error instanceof persistence.SessionAlreadyOwnedError,
      'a second process must not acquire an active writer lease',
    )
  } catch (error) {
    probeError = error
  } finally {
    worker.kill('SIGKILL')
  }

  const exit = await closed
  if (probeError) throw probeError
  assert.equal(exit.signal, 'SIGKILL', 'the controller must kill the live writer owner')

  // Kernel ownership must be released by process death, without relying on
  // the dead process to run SessionHandle.close() or Host teardown.
  const successor = await ctx.sessionPersistence.open(SESSION_ID, 'write')
  assert.equal(successor.header.id, SESSION_ID)
  await successor.close()
}

async function holdWriterWorker(sessionRoot) {
  const { ctx } = await createHostContext(sessionRoot)
  await ctx.sessionPersistence.open(SESSION_ID, 'write')
  process.stdout.write('writer-held\n')
  // Keep the process alive while its unclosed real provider handle owns the
  // kernel lease. The controller terminates this process with SIGKILL.
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
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
async function interruptRestoreInSeparateProcess(sessionRoot) {
  const worker = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--interrupt-restore', sessionRoot],
    {
      cwd: harnessRoot,
      env: { ...process.env, DSH_HARNESS_ROOT: harnessRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let killedAtPromotionBarrier = false

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const timeout = setTimeout(() => {
      worker.kill('SIGKILL')
      finish(new Error(
        'Restore interruption worker timed out before the promotion barrier.\nstdout:\n'
          + stdout + '\nstderr:\n' + stderr,
      ))
    }, 60_000)

    worker.stdout.setEncoding('utf8')
    worker.stderr.setEncoding('utf8')
    worker.stdout.on('data', chunk => {
      stdout += chunk
      if (!killedAtPromotionBarrier && stdout.includes('restore-promoted\n')) {
        killedAtPromotionBarrier = true
        // Kill the real child immediately after promotion, before teardown.
        worker.kill('SIGKILL')
      }
    })
    worker.stderr.on('data', chunk => { stderr += chunk })
    worker.once('error', error => finish(error))
    worker.once('close', (code, signal) => {
      if (killedAtPromotionBarrier && signal === 'SIGKILL') {
        finish()
      } else {
        finish(new Error(
          'Restore interruption worker did not die at the promotion barrier '
            + '(exit ' + code + ', signal ' + signal + ').\nstdout:\n'
            + stdout + '\nstderr:\n' + stderr,
        ))
      }
    })
  })
}

async function interruptRestoreWorker(sessionRoot) {
  const { ctx } = await createHostContext(sessionRoot)
  applySessionDelete(ctx, { trashRoot: trashRootFor(sessionRoot) })
  const service = ctx.get('sessionDelete')
  const entry = (await service.listTrash()).entries.find(
    item => item.sessionId === SESSION_ID,
  )
  assert.ok(entry, 'the second delete must leave a trash entry')
  const trashEntryPath = join(trashRootFor(sessionRoot), entry.trashId)
  const restoreMarker = join(trashEntryPath, '.restoring')
  await writeFile(restoreMarker, JSON.stringify({
    sessionId: SESSION_ID,
    target: entry.originalPath,
  }))
  await rename(join(trashEntryPath, 'artifact'), entry.originalPath)
  process.stdout.write('restore-promoted\n')
  // Intentionally leave the Host context undisposed; the controller kills
  // this process so graceful teardown and cleanup handlers cannot run.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 60_000))
}



async function runIntegration() {
  const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-session-delete-host-'))
  const runStartedAt = process.hrtime.bigint()
  const manifest = {
    schemaVersion: 2,
    sourceCommit: '2e39e70496aa02986ca6a820c5d497e816b69d7e',
    provider: 'deepseek-harness-jsonl',
    environment: { os: process.platform, runtime: process.version, architecture: process.arch },
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    cases: [],
  }
  const record = (id, status, details, evidence = {}) => manifest.cases.push({
    id,
    status,
    details,
    ...(evidence.expected ? { expected: evidence.expected } : {}),
    ...(evidence.observed ? { observed: evidence.observed } : {}),
    ...(evidence.reasonCode ? { reasonCode: evidence.reasonCode } : {}),
  })
  let runStatus = 'PASS'
  const manifestPath = resolve(process.env.DSH_CONFORMANCE_MANIFEST_PATH
    || join(process.cwd(), 'artifacts', 'provider-conformance.json'))
  let ctx
  try {
    await seedInSeparateProcess(sessionRoot)
    record('JSONL-SEED-CROSS-PROCESS', 'PASS', 'Child Host created, flushed, closed, and disposed a real JSONL writer; parent opens a fresh Host over the same root.', {
      expected: 'A fresh parent Host can open the session seeded by the child process.',
      observed: 'The parent Host opened the same store after the child closed its writer.',
    })
    const host = await createHostContext(sessionRoot)
    ctx = host.ctx
    applySessionDelete(ctx, { trashRoot: trashRootFor(sessionRoot) })
    let service = ctx.get('sessionDelete')
    assert.ok(service, 'Session Delete must register on the real Cordis context')

    const capabilities = await service.describe()
    assert.equal(capabilities.supported, true)
    assert.equal(capabilities.canRestore, true)

    // Verify provider-level writer exclusion in a separate process; this does
    // not imply that Session Delete can fence a live writer during mutation.
    await verifyCrossProcessWriterOwnership(ctx, host.persistence, sessionRoot)
    record('JSONL-WRITER-EXCLUSION-001', 'PASS', 'While a child held the real write handle, parent read-open succeeded and competing write-open rejected with SessionAlreadyOwnedError.', {
      expected: 'Read-open succeeds while a writer is held; a competing write-open rejects with SessionAlreadyOwnedError.',
      observed: 'Read-open succeeded and the competing write-open rejected with the exported typed error.',
    })
    record('JSONL-WRITER-CRASH-RELEASE-001', 'PASS', 'Controller SIGKILLed the writer owner; parent acquired and closed a successor writer, proving kernel lease release after process death.', {
      expected: 'After owner process death, a successor process can acquire and close a write handle.',
      observed: 'The controller observed SIGKILL and the parent acquired and closed a successor writer.',
    })
    for (const operation of ['RETIRE', 'RESTORE', 'PURGE']) {
      record(`JSONL-PROVIDER-${operation}-001`, 'SKIP', 'Pinned upstream revision exposes no public provider-owned lifecycle operation or admission fence; plugin filesystem behavior is not provider conformance.', {
        reasonCode: 'provider-lifecycle-api-unavailable',
      })
    }

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
    applySessionDelete(ctx, { trashRoot: trashRootFor(sessionRoot) })
    const recoveryService = ctx.get('sessionDelete')
    // Observe the actual Cordis ready listener while letting the event bus
    // await its returned promise; emit() itself intentionally does not await.
    const reconcileStartup = recoveryService.reconcileStartup.bind(recoveryService)
    let recovery
    recoveryService.reconcileStartup = async () => {
      recovery = await reconcileStartup()
      return recovery
    }
    await ctx.parallel('ready')
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

    // A separate real Host process promotes the artifact; this controller
    // kills it at the explicit post-promotion barrier before accounting runs.
    await interruptRestoreInSeparateProcess(sessionRoot)
    await ctx.fiber.dispose()
    const restoreRecoveryHost = await createHostContext(sessionRoot)
    ctx = restoreRecoveryHost.ctx
    applySessionDelete(ctx, { trashRoot: trashRootFor(sessionRoot) })
    const restoreRecoveryService = ctx.get('sessionDelete')
    const reconcileRestore = restoreRecoveryService.reconcileStartup.bind(restoreRecoveryService)
    let restoreRecovery
    restoreRecoveryService.reconcileStartup = async () => {
      restoreRecovery = await reconcileRestore()
      return restoreRecovery
    }
    await ctx.parallel('ready')
    assert.deepEqual(restoreRecovery, { deleted: 0, restored: 1, preserved: 0 })
    const recoveredSnapshot = await ctx.sessionPersistence.stat(SESSION_ID)
    assert.equal(recoveredSnapshot.header.id, SESSION_ID)
    service = restoreRecoveryService

    const removedAfterRecovery = await service.delete(SESSION_ID)
    assert.equal(removedAfterRecovery.trashed, true)
    const purged = await service.purge(SESSION_ID)
    assert.equal(purged.purged, true)

    const remaining = await service.listTrash()
    assert.equal(remaining.entries.some(entry => entry.sessionId === SESSION_ID), false)
    // The persistence contract intentionally models stat() as an optional
    // observation: absence is returned as undefined, not thrown as an error.
    assert.equal(await ctx.sessionPersistence.stat(SESSION_ID), undefined)

    process.stdout.write(
      'PASS: real Cordis + AgentLoop testkit + JSONL provider; cross-process seed/close and writer exclusion/release; ready-hook plugin delete/restore recovery; purge\n',
    )
  } catch (error) {
    runStatus = 'FAIL'
    record('JSONL-INTEGRATION-RUN', 'FAIL', String(error?.stack || error).slice(0, 1800))
    throw error
  } finally {
    const finalizationErrors = []
    try {
      await ctx?.fiber.dispose()
    } catch (error) {
      finalizationErrors.push('Host disposal failed: ' + String(error?.stack || error))
    }
    for (const path of [sessionRoot, trashRootFor(sessionRoot)]) {
      try {
        await rm(path, { recursive: true, force: true })
      } catch (error) {
        finalizationErrors.push('Fixture cleanup failed for ' + path + ': ' + String(error?.stack || error))
      }
    }
    if (finalizationErrors.length) {
      runStatus = 'FAIL'
      record('JSONL-INTEGRATION-FINALIZATION', 'FAIL', finalizationErrors.join('\n').slice(0, 1800))
    }
    manifest.status = runStatus === 'FAIL'
      ? 'FAIL'
      : manifest.cases.some(testCase => testCase.status === 'SKIP')
        ? 'PARTIAL'
        : 'PASS'
    manifest.finishedAt = new Date().toISOString()
    manifest.durationMs = Number((process.hrtime.bigint() - runStartedAt) / 1_000_000n)
    await mkdir(dirname(manifestPath), { recursive: true })
    const temporaryManifest = manifestPath + '.tmp-' + process.pid
    await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporaryManifest, manifestPath)
    process.stdout.write('Conformance manifest: ' + manifestPath + '\n')
  }
}

if (process.argv[2] === '--seed') {
  await seedWorker(resolve(process.argv[3]))
} else if (process.argv[2] === '--interrupt-restore') {
  await interruptRestoreWorker(resolve(process.argv[3]))
} else if (process.argv[2] === '--hold-writer') {
  await holdWriterWorker(resolve(process.argv[3]))
} else {
  await runIntegration()
}
