import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'FLAKY'])

/** Create a redacted, machine-readable conformance run manifest. */
export function createManifest({ sourceCommit, provider, os = process.platform, runtime = process.version, architecture = process.arch }) {
  if (!sourceCommit || !provider) throw new TypeError('sourceCommit and provider are required')
  return {
    schemaVersion: 1,
    sourceCommit,
    provider,
    environment: { os, runtime, architecture },
    startedAt: new Date().toISOString(),
    cases: [],
  }
}

/** Append a validated result; secrets and arbitrary payloads are not accepted. */
export function recordCase(manifest, result) {
  if (!result || typeof result.id !== 'string' || !STATUSES.has(result.status)) {
    throw new TypeError('case result requires id and a supported status')
  }
  if (manifest.cases.some((item) => item.id === result.id)) throw new Error(`duplicate case id: ${result.id}`)
  manifest.cases.push({
    id: result.id,
    status: result.status,
    durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0,
    expected: result.expected ?? null,
    observed: result.observed ?? null,
    details: typeof result.details === 'string' ? result.details.slice(0, 2000) : null,
  })
}

/** Write atomically so interrupted runs never leave a partial JSON document. */
export async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

/** Required release cases cannot be hidden by skips or flaky outcomes. */
export function assertReleaseGate(manifest, requiredIds) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.sourceCommit !== 'string' || !manifest.sourceCommit ||
      typeof manifest.provider !== 'string' || !manifest.provider || !Array.isArray(manifest.cases)) {
    throw new TypeError('release gate requires a versioned manifest with sourceCommit, provider, and cases')
  }
  if (!Array.isArray(requiredIds) || requiredIds.length === 0 ||
      requiredIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(requiredIds).size !== requiredIds.length) {
    throw new TypeError('release gate requires a non-empty list of unique case IDs')
  }

  const byId = new Map()
  for (const item of manifest.cases) {
    if (!item || typeof item.id !== 'string' || !item.id || !STATUSES.has(item.status)) {
      throw new TypeError('manifest contains an invalid case result')
    }
    if (byId.has(item.id)) throw new Error(`manifest contains duplicate case id: ${item.id}`)
    byId.set(item.id, item)
  }

  const failures = requiredIds.flatMap((id) => {
    const item = byId.get(id)
    return !item ? [`${id}:missing`] : item.status !== 'PASS' ? [`${id}:${item.status}`] : []
  })
  if (failures.length) throw new Error(`conformance release gate not met: ${failures.join(', ')}`)
}
