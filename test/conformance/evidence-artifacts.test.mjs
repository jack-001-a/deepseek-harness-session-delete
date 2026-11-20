import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVerifiedEvidenceArtifact, writeEvidenceArtifact } from './evidence-artifacts.mjs'

test('evidence artifacts use opaque content digests and verify on read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-'))
  try {
    const payload = { observer: 'parent', effect: 'worker-exited' }
    const reference = await writeEvidenceArtifact(root, payload)
    assert.match(reference.artifactRef, /^[a-f0-9]{64}$/)
    assert.equal(reference.artifactSha256, reference.artifactRef)
    assert.deepEqual(await readVerifiedEvidenceArtifact(root, reference.artifactRef), payload)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent writes of identical evidence use collision-free temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-concurrent-'))
  try {
    const payload = { evidenceId: 'concurrent-1', observer: 'parent', effect: 'worker-exited' }
    const references = await Promise.all(Array.from({ length: 32 }, () => writeEvidenceArtifact(root, payload)))
    assert.equal(new Set(references.map((item) => item.artifactRef)).size, 1)
    assert.deepEqual(await readVerifiedEvidenceArtifact(root, references[0].artifactRef), payload)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('evidence artifact reader fails closed on missing, malformed, and modified references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-'))
  try {
    await assert.rejects(readVerifiedEvidenceArtifact(root, 'missing'), /SHA-256/)
    const reference = await writeEvidenceArtifact(root, { state: 'original' })
    await writeFile(join(root, `${reference.artifactRef}.json`), '{"state":"tampered"}\n')
    await assert.rejects(readVerifiedEvidenceArtifact(root, reference.artifactRef), /digest mismatch/)
    await assert.rejects(readVerifiedEvidenceArtifact(root, 'a'.repeat(64)), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('manifest artifact verification rejects a payload bound to a different run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-binding-'))
  try {
    const payload = {
      evidenceId: 'e-1', testRunId: 'run-1', sourceCommit: 'a'.repeat(40),
      providerVersion: 'v1', observer: 'parent',
    }
    const reference = await writeEvidenceArtifact(root, payload)
    const { verifyManifestEvidence } = await import('./evidence-artifacts.mjs')
    const manifest = {
      schemaVersion: 1, sourceCommit: 'b'.repeat(40),
      evidence: [{
        evidenceId: 'e-1', testRunId: 'run-1', sourceCommit: 'b'.repeat(40),
        providerVersion: 'v1', observer: 'parent',
        artifactRef: reference.artifactRef, artifactSha256: reference.artifactSha256,
      }],
    }
    await assert.rejects(verifyManifestEvidence(manifest, root), /sourceCommit does not match/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified report writer refuses missing or tampered artifacts without replacing a report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-report-gate-'))
  try {
    const { writeVerifiedManifest } = await import('./evidence-artifacts.mjs')
    const { createManifest, recordCase, recordEvidence } = await import('./manifest.mjs')
    const sourceCommit = 'c'.repeat(40)
    const manifest = createManifest({ sourceCommit, provider: 'fixture' })
    recordCase(manifest, { id: 'P-FAULT-001', status: 'PASS' })
    const payload = {
      evidenceId: 'e-gate', caseId: 'P-FAULT-001', testRunId: 'run-gate',
      sourceCommit, providerVersion: 'v1', observer: 'parent',
      effect: 'worker-exit', faultId: 'f1', operationId: 'o1',
      point: 'retire.commit', phase: 'after-commit', operation: 'retire', action: 'kill',
    }
    const artifactRoot = join(root, 'artifacts')
    const artifact = await writeEvidenceArtifact(artifactRoot, payload)
    recordEvidence(manifest, {
      schemaVersion: 1, verified: true, ...payload,
      artifactRef: artifact.artifactRef, artifactSha256: artifact.artifactSha256,
    })
    const report = join(root, 'report.json')
    await writeVerifiedManifest(report, manifest, ['P-FAULT-001'], artifactRoot)
    const originalReport = await readFile(report, 'utf8')
    assert.equal(JSON.parse(originalReport).evidence.length, 1)

    await writeFile(join(artifactRoot, `${artifact.artifactRef}.json`), '{"tampered":true}\n')
    await assert.rejects(
      writeVerifiedManifest(report, manifest, ['P-FAULT-001'], artifactRoot),
      /digest mismatch/,
    )
    assert.equal(await readFile(report, 'utf8'), originalReport)

    await writeEvidenceArtifact(artifactRoot, payload)
    await unlink(join(artifactRoot, `${artifact.artifactRef}.json`))
    await assert.rejects(
      writeVerifiedManifest(report, manifest, ['P-FAULT-001'], artifactRoot),
      /ENOENT/,
    )
    assert.equal(await readFile(report, 'utf8'), originalReport)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified report writer rejects a failed required case without creating or replacing a report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-release-gate-'))
  try {
    const { writeVerifiedManifest } = await import('./evidence-artifacts.mjs')
    const { createManifest, recordCase } = await import('./manifest.mjs')
    const manifest = createManifest({ sourceCommit: 'd'.repeat(40), provider: 'fixture' })
    recordCase(manifest, { id: 'P-FAULT-001', status: 'FAIL' })
    const report = join(root, 'report.json')
    const originalReport = '{"previous":"report"}\n'
    await writeFile(report, originalReport)
    await assert.rejects(writeVerifiedManifest(report, manifest, ['P-FAULT-001'], root), /P-FAULT-001:FAIL/)
    assert.equal(await readFile(report, 'utf8'), originalReport)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
