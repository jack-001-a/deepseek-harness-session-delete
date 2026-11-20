import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  armProviderFault,
  assertProviderFaultInjector,
  disarmProviderFault,
  waitForProviderFaultHit,
  assertBoundaryAttestation,
  withProviderFault,
} from './provider-fault-contract.mjs'

function fixture(hitOverride = {}, disarmResult = true) {
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
      async disarm(handle) { calls.push(['disarm', handle]); return disarmResult },
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
  reviewedAtCommit: '0123456789abcdef0123456789abcdef01234567',
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
  const hit = await waitForProviderFaultHit(armed, { expectedBoundary })
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

test('provider boundary map must pin an immutable source revision', () => {
  assert.throws(() => assertBoundaryAttestation(
    { boundary: { ...expectedBoundary, reviewedAtCommit: 'main' } },
    { ...expectedBoundary, reviewedAtCommit: 'main' },
  ), /full source commit SHA/)
})


test('provider fault scenario always disarms after a successful callback', async () => {
  const { adapter, calls } = fixture()
  const value = await withProviderFault(adapter, request, expectedBoundary, async (hit) => {
    assert.equal(hit.actionApplied, true)
    return 'scenario-result'
  })
  assert.equal(value, 'scenario-result')
  assert.deepEqual(calls.map(([kind]) => kind), ['arm', 'hit', 'disarm'])
})

test('provider fault scenario disarms when hit verification fails', async () => {
  const { adapter, calls } = fixture({ actionApplied: false })
  await assert.rejects(
    withProviderFault(adapter, request, expectedBoundary, async () => assert.fail('callback must not run')),
    /not proven/,
  )
  assert.deepEqual(calls.map(([kind]) => kind), ['arm', 'hit', 'disarm'])
})

test('provider fault cleanup failure fails an otherwise successful scenario', async () => {
  const { adapter } = fixture({}, false)
  await assert.rejects(
    withProviderFault(adapter, request, expectedBoundary, async () => 'ignored'),
    /disarm did not confirm cleanup/,
  )
})

test('provider fault scenario preserves both scenario and cleanup failures', async () => {
  const { adapter } = fixture({}, false)
  await assert.rejects(
    withProviderFault(adapter, request, expectedBoundary, async () => {
      throw new Error('scenario exploded')
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.match(error.errors[0].message, /scenario exploded/)
      assert.match(error.errors[1].message, /disarm did not confirm cleanup/)
      return true
    },
  )
})

test('provider fault scenario requires an explicit callback and trusted boundary map', async () => {
  const { adapter } = fixture()
  await assert.rejects(withProviderFault(adapter, request, null, async () => {}), /independently maintained/)
  await assert.rejects(withProviderFault(adapter, request, expectedBoundary, null), /requires a callback/)
})
