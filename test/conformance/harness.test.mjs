import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessWorker, withWorkers } from './process-harness.mjs'
import { assertProviderAdapter } from './fixture-contract.mjs'
import { assertReleaseGate, createManifest, recordCase, writeManifest } from './manifest.mjs'

test('worker barrier is controlled by the parent process, not sleeps', async () => {
  await withWorkers([{ role: 'writer', caseId: 'harness-smoke' }], async ([worker]) => {
    worker.barrier('after-admission')
    const reached = await worker.waitFor((event) => event.type === 'barrier-reached')
    assert.equal(reached.barrier, 'after-admission')
    assert.equal(reached.role, 'writer')
    worker.release('after-admission')
    const released = await worker.waitFor((event) => event.type === 'barrier-released')
    assert.equal(released.barrier, 'after-admission')
  })
})

test('workers are separate OS processes', async () => {
  await withWorkers([
    { role: 'a', caseId: 'process-isolation' },
    { role: 'b', caseId: 'process-isolation' },
  ], async ([a, b]) => {
    assert.notEqual(a, b)
    assert.notEqual(a.role, b.role)
  })
})

test('manifest rejects duplicate IDs and non-passing required cases', async () => {
  const manifest = createManifest({ sourceCommit: 'test-sha', provider: 'harness-smoke' })
  recordCase(manifest, { id: 'S-001', status: 'PASS', durationMs: 1 })
  assert.throws(() => recordCase(manifest, { id: 'S-001', status: 'PASS' }), /duplicate/)
  assert.doesNotThrow(() => assertReleaseGate(manifest, ['S-001']))
  recordCase(manifest, { id: 'S-002', status: 'SKIP' })
  assert.throws(() => assertReleaseGate(manifest, ['S-001', 'S-002']), /S-002:SKIP/)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-conformance-'))
  try {
    const path = join(directory, 'manifest.json')
    await writeManifest(path, manifest)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.cases.length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('provider adapter contract rejects incomplete adapters', () => {
  assert.throws(() => assertProviderAdapter({ name: 'fake' }), /missing/)
  const adapter = { name: 'fixture' }
  for (const key of ['start', 'stop', 'create', 'openRead', 'openWrite', 'retire', 'restore', 'purge', 'inspect']) {
    adapter[key] = async () => {}
  }
  assert.equal(assertProviderAdapter(adapter), adapter)
})
