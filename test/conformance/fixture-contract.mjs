/** Validate the minimum adapter surface without pretending a fake is provider conformance. */
export function assertProviderAdapter(adapter) {
  const required = ['name', 'start', 'stop', 'create', 'openRead', 'openWrite', 'retire', 'restore', 'purge', 'inspect']
  const missing = required.filter((key) => adapter?.[key] === undefined)
  if (missing.length) throw new TypeError(`provider adapter missing: ${missing.join(', ')}`)
  for (const key of required.slice(1)) {
    if (typeof adapter[key] !== 'function') throw new TypeError(`provider adapter ${key} must be a function`)
  }
  return adapter
}
