import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertProviderAdapter, assertStorageAdapter, lifecycleCapability } from './fixture-contract.mjs'

function storageAdapter() {
  const adapter = { name: 'jsonl-fixture' }
  for (const key of ['start', 'stop', 'create', 'openRead', 'openWrite']) adapter[key] = async () => {}
  return adapter
}

test('legacy storage provider is valid but explicitly lifecycle-unsupported', () => {
  const adapter = storageAdapter()
  assert.equal(assertStorageAdapter(adapter), adapter)
  assert.deepEqual(lifecycleCapability(adapter), {
    supported: false,
    reason: 'provider-lifecycle-unsupported',
  })
  assert.throws(() => assertProviderAdapter(adapter), /does not support lifecycle conformance/)
})

test('provider cannot claim lifecycle support without all lifecycle operations', () => {
  const adapter = storageAdapter()
  adapter.lifecycle = { supported: true, retire: async () => {} }
  assert.throws(() => lifecycleCapability(adapter), /missing: restore, purge, inspect, inspectById, inspectOperation/)
})

test('fully capable lifecycle adapter is accepted only with explicit capability declaration', () => {
  const adapter = storageAdapter()
  adapter.lifecycle = { supported: true }
  for (const key of ['retire', 'restore', 'purge', 'inspect', 'inspectById', 'inspectOperation']) adapter.lifecycle[key] = async () => {}
  assert.equal(assertProviderAdapter(adapter).lifecycle, adapter.lifecycle)
})
