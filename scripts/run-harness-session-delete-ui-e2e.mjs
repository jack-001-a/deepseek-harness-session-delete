#!/usr/bin/env node
/**
 * Inject the real-UI spec into the pinned Harness checkout for one Vitest run.
 * The upstream checkout remains untouched after this process exits.
 */
import { constants } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const harnessRoot = process.env.DSH_HARNESS_ROOT
if (harnessRoot === undefined || harnessRoot.length === 0) {
  throw new Error('Set DSH_HARNESS_ROOT to the pinned DeepSeek Harness checkout.')
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const source = join(repositoryRoot, 'scripts', 'session-delete-plugin.e2e.ts')
const destination = join(harnessRoot, 'apps', 'web', 'tests', 'session-delete-plugin.e2e.ts')
await copyFile(source, destination, constants.COPYFILE_EXCL)

let exitCode = 1
try {
  const child = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts', 'apps/web/tests/session-delete-plugin.e2e.ts'],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        DSH_SESSION_DELETE_ROOT: repositoryRoot,
        DSH_SNAPSHOT: 'replay',
      },
      stdio: 'inherit',
    },
  )
  exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  await rm(destination, { force: true })
}
process.exitCode = exitCode
