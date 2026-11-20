import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  armProviderFault,
  assertProviderFaultInjector,
  disarmProviderFault,
  waitForProviderFaultHit,
  assertBoundaryAttestation,
} from './provider-fault-contract.mjs'

function fixture(hitOverride = {}) {
  const calls = []
  const adapter = {
    name: 'contract-fixture',
    faultInjection: {
      supported: true,
      async arm(request) { calls.push(['arm', request]); return { id: 'fault-1' } },
      async waitForHit(handle) {
        calls.push(['hit', handle])
        return {
          hit: true,
          actionApplied: true,
          faultId: handle.id,
          point: 'retire.commit',
          phase: 'after-commit-before-response',
          action: 'kill',
          operationId: 'op-123',
          boundaryId: 'sqlite-transaction-commit',
          boundary: { ...expectedBoundary },
          ...hitOverride,
        }
      },
      async disarm(handle) { calls.push(['disarm', handle]); return true },
    },
  }
  return { adapter, calls }
}

const expectedBoundary = {
  provider: 'sqlite-fixture',
  providerVersion: 'test-build-1',
  point: 'retire.commit',
  phase: 'after-commit-before-response',
  operation: 'retire',
  durabilityPrimitive: 'sqlite-commit',
  sourceRef: 'src/sqlite-lifecycle.ts#commitRetirement',
  reviewedAtCommit: 'provider-source-sha',
}

const request = {
  point: 'retire.commit',
  phase: 'after-commit-before-response',
  action: 'kill',
  operationId: 'op-123',
}

test('provider fault hooks require explicit support and all lifecycle methods', () => {
  assert.throws(() => assertProviderFaultInjector({ name: 'unsupported' }), /does not expose/)
  assert.throws(() => assertProviderFaultInjector({
    name: 'incomplete',
    faultInjection: { supported: true, arm() {} },
  }), /waitForHit/)
})

test('provider fault request rejects unsupported phases and missing operation identity', async () => {
  const { adapter } = fixture()
  await assert.rejects(armProviderFault(adapter, { ...request, phase: 'after-commit' }), /fault request/)
  await assert.rejects(armProviderFault(adapter, { ...request, operationId: '' }), /fault request/)
})

test('provider fault hit must prove the exact action at a correlated durable boundary', async () => {
  const { adapter } = fixture({ actionApplied: false })
  const armed = await armProviderFault(adapter, request)
  await assert.rejects(waitForProviderFaultHit(armed, { expectedBoundary }), /not proven/)
  await disarmProviderFault(armed)
})

test('provider fault contract correlates arm, hit, and disarm', async () => {
  const { adapter, calls } = fixture()
  const armed = await armProviderFault(adapter, request)
  const hit = await waitForProviderFaultHit(armed)
  assert.equal(hit.boundaryId, 'sqlite-transaction-commit')
  assert.equal(hit.boundary.durabilityPrimitive, 'sqlite-commit')
  assert.equal(hit.operationId, request.operationId)
  assert.equal(await disarmProviderFault(armed), true)
  assert.deepEqual(calls.map(([kind]) => kind), ['arm', 'hit', 'disarm'])
})

test('provider boundary attestation rejects adapter self-report drift', () => {
  assert.throws(() => assertBoundaryAttestation({ boundary: { ...expectedBoundary, sourceRef: 'unreviewed.ts#fake' } }, expectedBoundary), /trusted provider boundary map/)
  assert.throws(() => assertBoundaryAttestation({ boundary: { ...expectedBoundary } }, { ...expectedBoundary, reviewedAtCommit: '' }), /expectation is incomplete/)
})
