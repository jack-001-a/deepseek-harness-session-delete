import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProcessWorker, withWorkers } from './process-harness.mjs'
import { assertProviderAdapter } from './fixture-contract.mjs'
import { BarrierController, FaultPlan } from './orchestration.mjs'
import { assertReleaseGate, createManifest, recordCase, recordEvidence, writeManifest } from './manifest.mjs'
import { readVerifiedEvidenceArtifact, verifyManifestEvidence, writeEvidenceArtifact } from './evidence-artifacts.mjs'

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

test('reused barrier names cannot match stale worker events', async () => {
  await withWorkers([{ role: 'writer', caseId: 'barrier-reuse' }], async ([worker]) => {
    worker.barrier('same-name')
    const firstReached = await worker.waitFor((event) => event.type === 'barrier-reached' && event.barrier === 'same-name')
    worker.release('same-name')
    await worker.waitFor((event) => event.type === 'barrier-released' && event.barrier === 'same-name')

    worker.barrier('same-name')
    const secondReached = await worker.waitFor((event) => event.type === 'barrier-reached' && event.barrier === 'same-name')
    assert.notEqual(secondReached, firstReached, 'a reused barrier must produce a fresh event')
    assert.equal(secondReached.barrier, 'same-name')
    worker.release('same-name')
    await worker.waitFor((event) => event.type === 'barrier-released' && event.barrier === 'same-name')
  })
})

test('already-started workers are reaped if a later worker cannot be constructed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-worker-construction-'))
  const script = join(directory, 'worker.mjs')
  const markerPath = join(directory, 'shutdown-marker')
  await writeFile(script, [
    "import { createInterface } from 'node:readline'",
    "import { writeFile } from 'node:fs/promises'",
    "const input = createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "console.log(JSON.stringify({ type: 'ready', role: process.env.CONFORMANCE_ROLE, caseId: process.env.CONFORMANCE_CASE_ID }))",
    "input.on('line', async (line) => { if (JSON.parse(line).type === 'shutdown') { await writeFile(process.env.SHUTDOWN_MARKER, 'closed'); console.log(JSON.stringify({ type: 'shutdown-ack' })); input.close() } })",
  ].join('\n'))
  try {
    await assert.rejects(withWorkers([
      { role: 'first', caseId: 'partial-construction', script: pathToFileURL(script), env: { SHUTDOWN_MARKER: markerPath } },
      { role: '', caseId: 'invalid-second-worker' },
    ], async () => {}), /role and caseId are required/)
    assert.equal(await readFile(markerPath, 'utf8'), 'closed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker cleanup remains graceful when the test callback fails', async () => {
  let workerRef
  await assert.rejects(withWorkers([{ role: 'failure-cleanup', caseId: 'callback-failure' }], async ([worker]) => {
    workerRef = worker
    throw new Error('expected callback failure')
  }), /expected callback failure/)
  const exit = await workerRef.exit
  assert.equal(exit.code, 0)
})

test('worker shutdown acknowledges and exits cleanly', async () => {
  await withWorkers([{ role: 'shutdown-test', caseId: 'graceful-shutdown' }], async ([worker]) => {
    const result = await worker.shutdown()
    assert.equal(result.code, 0)
    assert.equal(worker.exit instanceof Promise, true)
  })
})

test('worker protocol errors fail pending waits immediately', async () => {
  await withWorkers([{ role: 'protocol-test', caseId: 'protocol-error' }], async ([worker]) => {
    worker.send({ type: 'run', action: 'barrier', barrier: '', caseId: worker.caseId, role: worker.role })
    await assert.rejects(worker.waitFor(() => false), /worker protocol error: invalid-barrier-request/)
  })
})

test('two worker processes expose distinct PIDs and deterministic barrier ordering', async () => {
  await withWorkers([
    { role: 'writer', caseId: 'cross-process-order' },
    { role: 'controller-peer', caseId: 'cross-process-order' },
  ], async ([writer, peer]) => {
    const controller = new BarrierController([writer, peer])
    writer.barrier('writer-admitted')
    const first = await controller.waitFor('writer', 'barrier-reached', 'writer-admitted')
    peer.barrier('peer-ready')
    const second = await controller.waitFor('controller-peer', 'barrier-reached', 'peer-ready')
    assert.notEqual(first.pid, second.pid)
    controller.release('writer', 'writer-admitted')
    controller.release('controller-peer', 'peer-ready')
    await Promise.all([
      controller.waitFor('writer', 'barrier-released', 'writer-admitted'),
      controller.waitFor('controller-peer', 'barrier-released', 'peer-ready'),
    ])
  })
})

test('fault plan applies deterministic pause, error, and kill actions', async () => {
  const plan = new FaultPlan([
    { point: 'before-commit', action: 'pause' },
    { point: 'after-commit', action: 'error', code: 'injected-io' },
    { point: 'after-response', action: 'kill', signal: 'SIGKILL' },
  ])
  assert.deepEqual(plan.take('before-commit'), { point: 'before-commit', action: 'pause' })
  assert.throws(() => plan.take('after-commit'), /injected-io/)
  assert.deepEqual(plan.take('after-response'), { point: 'after-response', action: 'kill', signal: 'SIGKILL' })
  assert.equal(plan.take('after-response'), null)
  assert.deepEqual(plan.remaining, [])
  assert.doesNotThrow(() => plan.assertConsumed())

  const incomplete = new FaultPlan([{ point: 'never-reached', action: 'pause' }])
  assert.throws(() => incomplete.assertConsumed(), /never-reached/)
})

test('manifest rejects duplicate IDs and non-passing required cases', async () => {
  const manifest = createManifest({ sourceCommit: 'test-sha', provider: 'harness-smoke' })
  recordCase(manifest, { id: 'S-001', status: 'PASS', durationMs: 1 })
  assert.throws(() => recordCase(manifest, { id: 'S-001', status: 'PASS' }), /duplicate/)
  assert.doesNotThrow(() => assertReleaseGate(manifest, ['S-001']))
  recordCase(manifest, { id: 'S-002', status: 'SKIP' })
  assert.throws(() => assertReleaseGate(manifest, ['S-001', 'S-002']), /S-002:SKIP/)
  assert.throws(() => assertReleaseGate(manifest, []), /non-empty/)
  assert.throws(() => assertReleaseGate(manifest, ['S-001', 'S-001']), /unique/)
  assert.throws(() => assertReleaseGate({ ...manifest, cases: [...manifest.cases, { ...manifest.cases[0] }] }, ['S-001']), /duplicate case id/)
  assert.throws(() => assertReleaseGate({ ...manifest, provider: '' }, ['S-001']), /versioned manifest/)
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
  for (const key of ['start', 'stop', 'create', 'openRead', 'openWrite']) adapter[key] = async () => {}
  adapter.lifecycle = { supported: true }
  for (const key of ['retire', 'restore', 'purge', 'inspect', 'inspectById', 'inspectOperation']) adapter.lifecycle[key] = async () => {}
  assert.equal(assertProviderAdapter(adapter).lifecycle, adapter.lifecycle)
})


test('verified provider evidence is persisted, digest-checked, and registered in the run manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-evidence-report-'))
  try {
    const sourceCommit = 'abcdef0123456789abcdef0123456789abcdef01'
    const manifest = createManifest({ sourceCommit, provider: 'sqlite-fixture' })
    recordCase(manifest, { id: 'P-FAULT-001', status: 'PASS' })
    const observation = {
      evidenceId: 'evidence-report-001',
      caseId: 'P-FAULT-001',
      testRunId: 'run-report-001',
      sourceCommit,
      providerVersion: 'sqlite-test-build',
      observer: 'parent-process-observer',
      effect: 'child-process-exit-confirmed',
      faultId: 'fault-001',
      operationId: 'operation-001',
      point: 'retire.commit',
      phase: 'after-commit-before-response',
      operation: 'retire',
      action: 'kill',
      exitCode: null,
      signal: 'SIGKILL',
    }
    const artifact = await writeEvidenceArtifact(join(directory, 'artifacts'), observation)
    const evidence = {
      schemaVersion: 1, verified: true, ...observation,
      artifactRef: artifact.artifactRef, artifactSha256: artifact.artifactSha256,
      faultId: 'fault-001', operationId: 'operation-001', point: 'retire.commit',
      phase: 'after-commit-before-response', operation: 'retire', action: 'kill',
    }
    recordEvidence(manifest, evidence)
    assert.doesNotThrow(() => assertReleaseGate(manifest, ['P-FAULT-001']))
    const verifiedArtifacts = await verifyManifestEvidence(manifest, join(directory, 'artifacts'))
    assert.equal(verifiedArtifacts.length, 1)
    assert.equal(verifiedArtifacts[0].evidenceId, observation.evidenceId)
    const reportPath = join(directory, 'report.json')
    await writeManifest(reportPath, manifest)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.evidence[0].artifactSha256, artifact.artifactSha256)
    assert.deepEqual(await readVerifiedEvidenceArtifact(join(directory, 'artifacts'), artifact.artifactRef), observation)
    assert.throws(() => recordEvidence(manifest, evidence), /duplicate evidence ID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('run manifest rejects evidence from another source revision', () => {
  const manifest = createManifest({ sourceCommit: 'abcdef0123456789abcdef0123456789abcdef01', provider: 'sqlite-fixture' })
  assert.throws(() => recordEvidence(manifest, {
    schemaVersion: 1, verified: true, evidenceId: 'wrong-revision',
    testRunId: 'run-1', sourceCommit: '1111111111111111111111111111111111111111',
    providerVersion: 'v1', observer: 'parent', effect: 'worker-exit',
    artifactRef: 'a'.repeat(64), artifactSha256: 'a'.repeat(64),
    faultId: 'f1', operationId: 'o1', point: 'p', phase: 'before-commit',
    operation: 'retire', action: 'kill',
  }), /not bound to this run manifest/)
})
