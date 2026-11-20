import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
