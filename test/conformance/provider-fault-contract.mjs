/** Adapter-side contract for faults at real Provider durability boundaries.
 * This validates the adapter's test-hook protocol; it cannot prove that a Provider
 * places a hook at the correct storage instruction without provider-specific tests.
 */
export const PROVIDER_FAULT_PHASES = Object.freeze([
  'before-commit',
  'after-commit-before-response',
  'outcome-unknown',
])
const ACTIONS = new Set(['pause', 'error', 'kill'])

const DURABILITY_PRIMITIVES = new Set([
  'file-sync',
  'directory-sync',
  'sqlite-commit',
  'atomic-rename',
  'provider-journal-commit',
])

function requireText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Compare provider-reported boundary metadata with a separately maintained
 * provider-specific expectation. Adapter self-report alone is not attestation.
 */
export function assertBoundaryAttestation(hit, expected) {
  const fields = [
    'provider',
    'providerVersion',
    'point',
    'phase',
    'operation',
    'durabilityPrimitive',
    'sourceRef',
    'reviewedAtCommit',
  ]
  if (!expected || fields.some((field) => !requireText(expected[field]))) {
    throw new TypeError('trusted boundary expectation is incomplete')
  }
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(expected.reviewedAtCommit)) {
    throw new TypeError('trusted boundary expectation must pin a full source commit SHA')
  }
  if (!PROVIDER_FAULT_PHASES.includes(expected.phase)) {
    throw new TypeError('trusted boundary expectation has an unsupported phase')
  }
  if (!DURABILITY_PRIMITIVES.has(expected.durabilityPrimitive)) {
    throw new TypeError('trusted boundary expectation has an unsupported durability primitive')
  }
  if (!hit?.boundary || fields.some((field) => hit.boundary[field] !== expected[field])) {
    throw new Error('provider boundary attestation does not match the trusted provider boundary map')
  }
  return Object.freeze({ ...expected })
}


function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Require explicit opt-in and the complete fault-hook surface; never silently skip. */
export function assertProviderFaultInjector(adapter) {
  const hooks = adapter?.faultInjection
  if (!hooks || hooks.supported !== true) {
    throw new Error(`provider ${adapter?.name || '<unnamed>'} does not expose provider fault injection`)
  }
  for (const method of ['arm', 'waitForHit', 'disarm']) {
    if (typeof hooks[method] !== 'function') throw new TypeError(`provider fault injection requires ${method}()`)
  }
  return hooks
}

/** Arm one named fault and require a provider-issued handle for later correlation. */
export async function armProviderFault(adapter, request) {
  const hooks = assertProviderFaultInjector(adapter)
  if (!request || !nonEmpty(request.point) || !PROVIDER_FAULT_PHASES.includes(request.phase) || !nonEmpty(request.operation) ||
      !ACTIONS.has(request.action) || !nonEmpty(request.operationId)) {
    throw new TypeError('fault request requires point, operation, supported phase/action, and operationId')
  }
  const handle = await hooks.arm(Object.freeze({ ...request }))
  if (!handle || !nonEmpty(handle.id)) throw new Error('provider fault arm did not return a fault handle')
  return Object.freeze({ hooks, handle, request: Object.freeze({ ...request }) })
}

/** A schedule is not evidence: require a correlated hit and an applied action. */
export async function waitForProviderFaultHit(armed, options) {
  if (!armed?.hooks || !armed?.handle || !armed?.request) throw new TypeError('armed provider fault is required')
  const { expectedBoundary, ...waitOptions } = options || {}
  const expected = armed.request
  assertBoundaryAttestation({ boundary: expectedBoundary }, expectedBoundary)
  if (expectedBoundary.point !== expected.point || expectedBoundary.phase !== expected.phase ||
      expectedBoundary.operation !== expected.operation) {
    throw new Error('trusted provider boundary map does not match the armed fault request')
  }
  const hit = await armed.hooks.waitForHit(armed.handle, waitOptions)
  if (!hit || hit.hit !== true || hit.actionApplied !== true ||
      hit.faultId !== armed.handle.id || hit.point !== expected.point ||
      hit.phase !== expected.phase || hit.operation !== expected.operation || hit.action !== expected.action ||
      hit.operationId !== expected.operationId || !nonEmpty(hit.boundaryId)) {
    throw new Error('provider fault hit was not proven at the requested durability boundary')
  }
  assertBoundaryAttestation(hit, expectedBoundary)
  return Object.freeze({ ...hit })
}

/** Disarm an armed hook; withProviderFault is preferred for guaranteed cleanup. */
export async function disarmProviderFault(armed) {
  if (!armed?.hooks || !armed?.handle) throw new TypeError('armed provider fault is required')
  return armed.hooks.disarm(armed.handle)
}


/**
 * Run one fault scenario with mandatory cleanup.
 *
 * Cleanup must return true. The independent verifier must establish the externally
 * observable action (for example, worker exit or persisted recovery evidence); the
 * adapter's actionApplied flag is not sufficient on its own. If both verification /
 * scenario and cleanup fail, preserve both failures in an AggregateError.
 */
export async function withProviderFault(adapter, request, expectedBoundary, run, waitOptions = {}) {
  if (typeof run !== 'function') throw new TypeError('provider fault scenario requires a callback')
  if (!expectedBoundary || typeof expectedBoundary !== 'object') {
    throw new TypeError('provider fault scenario requires an independently maintained boundary expectation')
  }
  if (typeof waitOptions?.verifyHit !== 'function') {
    throw new TypeError('provider fault scenario requires an independent hit verifier')
  }
  assertBoundaryAttestation({ boundary: expectedBoundary }, expectedBoundary)
  if (expectedBoundary.point !== request?.point || expectedBoundary.phase !== request?.phase ||
      expectedBoundary.operation !== request?.operation) {
    throw new Error('trusted provider boundary map does not match the armed fault request')
  }

  const armed = await armProviderFault(adapter, request)
  let value
  let verifiedEvidence
  let scenarioError
  try {
    const { verifyHit, ...hitWaitOptions } = waitOptions
    const hit = await waitForProviderFaultHit(armed, {
      ...hitWaitOptions,
      expectedBoundary,
    })
    const evidence = await verifyHit(hit, armed)
    const evidenceFields = [
      'observer',
      'effect',
      'artifactRef',
      'faultId',
      'operationId',
      'point',
      'phase',
      'operation',
      'action',
    ]
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
        evidence.verified !== true || evidenceFields.some((field) => !nonEmpty(evidence[field])) ||
        evidence.faultId !== hit.faultId || evidence.operationId !== hit.operationId ||
        evidence.point !== hit.point || evidence.phase !== hit.phase ||
        evidence.operation !== hit.operation || evidence.action !== hit.action) {
      throw new Error('independent provider fault verifier returned incomplete or mismatched evidence')
    }
    verifiedEvidence = Object.freeze({ ...evidence })
    value = await run(hit, armed, verifiedEvidence)
  } catch (error) {
    scenarioError = error
  }

  let cleanupError
  try {
    const disarmed = await disarmProviderFault(armed)
    if (disarmed !== true) throw new Error('provider fault disarm did not confirm cleanup')
  } catch (error) {
    cleanupError = error
  }

  if (scenarioError && cleanupError) {
    throw new AggregateError(
      [scenarioError, cleanupError],
      'provider fault scenario and mandatory cleanup both failed',
    )
  }
  if (scenarioError) throw scenarioError
  if (cleanupError) throw cleanupError
  return Object.freeze({ value, evidence: verifiedEvidence })
}
