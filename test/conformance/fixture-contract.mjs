/** Validate the real storage seam separately from optional lifecycle capability. */
export function assertStorageAdapter(adapter) {
  const required = ['name', 'start', 'stop', 'create', 'openRead', 'openWrite']
  const missing = required.filter((key) => adapter?.[key] === undefined)
  if (missing.length) throw new TypeError(`storage adapter missing: ${missing.join(', ')}`)
  for (const key of required.slice(1)) {
    if (typeof adapter[key] !== 'function') throw new TypeError(`storage adapter ${key} must be a function`)
  }
  return adapter
}

/** Unsupported lifecycle is an explicit capability state, never inferred from method absence. */
export function lifecycleCapability(adapter) {
  assertStorageAdapter(adapter)
  const capability = adapter.lifecycle
  if (capability === undefined || capability === null || capability.supported === false) {
    return Object.freeze({ supported: false, reason: capability?.reason || 'provider-lifecycle-unsupported' })
  }
  if (capability.supported !== true) throw new TypeError('lifecycle capability must explicitly declare supported=true or supported=false')
  const required = ['retire', 'restore', 'purge', 'inspect', 'inspectById', 'inspectOperation']
  const missing = required.filter((key) => typeof capability[key] !== 'function')
  if (missing.length) throw new TypeError(`lifecycle capability missing: ${missing.join(', ')}`)
  return Object.freeze({ supported: true, api: capability })
}

/** Lifecycle suites may only execute against an explicitly supported provider capability. */
export function assertProviderAdapter(adapter) {
  const capability = lifecycleCapability(adapter)
  if (!capability.supported) throw new Error(`provider ${adapter.name} does not support lifecycle conformance: ${capability.reason}`)
  return { ...adapter, lifecycle: capability.api }
}
