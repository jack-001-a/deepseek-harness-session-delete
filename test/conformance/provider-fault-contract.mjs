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
  if (!request || !nonEmpty(request.point) || !PROVIDER_FAULT_PHASES.includes(request.phase) ||
      !ACTIONS.has(request.action) || !nonEmpty(request.operationId)) {
    throw new TypeError('fault request requires point, supported phase/action, and operationId')
  }
  const handle = await hooks.arm(Object.freeze({ ...request }))
  if (!handle || !nonEmpty(handle.id)) throw new Error('provider fault arm did not return a fault handle')
  return Object.freeze({ hooks, handle, request: Object.freeze({ ...request }) })
}

/** A schedule is not evidence: require a correlated hit and an applied action. */
export async function waitForProviderFaultHit(armed, options) {
  if (!armed?.hooks || !armed?.handle || !armed?.request) throw new TypeError('armed provider fault is required')
  const { expectedBoundary, ...waitOptions } = options || {}
  const hit = await armed.hooks.waitForHit(armed.handle, waitOptions)
  const expected = armed.request
  if (!hit || hit.hit !== true || hit.actionApplied !== true ||
      hit.faultId !== armed.handle.id || hit.point !== expected.point ||
      hit.phase !== expected.phase || hit.action !== expected.action ||
      hit.operationId !== expected.operationId || !nonEmpty(hit.boundaryId)) {
    throw new Error('provider fault hit was not proven at the requested durability boundary')
  }
  assertBoundaryAttestation(hit, expectedBoundary)
  return Object.freeze({ ...hit })
}

/** Always disarm in a finally block in the caller, including failed assertions. */
export async function disarmProviderFault(armed) {
  if (!armed?.hooks || !armed?.handle) throw new TypeError('armed provider fault is required')
  return armed.hooks.disarm(armed.handle)
}
