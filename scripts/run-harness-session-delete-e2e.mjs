#!/usr/bin/env node
/** Two-process integration test against pinned real Harness persistence packages. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply as applySessionDelete } from '../index.js'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const harnessVersion = process.env.DSH_HARNESS_VERSION
const manifestPath = process.env.DSH_E2E_MANIFEST
if (!harnessRoot || !harnessVersion || !manifestPath) {
  throw new Error('Set DSH_HARNESS_ROOT, DSH_HARNESS_VERSION and DSH_E2E_MANIFEST.')
}
const packages = {
  cordis: 'vendor/cordis',
  session: 'packages/core/session',
  jsonl: 'packages/session/session-persistence-jsonl',
}
async function load(key) {
  return import(pathToFileURL(join(harnessRoot, packages[key], 'lib/index.js')).href)
}
function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
function withTimeout(promise, label, timeoutMs = 45_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-two-process-'))
const workerPath = fileURLToPath(new URL('./fixtures/harness-session-holder.mjs', import.meta.url))
const manifest = {
  schemaVersion: 1,
  status: 'FAIL',
  harnessVersion,
  nodeVersion: process.version,
  cases: [],
}
let context
let worker
let workerLines
let workerExit
let backlog = []
let waiters = []
const startedAt = Date.now()
function trace(label) {
  process.stdout.write(`[e2e +${Date.now() - startedAt}ms] ${label}\n`)
}

function waitForLine(expected, timeoutMs = 30_000) {
  const queued = backlog.indexOf(expected)
  if (queued >= 0) {
    backlog.splice(queued, 1)
    return Promise.resolve(expected)
  }
  return new Promise((resolve, reject) => {
    const waiter = { expected, resolve, reject }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error('Timed out waiting for child output: ' + expected))
    }, timeoutMs)
    waiter.resolve = (line) => { clearTimeout(timer); resolve(line) }
    waiter.reject = (error) => { clearTimeout(timer); reject(error) }
    waiters.push(waiter)
  })
}
function send(command) {
  if (!worker || worker.stdin.destroyed) throw new Error('Child Harness process is unavailable.')
  worker.stdin.write(command + '\n')
}
async function stopWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  send('shutdown')
  await waitForLine('bye', 10_000)
  await workerExit
}

try {
  const [{ Context }, session, jsonl] = await Promise.all([load('cordis'), load('session'), load('jsonl')])
  trace('loaded pinned Harness modules')
  context = new Context()
  // The test targets cold stored sessions; use the real Cordis context and
  // persistence provider, with only the optional live-session lookup empty.
  Object.defineProperty(context, 'sessions', { configurable: true, value: { get: () => undefined } })
  await context.plugin({ name: jsonl.name, apply: jsonl.apply }, { root, compression: 'none' })
  await context.plugin({ name: 'session-delete-native-lease-e2e', apply: applySessionDelete }, {})
  trace('parent Cordis context and JSONL provider ready')
  const service = context.get('sessionDelete')
  const persistence = context.sessionPersistence
  assert.ok(service)
  assert.equal(typeof persistence.open, 'function')
  assert.equal(typeof persistence.locate, 'function')
  assert.equal(persistence.root, root)

  worker = spawn(process.execPath, [workerPath, root], {
    env: { ...process.env, DSH_HARNESS_ROOT: harnessRoot },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  workerExit = once(worker, 'exit')
  workerLines = createInterface({ input: worker.stdout })
  workerLines.on('line', (line) => {
    const index = waiters.findIndex((waiter) => waiter.expected === line)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(line)
    else backlog.push(line)
  })
  worker.once('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  })
  await waitForLine('ready')
  trace('peer process ready')

  const heldId = 'native-lock-held-by-peer'
  send('hold ' + heldId)
  await waitForLine('held ' + heldId)
  trace('peer holds native write lease')
  assert.ok((await persistence.stat(heldId))?.header)
  const reader = await persistence.open(heldId, 'read')
  const observed = await reader.read()
  await reader.close()
  assert.deepEqual(observed.events.map((event) => event.seq), [0, 1])

  trace('attempting delete while peer owns write lease')
  await assert.rejects(withTimeout(service.delete(heldId), 'delete refusal while peer owns native lease', 15_000), (error) => {
    assert.equal(error.code, 'session-delete/locked')
    assert.equal(error.details.reason, 'write-owned')
    return true
  })
  assert.ok((await persistence.stat(heldId))?.header, 'foreign writer refusal must leave the live artifact intact')
  assert.equal(await service.trashEntryFor(heldId), undefined)
  manifest.cases.push('peer-writer-blocks-delete-and-live-log-remains-readable')
  trace('foreign writer correctly blocked deletion')

  send('release ' + heldId)
  await waitForLine('released ' + heldId)
  trace('peer released first native write lease')
  const deletion = await withTimeout(service.delete(heldId), 'delete after peer release')
  assert.equal(deletion.trashed, true)
  trace('delete succeeded after peer release')
  assert.equal(await persistence.stat(heldId), undefined)
  const trashed = await service.trashEntryFor(heldId)
  assert.ok(trashed)
  assert.ok((await stat(join(trashed.path, 'artifact', 'session.lock'))).isFile())
  manifest.cases.push('delete-succeeds-after-peer-release-and-moves-native-lock-file-with-artifact')

  const raceId = 'native-restore-target-race'
  const raceHeader = {
    version: session.SESSION_FORMAT_VERSION,
    id: raceId,
    createdAt: Date.now(),
    cwd: '/work',
    isSeeded: false,
  }
  const seed = await persistence.create(raceHeader)
  await seed.append([
    { type: 'turn/start', seq: 0, time: 11, data: { turn: 2 } },
    { type: 'turn/end', seq: 1, time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  await seed.close()
  const originalPath = persistence.locate(raceHeader).path
  const originalBytes = await readFile(originalPath)
  assert.equal((await service.delete(raceId)).trashed, true)
  const raceEntry = await service.trashEntryFor(raceId)
  assert.ok(raceEntry)
  const artifactPath = join(raceEntry.path, 'artifact')
  const trashLogPath = join(artifactPath, basename(originalPath))
  const targetPath = dirname(originalPath)
  assert.deepEqual(await readFile(trashLogPath), originalBytes)

  const moveReached = deferred()
  const allowMove = deferred()
  let paused = false
  const servicePrototype = Object.getPrototypeOf(service)
  const originalPrototypeMoveArtifact = servicePrototype.moveArtifact
  assert.equal(typeof originalPrototypeMoveArtifact, 'function')
  servicePrototype.moveArtifact = async function (source, destination, options) {
    if (!paused && source === artifactPath && destination === targetPath) {
      paused = true
      moveReached.resolve()
      await allowMove.promise
    }
    return originalPrototypeMoveArtifact.call(this, source, destination, options)
  }

  trace('starting restore/create race and pausing before promotion')
  const restoring = service.restore(raceId)
  await withTimeout(moveReached.promise, 'Restore moveArtifact interception')
  trace('restore paused before atomic destination promotion')
  send('hold ' + raceId)
  await waitForLine('held ' + raceId)
  trace('peer created competing session and holds its lease')
  allowMove.resolve()
  await assert.rejects(withTimeout(restoring, 'Restore rejects occupied destination'), (error) => {
    assert.equal(error.code, 'session-delete/io')
    return true
  })

  const competingReader = await persistence.open(raceId, 'read')
  const competing = await competingReader.read()
  await competingReader.close()
  assert.deepEqual(competing.events.map((event) => event.seq), [0, 1])
  assert.deepEqual(await readFile(trashLogPath), originalBytes, 'the original Trash bytes must remain intact')
  assert.ok(await persistence.stat(raceId), 'the peer-created session must remain at the destination')
  assert.ok(await service.trashEntryFor(raceId), 'the original Trash entry must remain recoverable')
  manifest.cases.push('restore-create-race-refuses-atomic-promotion-and-preserves-both-copies')
  trace('restore race preserved both artifacts')

  send('release ' + raceId)
  await waitForLine('released ' + raceId)
  trace('peer released competing session lease')
  servicePrototype.moveArtifact = originalPrototypeMoveArtifact
  manifest.status = 'PASS'
} catch (error) {
  manifest.failure = error instanceof Error ? error.stack ?? error.message : String(error)
  trace('test failed: ' + (error instanceof Error ? error.message : String(error)))
} finally {
  try {
    await stopWorker()
  } catch (error) {
    manifest.failure ??= error instanceof Error ? error.stack ?? error.message : String(error)
    manifest.status = 'FAIL'
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
  }
  try { workerLines?.close() } catch {}
  try { await withTimeout(context?.fiber?.dispose() ?? Promise.resolve(), 'parent Cordis disposal', 15_000) } catch (error) {
    manifest.failure ??= error instanceof Error ? error.stack ?? error.message : String(error)
    manifest.status = 'FAIL'
  }
  await rm(root, { recursive: true, force: true })
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
if (manifest.status !== 'PASS') process.exitCode = 1
