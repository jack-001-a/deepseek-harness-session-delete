import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertMinimumGitHubCliVersion, buildAttestationVerifyArgs, evaluateAttestationPolicy, getOnlineVerificationCoordinates } from '../../scripts/verify-ci-evidence.mjs'

const repository = 'jack-001-a/deepseek-harness-session-delete'
const workflow = `${repository}/.github/workflows/trusted-ci-evidence.yml`
const signerWorkflow = `${repository}/.github/workflows/trusted-ci-evidence-reusable.yml`
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
    repository: { full_name: repository, id: 1428060802, owner: { login: 'jack-001-a', id: 320086254 } },
    status: 'completed',
    conclusion: 'success',
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/trusted-ci-evidence.yml@refs/heads/main',
  }
  const verification = [{
    attestation: { bundle: { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3' } },
    verificationResult: {
      signature: {
        certificate: {
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryIdentifier: '1428060802',
          sourceRepositoryOwnerURI: 'https://github.com/jack-001-a',
          sourceRepositoryOwnerIdentifier: '320086254',
          sourceRepositoryRef: 'refs/heads/main',
          sourceRepositoryDigest: commit,
          subjectAlternativeName: { type: 'URI', value: `https://github.com/${signerWorkflow}@refs/heads/main` },
          issuer: 'https://token.actions.githubusercontent.com',
          runnerEnvironment: 'github-hosted',
          buildSignerURI: `https://github.com/${signerWorkflow}@refs/heads/main`,
          buildSignerDigest: commit,
          buildConfigURI: `https://github.com/${workflow}@refs/heads/main`,
          buildConfigDigest: workflowSha,
          buildTrigger: 'push',
          githubWorkflowRepository: repository,
          githubWorkflowRef: 'refs/heads/main',
          githubWorkflowSHA: commit,
          githubWorkflowTrigger: 'push',
          runInvocationURI: `https://github.com/${repository}/actions/runs/123456789/attempts/1`,
        },
      },
      statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: 'ci-evidence.json', digest: { sha256: digest } }] },
      verifiedTimestamps: [{ type: 'Tlog', uri: 'https://rekor.example.invalid', timestamp: '2026-11-20T00:00:00Z' }],
    },
  }]
  return { evidence, runMetadata, verification, artifactBytes: bytes }
}

for (const version of [
  'gh version 2.102.0 (2026-09-30)',
  'gh version 2.103.1 (2026-10-01)',
  'gh version 3.0.0 (2027-01-01)',
]) {
  test('accepts patched GitHub CLI version: ' + version, () => {
    assert.doesNotThrow(() => assertMinimumGitHubCliVersion(version))
  })
}

for (const version of [
  'gh version 2.101.0 (2026-09-29)',
  'gh version 2.9.0 (2026-01-01)',
  'gh version 2.102.0-rc.1',
  'GitHub CLI version unavailable',
  '',
]) {
  test('rejects unsafe or unrecognized GitHub CLI version: ' + version, () => {
    assert.throws(() => assertMinimumGitHubCliVersion(version), /provenance policy rejected/)
  })
}

test('builds a pinned GitHub attestation verification command', () => {
  const args = buildAttestationVerifyArgs('./ci-evidence.json', { runId: '123456789', attempt: '2', commit, workflowSha, signerSha: commit })
  assert.deepEqual(args, [
    'attestation', 'verify', './ci-evidence.json',
    '--repo', repository,
    '--signer-workflow', signerWorkflow,
    '--signer-digest', commit,
    '--source-ref', 'refs/heads/main',
    '--source-digest', commit,
    '--cert-identity', `https://github.com/${signerWorkflow}@refs/heads/main`,
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--predicate-type', 'https://slsa.dev/provenance/v1',
    '--deny-self-hosted-runners',
    '--format', 'json',
  ])
})

for (const [name, coordinates] of [
  ['nonnumeric run ID', { runId: '../123', attempt: '1', commit, workflowSha }],
  ['nonnumeric attempt', { runId: '123', attempt: '1/2', commit, workflowSha }],
  ['short commit', { runId: '123', attempt: '1', commit: 'abc', workflowSha }],
  ['short workflow SHA', { runId: '123', attempt: '1', commit, workflowSha: 'abc' }],
]) {
  test('rejects unsafe attestation CLI coordinates: ' + name, () => {
    assert.throws(() => buildAttestationVerifyArgs('./ci-evidence.json', coordinates), /provenance policy rejected/)
  })
}

test('validates online lookup coordinates before any GitHub CLI request', () => {
  const f = fixture()
  assert.deepEqual(getOnlineVerificationCoordinates(f.evidence), { runId: '123456789', attempt: '1', commit, workflowSha, signerSha: commit })
})

for (const [name, mutate] of [
  ['missing workflow SHA', source => { delete source.workflowSha }],
  ['abbreviated source commit', source => { source.commit = commit.slice(0, 12) }],
  ['non-numeric run ID', source => { source.runId = '../runs/123' }],
  ['non-numeric run attempt', source => { source.runAttempt = '1/../../2' }],
  ['unapproved event', source => { source.event = 'pull_request' }],
  ['unprotected ref claim', source => { source.refProtected = false }],
  ['wrong workflow ref', source => { source.workflowRef = 'attacker/repo/.github/workflows/evil.yml@refs/heads/main' }],
]) {
  test('rejects online lookup coordinates with ' + name, () => {
    const f = fixture()
    mutate(f.evidence.source)
    assert.throws(() => getOnlineVerificationCoordinates(f.evidence), /provenance policy rejected/)
  })
}

test('rejects verified output entries without certificate or statement', () => {
  const f = fixture()
  f.verification = [{ verificationResult: { statement: f.verification[0].verificationResult.statement } }]
  assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
})

test('ignores an invalid attestation entry when a later entry satisfies the full policy', () => {
  const f = fixture()
  f.verification.unshift({ verificationResult: { signature: { certificate: {} }, statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [] } } })
  assert.equal(evaluateAttestationPolicy(f).status, 'provenance_verified')
})
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
  ['wrong signer digest', f => { f.verification[0].verificationResult.signature.certificate.buildSignerDigest = workflowSha }],
  ['wrong build config URI', f => { f.verification[0].verificationResult.signature.certificate.buildConfigURI = 'https://github.com/attacker/other.yml@refs/heads/main' }],
  ['wrong workflow revision', f => { f.verification[0].verificationResult.signature.certificate.buildConfigDigest = commit }],
  ['wrong ref', f => { f.verification[0].verificationResult.signature.certificate.sourceRepositoryRef = 'refs/heads/feature' }],
  ['wrong event', f => { f.runMetadata.event = 'pull_request' }],
  ['wrong run ID', f => { f.runMetadata.id = 987654321 }],
  ['wrong run repository', f => { f.runMetadata.repository.full_name = 'attacker/repo' }],
  ['wrong run owner', f => { f.runMetadata.repository.owner.login = 'attacker' }],
  ['wrong immutable run owner ID', f => { f.runMetadata.repository.owner.id = 999 }],
  ['in-progress workflow run', f => { f.runMetadata.status = 'in_progress' }],
  ['failed workflow run', f => { f.runMetadata.conclusion = 'failure' }],
  ['workflow path with attacker suffix', f => { f.runMetadata.path += '-attacker' }],
  ['workflow path on non-main ref', f => { f.runMetadata.path = '.github/workflows/trusted-ci-evidence.yml@refs/heads/attacker' }],
  ['wrong workflow path', f => { f.runMetadata.path = '.github/workflows/other.yml@main' }],
  ['wrong evidence workflow ref', f => { f.evidence.source.workflowRef = 'attacker/repo/.github/workflows/other.yml@refs/heads/main' }],
  ['wrong evidence workflow SHA', f => { f.evidence.source.workflowSha = 'fedcba9876543210fedcba9876543210fedcba98' }],
  ['wrong source commit', f => { f.runMetadata.head_sha = 'fedcba9876543210fedcba9876543210fedcba98' }],
  ['wrong subject digest', f => { f.verification[0].verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64) }],
  ['wrong predicate type', f => { f.verification[0].verificationResult.statement.predicateType = 'https://example.invalid/predicate' }],
  ['wrong run attempt', f => { f.runMetadata.run_attempt = 2 }],
  ['missing certificate issuer', f => { delete f.verification[0].verificationResult.signature.certificate.issuer }],
  ['wrong GitHub workflow repository claim', f => { f.verification[0].verificationResult.signature.certificate.githubWorkflowRepository = 'attacker/repo' }],
  ['wrong GitHub workflow ref claim', f => { f.verification[0].verificationResult.signature.certificate.githubWorkflowRef = 'refs/heads/attacker' }],
  ['wrong GitHub workflow SHA claim', f => { f.verification[0].verificationResult.signature.certificate.githubWorkflowSHA = workflowSha }],
  ['wrong GitHub workflow trigger claim', f => { f.verification[0].verificationResult.signature.certificate.githubWorkflowTrigger = 'pull_request' }],
  ['self-hosted runner', f => { f.verification[0].verificationResult.signature.certificate.runnerEnvironment = 'self-hosted' }],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture()
    mutate(f)
    assert.throws(() => evaluateAttestationPolicy(f), /provenance policy rejected/)
  })
}


test('accepts certificates without deprecated GitHub-specific extensions when generic claims satisfy policy', () => {
  const f = fixture()
  const certificate = f.verification[0].verificationResult.signature.certificate
  delete certificate.githubWorkflowRepository
  delete certificate.githubWorkflowRef
  delete certificate.githubWorkflowSHA
  delete certificate.githubWorkflowTrigger
  assert.equal(evaluateAttestationPolicy(f).status, 'provenance_verified')
})

test('does not trust workflow-controlled predicate metadata for certificate identity', () => {
  const f = fixture()
  f.verification[0].verificationResult.statement.predicate = {
    buildDefinition: {
      buildType: 'https://attacker.invalid/workflow',
      externalParameters: { workflow: { ref: 'refs/heads/attacker', repository: 'attacker/repo' } },
    },
  }
  assert.equal(evaluateAttestationPolicy(f).status, 'provenance_verified')
})
