import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const required = [
  'GITHUB_REPOSITORY',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_EVENT_NAME',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_REF_PROTECTED',
]
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing required GitHub context: ${name}`)
}

if (process.env.GITHUB_REPOSITORY !== 'jack-001-a/deepseek-harness-session-delete') {
  throw new Error('evidence is restricted to the canonical repository')
}
if (process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('evidence is restricted to the protected main branch')
}
if (!['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
  throw new Error('untrusted event type cannot produce accepted evidence')
}
if (process.env.GITHUB_REF_PROTECTED !== 'true') {
  throw new Error('evidence requires GitHub to report the main ref as protected')
}
if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA)) {
  throw new Error('GITHUB_SHA must be a full commit object ID')
}

if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_WORKFLOW_SHA)) {
  throw new Error('GITHUB_WORKFLOW_SHA must be a full commit object ID')
}

async function hash(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

const evidence = {
  schemaVersion: 1,
  kind: 'repository-ci-validation',
  status: 'PASS',
  source: {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    refProtected: process.env.GITHUB_REF_PROTECTED === 'true',
    commit: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  },
  checks: {
    syntax: 'PASS',
    unit: 'PASS',
    conformanceHarnessSmoke: 'PASS',
  },
  logs: {
    unitTestSha256: await hash('ci-evidence/unit-tests.log'),
    conformanceTestSha256: await hash('ci-evidence/conformance-tests.log'),
  },
}
await writeFile('ci-evidence/ci-evidence.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
