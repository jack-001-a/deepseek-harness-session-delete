import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, link, unlink, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertReleaseGate } from './manifest.mjs'

const DIGEST = /^[a-f0-9]{64}$/

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Open the exact regular file inspected by lstat; reject path substitution before reading. */
async function readRegularArtifactFile(target) {
  const before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('evidence artifact is not a regular file')
  }
  const handle = await open(target, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('evidence artifact changed during open')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Store a JSON evidence artifact under its content digest; references are opaque IDs. */
export async function writeEvidenceArtifact(root, artifact) {
  if (!root || !artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new TypeError('artifact root and JSON object are required')
  }
  const bytes = Buffer.from(JSON.stringify(artifact) + '\n')
  const digest = digestOf(bytes)
  const directory = resolve(root)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, `${digest}.json`)
  const temporary = join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readRegularArtifactFile(target)
    if (digestOf(existing) !== digest) throw new Error('existing evidence artifact failed digest verification')
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return Object.freeze({ artifactRef: digest, artifactSha256: digest })
}

/** Resolve only digest-shaped references and reject symlinks, missing, or altered files. */
export async function readVerifiedEvidenceArtifact(root, artifactRef, expectedSha256 = artifactRef) {
  if (!DIGEST.test(artifactRef || '') || expectedSha256 !== artifactRef) {
    throw new TypeError('evidence artifact reference must be a matching SHA-256 digest')
  }
  const directory = resolve(root)
  const target = resolve(directory, `${artifactRef}.json`)
  if (dirname(target) !== directory) throw new Error('evidence artifact escaped its root')
  const bytes = await readRegularArtifactFile(target)
  if (digestOf(bytes) !== expectedSha256) throw new Error('evidence artifact digest mismatch')
  return JSON.parse(bytes.toString('utf8'))
}

/** Re-read every manifest artifact and bind its payload back to the recorded run identity. */
export async function verifyManifestEvidence(manifest, root) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.evidence)) {
    throw new TypeError('versioned manifest evidence is required')
  }
  const verified = []
  for (const record of manifest.evidence) {
    if (record.sourceCommit !== manifest.sourceCommit) throw new Error('manifest evidence source commit mismatch')
    const artifact = await readVerifiedEvidenceArtifact(root, record.artifactRef, record.artifactSha256)
    for (const field of ['evidenceId', 'caseId', 'testRunId', 'sourceCommit', 'providerVersion', 'observer', 'effect', 'faultId', 'operationId', 'point', 'phase', 'operation', 'action']) {
      if (artifact?.[field] !== record[field]) throw new Error(`evidence artifact ${field} does not match the run manifest`)
    }
    verified.push(artifact)
  }
  return verified
}

/** Verify artifacts and the release gate before atomically writing an evidence-bearing report. */
export async function writeVerifiedManifest(path, manifest, requiredCaseIds, artifactRoot) {
  await verifyManifestEvidence(manifest, artifactRoot)
  assertReleaseGate(manifest, requiredCaseIds)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
