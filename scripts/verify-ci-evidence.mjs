import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const REPOSITORY = 'jack-001-a/deepseek-harness-session-delete'
const REF = 'refs/heads/main'
const WORKFLOW = `${REPOSITORY}/.github/workflows/trusted-ci-evidence.yml`
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const REPOSITORY_ID = '1428060802'
const OWNER_ID = '320086254'

function fail(message, status = 'provenance_rejected') {
  const error = new Error(`provenance policy rejected: ${message}`)
  error.status = status
  throw error
}

function runGitHubCli(args, label) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? '').trim().slice(0, 500)
    const unavailable = error.code === 'ENOENT' ||
      /no attestations|no attestation|not found|HTTP 401|HTTP 403|HTTP 404|unauthorized|forbidden|authentication required|failed to connect|timeout|rate limit/i.test(detail)
    fail(`${label}: ${detail || 'GitHub CLI request failed'}`, unavailable ? 'provenance_unavailable' : 'provenance_rejected')
  }
}

export function evaluateAttestationPolicy({ verification, runMetadata, evidence, artifactBytes }) {
  if (!Array.isArray(verification) || verification.length === 0) fail('no verified attestations returned', 'provenance_unavailable')

  const artifactDigest = createHash('sha256').update(artifactBytes).digest('hex')
  const expectedCommit = evidence?.source?.commit
  const expectedRunId = String(runMetadata?.id ?? '')
  const expectedAttempt = String(runMetadata?.run_attempt ?? '')

  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) fail('evidence source commit is not a full SHA')
  if (!/^[a-f0-9]{40}$/.test(evidence?.source?.workflowSha ?? '')) fail('evidence workflow SHA is not a full SHA')
  if (evidence?.source?.refProtected !== true) fail('evidence does not record a protected ref')
  if (evidence?.source?.repository !== REPOSITORY || evidence?.source?.ref !== REF) fail('evidence repository/ref mismatch')
  if (!/^\d+$/.test(expectedRunId) || !/^\d+$/.test(expectedAttempt)) fail('GitHub run metadata is incomplete')
  if (runMetadata?.repository?.full_name !== REPOSITORY) fail('run repository mismatch')
  if (String(runMetadata?.repository?.id ?? '') !== REPOSITORY_ID) fail('run repository immutable ID mismatch')
  if (runMetadata?.head_sha !== expectedCommit) fail('run head SHA does not match evidence source commit')
  if (runMetadata?.event !== 'push' && runMetadata?.event !== 'workflow_dispatch') fail('run event is not allowed')
  if (evidence?.source?.event !== runMetadata.event) fail('evidence event does not match GitHub run metadata')
  if (runMetadata?.head_branch !== 'main') fail('run is not for main')
  if (!String(runMetadata?.path ?? '').startsWith('.github/workflows/trusted-ci-evidence.yml@')) fail('run workflow path mismatch')
  if (String(runMetadata?.run_attempt) !== String(evidence?.source?.runAttempt)) fail('run attempt does not match evidence')
  if (String(runMetadata?.id) !== String(evidence?.source?.runId)) fail('run ID does not match evidence')
  if (evidence?.source?.workflowRef !== `${WORKFLOW}@${REF}`) fail('evidence workflow ref mismatch')

  const accepted = []
  for (const entry of verification) {
    const result = entry?.verificationResult
    const certificate = result?.signature?.certificate
    const statement = result?.statement
    if (!certificate || !statement) continue
    if (statement.predicateType !== 'https://slsa.dev/provenance/v1') continue

    // These certificate claims are populated from GitHub's OIDC token. Do not
    // fall back to statement.predicate for identity: that content is workflow-controlled.
    const repositoryUri = certificate.sourceRepositoryURI
    const repositoryId = certificate.sourceRepositoryIdentifier
    const ownerUri = certificate.sourceRepositoryOwnerURI
    const ownerId = certificate.sourceRepositoryOwnerIdentifier
    const sourceRef = certificate.sourceRepositoryRef
    const sourceDigest = certificate.sourceRepositoryDigest
    const san = certificate.subjectAlternativeName
    const sanValue = san?.type === 'URI' && typeof san.value === 'string' ? san.value : undefined
    const issuer = certificate.issuer
    const runnerEnvironment = certificate.runnerEnvironment
    const workflowRef = certificate.buildSignerURI
    const workflowDigest = certificate.buildConfigDigest
    const signerDigest = certificate.buildSignerDigest
    const buildConfigUri = certificate.buildConfigURI
    const trigger = certificate.buildTrigger
    const invocation = certificate.runInvocationURI

    if (repositoryUri !== `https://github.com/${REPOSITORY}`) continue
    if (sourceRef !== REF) continue
    if (repositoryId !== REPOSITORY_ID || ownerId !== OWNER_ID) continue
    if (ownerUri !== 'https://github.com/jack-001-a') continue
    if (sourceDigest !== expectedCommit) continue
    if (issuer !== OIDC_ISSUER) continue
    if (runnerEnvironment !== 'github-hosted') continue
    if (workflowRef !== `https://github.com/${WORKFLOW}@${REF}`) continue
    if (sanValue !== `https://github.com/${WORKFLOW}@${REF}`) continue
    if (buildConfigUri !== `https://github.com/${WORKFLOW}@${REF}`) continue
    if (signerDigest !== evidence.source.workflowSha) continue
    if (workflowDigest !== evidence.source.workflowSha) continue
    if (trigger !== runMetadata.event) continue
    if (invocation !== `https://github.com/${REPOSITORY}/actions/runs/${expectedRunId}/attempts/${expectedAttempt}`) continue

    const subjectMatches = (statement.subject ?? []).some(subject =>
      subject?.digest?.sha256 === artifactDigest
    )
    if (!subjectMatches) continue

    accepted.push({ subjectDigest: artifactDigest, sourceCommit: expectedCommit })
  }

  if (accepted.length === 0) fail('no attestation certificate and subject satisfy repository/ref/workflow/issuer/commit policy')
  return {
    status: 'provenance_verified',
    repository: REPOSITORY,
    ref: REF,
    sourceCommit: expectedCommit,
    runId: expectedRunId,
    runAttempt: expectedAttempt,
    subjectSha256: artifactDigest,
    verifiedAttestations: accepted.length,
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1 && args.length !== 3) {
    throw new Error('usage: node scripts/verify-ci-evidence.mjs <evidence-json> [<gh-verification-json> <github-run-metadata-json>]')
  }

  const artifactPath = args[0]
  const artifactBytes = await readFile(artifactPath)
  const evidence = JSON.parse(artifactBytes.toString('utf8'))
  let verification
  let runMetadata

  if (args.length === 1) {
    const runId = String(evidence?.source?.runId ?? '')
    const attempt = String(evidence?.source?.runAttempt ?? '')
    const commit = String(evidence?.source?.commit ?? '')
    if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt) || !/^[a-f0-9]{40}$/.test(commit)) {
      fail('evidence cannot safely identify a GitHub run attempt')
    }
    const commonArgs = [
      '--repo', REPOSITORY,
      '--signer-workflow', WORKFLOW,
      '--signer-digest', evidence.source.workflowSha,
      '--source-ref', REF,
      '--source-digest', commit,
      '--cert-identity', `https://github.com/${WORKFLOW}@${REF}`,
      '--cert-oidc-issuer', OIDC_ISSUER,
      '--predicate-type', 'https://slsa.dev/provenance/v1',
      '--deny-self-hosted-runners',
    ]
    verification = JSON.parse(runGitHubCli([
      'attestation', 'verify', artifactPath, ...commonArgs, '--format', 'json',
    ], 'GitHub attestation verification failed'))
    runMetadata = JSON.parse(runGitHubCli([
      'api', `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    ], 'GitHub workflow-run metadata lookup failed'))
  } else {
    const [, verificationPath, runMetadataPath] = args
    ;[verification, runMetadata] = await Promise.all([
      readFile(verificationPath, 'utf8').then(JSON.parse),
      readFile(runMetadataPath, 'utf8').then(JSON.parse),
    ])
  }

  const result = evaluateAttestationPolicy({ verification, runMetadata, evidence, artifactBytes })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ status: error.status ?? 'provenance_rejected', reason: error.message }) + '\n')
    process.exitCode = 1
  })
}
