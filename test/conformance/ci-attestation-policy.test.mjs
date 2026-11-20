import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evaluateAttestationPolicy } from '../../scripts/verify-ci-evidence.mjs'

const repository = 'jack-001-a/deepseek-harness-session-delete'
const workflow = `${repository}/.github/workflows/trusted-ci-evidence.yml`
const commit = '0123456789abcdef0123456789abcdef01234567'
const workflowSha = '89abcdef0123456789abcdef0123456789abcdef'
const bytes = Buffer.from('{"schemaVersion":1,"status":"PASS"}\n')
const digest = createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const evidence = {
    source: { repository, ref: 'refs/heads/main', refProtected: true, event: 'push', workflowRef: `${workflow}@refs/heads/main`, workflowSha, commit, runId: '123456789', runAttempt: '1' },
  }
  const runMetadata = {
    id: 123456789,
    run_attempt: 1,
    repository: { full_name: repository, id: 1428060802 },
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/trusted-ci-evidence.yml@main',
  }
  const verification = [{
    verificationResult: {
      signature: {
        certificate: {
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryIdentifier: '1428060802',
          sourceRepositoryOwnerURI: 'https://github.com/jack-001-a',
          sourceRepositoryOwnerIdentifier: '320086254',
          sourceRepositoryRef: 'refs/heads/main',
          sourceRepositoryDigest: commit,
          subjectAlternativeName: { type: 'URI', value: `https://github.com/${workflow}@refs/heads/main` },
          issuer: 'https://token.actions.githubusercontent.com',
          runnerEnvironment: 'github-hosted',
          buildSignerURI: `https://github.com/${workflow}@refs/heads/main`,
          buildSignerDigest: workflowSha,
          buildConfigURI: `https://github.com/${workflow}@refs/heads/main`,
          buildConfigDigest: workflowSha,
          buildTrigger: 'push',
          runInvocationURI: `https://github.com/${repository}/actions/runs/123456789/attempts/1`,
        },
      },
      statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: 'ci-evidence.json', digest: { sha256: digest } }] },
    },
  }]
  return { evidence, runMetadata, verification, artifactBytes: bytes }
}

test('classifies missing attestation data as unavailable', () => {
  const f = fixture()
  f.verification = []
  assert.throws(() => evaluateAttestationPolicy(f), error => error.status === 'provenance_unavailable')
})

test('rejects evidence that claims an unprotected ref', () => {
  const f = fixture()
  f.evidence.source.refProtected = false
  assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
})

test('rejects non-canonical certificate field aliases', () => {
  const f = fixture()
  const certificate = f.verification[0].verificationResult.signature.certificate
  delete certificate.sourceRepositoryURI
  certificate.SourceRepositoryURI = `https://github.com/${repository}`
  assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
})

test('accepts a verified certificate and exact subject bound to independent GitHub run metadata', () => {
  const result = evaluateAttestationPolicy(fixture())
  assert.equal(result.status, 'provenance_verified')
  assert.equal(result.sourceCommit, commit)
  assert.equal(result.subjectSha256, digest)
})

for (const [name, mutate] of [
  ['wrong repository', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryURI = 'https://github.com/attacker/repo' }],
  ['wrong immutable repository identity', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryIdentifier = '999' }],
  ['wrong owner identity', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryOwnerIdentifier = '999' }],
  ['wrong owner URI', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryOwnerURI = 'https://github.com/attacker' }],
  ['wrong run invocation', f => { f.verification[0].verificationResult.signature.certificate.runInvocationURI = 'https://github.com/attacker/repo/actions/runs/1/attempts/1' }],
  ['wrong workflow identity', f => { f.verification[0].verificationResult.signature.certificate.buildSignerURI = 'https://github.com/attacker/other.yml@refs/heads/main' }],
  ['wrong certificate SAN', f => { f.verification[0].verificationResult.signature.certificate.subjectAlternativeName.value = 'https://github.com/attacker/other.yml@refs/heads/main' }],
  ['missing certificate SAN', f => { delete f.verification[0].verificationResult.signature.certificate.subjectAlternativeName }],
  ['wrong SAN type', f => { f.verification[0].verificationResult.signature.certificate.subjectAlternativeName.type = 'email' }],
  ['wrong signer digest', f => { f.verification[0].verificationResult.signature.certificate.buildSignerDigest = commit }],
  ['wrong build config URI', f => { f.verification[0].verificationResult.signature.certificate.buildConfigURI = 'https://github.com/attacker/other.yml@refs/heads/main' }],
  ['wrong workflow revision', f => { f.verification[0].verificationResult.signature.certificate.buildConfigDigest = commit }],
  ['wrong ref', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryRef = 'refs/heads/feature' }],
  ['wrong event', f => { f.runMetadata.event = 'pull_request' }],
  ['wrong run ID', f => { f.runMetadata.id = 987654321 }],
  ['wrong run repository', f => { f.runMetadata.repository.full_name = 'attacker/repo' }],
  ['wrong workflow path', f => { f.runMetadata.path = '.github/workflows/other.yml@main' }],
  ['wrong evidence workflow ref', f => { f.evidence.source.workflowRef = 'attacker/repo/.github/workflows/other.yml@refs/heads/main' }],
  ['wrong evidence workflow SHA', f => { f.evidence.source.workflowSha = 'fedcba9876543210fedcba9876543210fedcba98' }],
  ['wrong source commit', f => { f.runMetadata.head_sha = 'fedcba9876543210fedcba9876543210fedcba98' }],
  ['wrong subject digest', f => { f.verification[0].verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64) }],
  ['wrong predicate type', f => { f.verification[0].verificationResult.statement.predicateType = 'https://example.invalid/predicate' }],
  ['wrong run attempt', f => { f.runMetadata.run_attempt = 2 }],
  ['missing certificate issuer', f => { delete f.verification[0].verificationResult.signature.certificate.issuer }],
  ['self-hosted runner', f => { f.verification[0].verificationResult.signature.certificate.runnerEnvironment = 'self-hosted' }],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture()
    mutate(f)
    assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
  })
}
