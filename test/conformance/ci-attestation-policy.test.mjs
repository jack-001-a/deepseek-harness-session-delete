import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evaluateAttestationPolicy } from '../../scripts/verify-ci-evidence.mjs'

const repository = 'jack-001-a/deepseek-harness-session-delete'
const workflow = `${repository}/.github/workflows/trusted-ci-evidence.yml`
const commit = '0123456789abcdef0123456789abcdef01234567'
const bytes = Buffer.from('{"schemaVersion":1,"status":"PASS"}\\n')
const digest = createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const evidence = {
    source: { repository, ref: 'refs/heads/main', commit, runId: '123456789', runAttempt: '1' },
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
          SourceRepositoryURI: `https://github.com/${repository}`,
          SourceRepositoryIdentifier: '1428060802',
          SourceRepositoryOwnerIdentifier: '320086254',
          SourceRepositoryRef: 'refs/heads/main',
          SourceRepositoryDigest: commit,
          subjectAlternativeName: `https://github.com/${workflow}@refs/heads/main`,
          Issuer: 'https://token.actions.githubusercontent.com',
          BuildSignerURI: `https://github.com/${workflow}@refs/heads/main`,
          BuildTrigger: 'push',
          RunInvocationURI: `https://github.com/${repository}/actions/runs/123456789/attempts/1`,
        },
      },
      statement: { subject: [{ name: 'ci-evidence.json', digest: { sha256: digest } }] },
    },
  }]
  return { evidence, runMetadata, verification, artifactBytes: bytes }
}

test('accepts a verified certificate and exact subject bound to independent GitHub run metadata', () => {
  const result = evaluateAttestationPolicy(fixture())
  assert.equal(result.status, 'provenance_verified')
  assert.equal(result.sourceCommit, commit)
  assert.equal(result.subjectSha256, digest)
})

for (const [name, mutate] of [
  ['wrong repository', f => { f.verification[0].verificationResult.signature.certificate.SourceRepositoryURI = 'https://github.com/attacker/repo' }],
  ['wrong immutable repository identity', f => { f.verification[0].verificationResult.signature.certificate.SourceRepositoryIdentifier = '999' }],
  ['wrong workflow identity', f => { f.verification[0].verificationResult.signature.certificate.BuildSignerURI = 'https://github.com/attacker/other.yml@refs/heads/main' }],
  ['wrong ref', f => { f.verification[0].verificationResult.signature.certificate.SourceRepositoryRef = 'refs/heads/feature' }],
  ['wrong event', f => { f.runMetadata.event = 'pull_request' }],
  ['wrong source commit', f => { f.runMetadata.head_sha = 'fedcba9876543210fedcba9876543210fedcba98' }],
  ['wrong subject digest', f => { f.verification[0].verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64) }],
  ['wrong run attempt', f => { f.runMetadata.run_attempt = 2 }],
  ['missing certificate issuer', f => { delete f.verification[0].verificationResult.signature.certificate.Issuer }],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture()
    mutate(f)
    assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
  })
}
