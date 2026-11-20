import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const REPOSITORY = 'jack-001-a/deepseek-harness-session-delete'
const REF = 'refs/heads/main'
const WORKFLOW = `${REPOSITORY}/.github/workflows/trusted-ci-evidence.yml`
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const REPOSITORY_ID = '1428060802'
const OWNER_ID = '320086254'

function first(object, names) {
  for (const name of names) {
    const value = object?.[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function fail(message) {
  throw new Error(`provenance policy rejected: ${message}`)
}

export function evaluateAttestationPolicy({ verification, runMetadata, evidence, artifactBytes }) {
  if (!Array.isArray(verification) || verification.length === 0) fail('no verified attestations returned')

  const artifactDigest = createHash('sha256').update(artifactBytes).digest('hex')
  const expectedCommit = evidence?.source?.commit
  const expectedRunId = String(runMetadata?.id ?? '')
  const expectedAttempt = String(runMetadata?.run_attempt ?? '')

  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) fail('evidence source commit is not a full SHA')
  if (evidence?.source?.refProtected !== true) fail('evidence does not record a protected ref')
  if (!/^\d+$/.test(expectedRunId) || !/^\d+$/.test(expectedAttempt)) fail('GitHub run metadata is incomplete')
  if (runMetadata?.repository?.full_name !== REPOSITORY) fail('run repository mismatch')
  if (String(runMetadata?.repository?.id ?? '') !== REPOSITORY_ID) fail('run repository immutable ID mismatch')
  if (runMetadata?.head_sha !== expectedCommit) fail('run head SHA does not match evidence source commit')
  if (runMetadata?.event !== 'push' && runMetadata?.event !== 'workflow_dispatch') fail('run event is not allowed')
  if (runMetadata?.head_branch !== 'main') fail('run is not for main')
  if (!String(runMetadata?.path ?? '').startsWith('.github/workflows/trusted-ci-evidence.yml@')) fail('run workflow path mismatch')
  if (String(runMetadata?.run_attempt) !== String(evidence?.source?.runAttempt)) fail('run attempt does not match evidence')
  if (String(runMetadata?.id) !== String(evidence?.source?.runId)) fail('run ID does not match evidence')

  const accepted = []
  for (const entry of verification) {
    const result = entry?.verificationResult
    const certificate = result?.signature?.certificate
    const statement = result?.statement
    if (!certificate || !statement) continue

    // These certificate claims are populated from GitHub's OIDC token. Do not
    // fall back to statement.predicate for identity: that content is workflow-controlled.
    const repositoryUri = first(certificate, ['sourceRepositoryURI', 'SourceRepositoryURI', 'sourceRepository', 'SourceRepository'])
    const repositoryId = first(certificate, ['sourceRepositoryIdentifier', 'SourceRepositoryIdentifier'])
    const ownerId = first(certificate, ['sourceRepositoryOwnerIdentifier', 'SourceRepositoryOwnerIdentifier'])
    const sourceRef = first(certificate, ['sourceRepositoryRef', 'SourceRepositoryRef'])
    const sourceDigest = first(certificate, ['sourceRepositoryDigest', 'SourceRepositoryDigest'])
    const san = first(certificate, ['subjectAlternativeName', 'SubjectAlternativeName', 'san', 'SAN'])
    const issuer = first(certificate, ['issuer', 'oidcIssuer', 'Issuer'])
    const workflowRef = first(certificate, ['buildSignerURI', 'BuildSignerURI', 'workflowRef'])
    const trigger = first(certificate, ['buildTrigger', 'BuildTrigger'])
    const invocation = first(certificate, ['runInvocationURI', 'RunInvocationURI'])

    if (repositoryUri !== `https://github.com/${REPOSITORY}` && repositoryUri !== REPOSITORY) continue
    if (sourceRef !== REF) continue
    if (repositoryId !== REPOSITORY_ID || ownerId !== OWNER_ID) continue
    if (sourceDigest !== expectedCommit) continue
    if (issuer !== OIDC_ISSUER) continue
    if (workflowRef !== `https://github.com/${WORKFLOW}@${REF}`) continue
    if (trigger !== runMetadata.event) continue
    if (invocation !== `https://github.com/${REPOSITORY}/actions/runs/${expectedRunId}/attempts/${expectedAttempt}`) continue
    if (san && !san.includes(WORKFLOW)) continue

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
  const [artifactPath, verificationPath, runMetadataPath] = process.argv.slice(2)
  if (!artifactPath || !verificationPath || !runMetadataPath) {
    throw new Error('usage: node scripts/verify-ci-evidence.mjs <evidence-json> <gh-verification-json> <github-run-metadata-json>')
  }
  const [artifactBytes, verification, runMetadata] = await Promise.all([
    readFile(artifactPath),
    readFile(verificationPath, 'utf8').then(JSON.parse),
    readFile(runMetadataPath, 'utf8').then(JSON.parse),
  ])
  const evidence = JSON.parse(artifactBytes.toString('utf8'))
  const result = evaluateAttestationPolicy({ verification, runMetadata, evidence, artifactBytes })
  process.stdout.write(JSON.stringify(result, null, 2) + '\\n')
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`${error.message}\\n`)
    process.exitCode = 1
  })
}
