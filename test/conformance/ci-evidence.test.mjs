import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const script = resolve('scripts/create-ci-evidence.mjs')

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-evidence-contract-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, 'ci-evidence'))
  await writeFile(join(cwd, 'ci-evidence/unit-tests.log'), 'unit tests passed\n')
  await writeFile(join(cwd, 'ci-evidence/conformance-tests.log'), 'conformance tests passed\n')
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'jack-001-a/deepseek-harness-session-delete',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKFLOW_REF: 'jack-001-a/deepseek-harness-session-delete/.github/workflows/trusted-ci-evidence.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: '89abcdef0123456789abcdef0123456789abcdef',
    GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF_PROTECTED: 'true',
  }
  return { cwd, env }
}

function run(cwd, env) {
  return spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' })
}

test('CI evidence binds passing checks, source identity, run identity, and test log digests', async (t) => {
  const { cwd, env } = await fixture(t)
  const result = run(cwd, env)
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(await readFile(join(cwd, 'ci-evidence/ci-evidence.json'), 'utf8'))
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.kind, 'repository-ci-validation')
  assert.equal(evidence.status, 'PASS')
  assert.equal(evidence.source.commit, env.GITHUB_SHA)
  assert.equal(evidence.source.workflowRef, env.GITHUB_WORKFLOW_REF)
  assert.equal(evidence.source.runId, env.GITHUB_RUN_ID)
  assert.equal(evidence.source.runAttempt, env.GITHUB_RUN_ATTEMPT)
  assert.deepEqual(evidence.checks, {
    syntax: 'PASS',
    unit: 'PASS',
    conformanceHarnessSmoke: 'PASS',
  })
  const unitDigest = createHash('sha256').update('unit tests passed\n').digest('hex')
  const conformanceDigest = createHash('sha256').update('conformance tests passed\n').digest('hex')
  assert.equal(evidence.logs.unitTestSha256, unitDigest)
  assert.equal(evidence.logs.conformanceTestSha256, conformanceDigest)
})

for (const [name, override] of [
  ['pull request event', { GITHUB_EVENT_NAME: 'pull_request' }],
  ['non-main ref', { GITHUB_REF: 'refs/heads/feature/untrusted' }],
  ['different repository', { GITHUB_REPOSITORY: 'attacker/fork' }],
  ['abbreviated source commit', { GITHUB_SHA: 'deadbeef' }],
  ['unprotected main ref', { GITHUB_REF_PROTECTED: 'false' }],
]) {
  test(`CI evidence rejects ${name}`, async (t) => {
    const { cwd, env } = await fixture(t)
    const result = run(cwd, { ...env, ...override })
    assert.notEqual(result.status, 0)
    await assert.rejects(readFile(join(cwd, 'ci-evidence/ci-evidence.json')))
  })
}
