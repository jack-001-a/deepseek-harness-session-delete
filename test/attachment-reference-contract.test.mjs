import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AttachmentReferenceModel } from './helpers/attachment-reference-model.mjs'

const IMAGE = Object.freeze({ objectId: 'image-sha256-aaa', kind: 'image' })
const FILE_REPORT = Object.freeze({ objectId: 'file-sha256-bbb', kind: 'file', alias: 'report.pdf' })
const FILE_SUMMARY = Object.freeze({ objectId: 'file-sha256-bbb', kind: 'file', alias: 'summary.pdf' })
const GRACE = 100

function createModel() {
  let now = 1_000
  const model = new AttachmentReferenceModel({ now: () => now, graceMs: GRACE })
  model.setIndexComplete({ generation: 'generation-1' })
  return {
    model,
    now: () => now,
    advance: (milliseconds) => { now += milliseconds },
  }
}

function sessionOwner(sessionId, eventSeq = 1, slot = 'message.attachments[0]') {
  return { kind: 'session-event', sessionId, eventSeq, slot }
}

function commandOwner(sessionId = 'session-a', executionId = 'execution-1') {
  return { kind: 'command-execution', sessionId, executionId }
}

test('a published upload returns a reference only together with its staged lease', () => {
  const { model } = createModel()
  const result = model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })

  assert.deepEqual(result.reference, IMAGE)
  assert.match(result.leaseId, /^upload-lease-/)
  assert.equal(model.objectSnapshot(IMAGE.objectId).leaseCount, 1)
  assert.equal(model.objectSnapshot(IMAGE.objectId).ownerCount, 0)
})

test('a live staged upload is never a GC candidate, even after the grace period', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  advance(GRACE * 10)

  const report = model.collect()
  assert.equal(report.state, 'ready')
  assert.equal(report.objectCount, 0)
  assert.equal(model.hasObject(IMAGE.objectId), true)
})

test('committing a lease atomically replaces temporary ownership with a Session-event owner', () => {
  const { model } = createModel()
  const { leaseId } = model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  const owner = sessionOwner('session-a')

  assert.deepEqual(model.commitLease(leaseId, owner), { committed: true, idempotent: false })
  assert.equal(model.objectSnapshot(IMAGE.objectId).leaseCount, 0)
  assert.equal(model.hasOwner(IMAGE.objectId, owner), true)
  assert.equal(model.indexStatus().indexedReferenceCount, 1)
})

test('lease transfer is idempotent for the same owner and cannot be silently stolen', () => {
  const { model } = createModel()
  const { leaseId } = model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  const owner = sessionOwner('session-a')

  model.commitLease(leaseId, owner)
  assert.deepEqual(model.commitLease(leaseId, owner), { committed: true, idempotent: true })
  assert.throws(
    () => model.commitLease(leaseId, sessionOwner('session-b')),
    /unknown or released lease/,
  )
  assert.equal(model.objectSnapshot(IMAGE.objectId).ownerCount, 1)
})

test('retaining an existing event reference is idempotent', () => {
  const { model } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  const owner = sessionOwner('session-a')

  assert.deepEqual(model.retainReference(IMAGE, owner), { retained: true, idempotent: false })
  assert.deepEqual(model.retainReference(IMAGE, owner), { retained: true, idempotent: true })
  assert.equal(model.objectSnapshot(IMAGE.objectId).ownerCount, 1)
})

test('fork creates independent child owners that survive parent purge', () => {
  const { model } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  model.retainReference(IMAGE, sessionOwner('parent', 4, 'messages[3].image'))
  const fork = model.retainFork({
    childSessionId: 'child',
    references: [{
      reference: IMAGE,
      eventSeq: 4,
      slot: 'messages[3].image',
    }],
  })
  assert.equal(fork.retainedReferenceCount, 1)

  model.purgeSession('parent', { artifactRemoved: true })
  assert.equal(model.hasOwner(IMAGE.objectId, sessionOwner('parent', 4, 'messages[3].image')), false)
  assert.equal(model.hasOwner(IMAGE.objectId, sessionOwner('child', 4, 'messages[3].image')), true)
  assert.equal(model.collect().objectCount, 0)
})

test('Trash and Restore do not change attachment ownership', () => {
  const { model } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  const owner = sessionOwner('session-a')
  model.retainReference(IMAGE, owner)

  model.moveToTrash('session-a')
  const afterTrash = model.objectSnapshot(IMAGE.objectId)
  model.restoreSession('session-a')
  const afterRestore = model.objectSnapshot(IMAGE.objectId)

  assert.equal(afterTrash.ownerCount, 1)
  assert.equal(afterRestore.ownerCount, 1)
  assert.equal(model.hasOwner(IMAGE.objectId, owner), true)
})

test('purge refuses to release Session owners before the artifact is removed', () => {
  const { model } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  model.retainReference(IMAGE, sessionOwner('session-a'))

  assert.throws(() => model.purgeSession('session-a'), /artifact must be removed/)
  assert.equal(model.objectSnapshot(IMAGE.objectId).ownerCount, 1)
})

test('purging one Session releases only its Session-event owners, not command owners', () => {
  const { model } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  const transcriptOwner = sessionOwner('session-a')
  const execution = commandOwner()
  model.retainReference(IMAGE, transcriptOwner)
  model.retainReference(IMAGE, execution)

  assert.equal(model.purgeSession('session-a', { artifactRemoved: true }).releasedOwnerCount, 1)
  assert.equal(model.hasOwner(IMAGE.objectId, transcriptOwner), false)
  assert.equal(model.hasOwner(IMAGE.objectId, execution), true)
  assert.deepEqual(model.releaseOwner(execution), { releasedOwnerCount: 1, alreadyReleased: false })
  assert.deepEqual(model.releaseOwner(execution), { releasedOwnerCount: 0, alreadyReleased: true })
})

test('an active read lease blocks collection after the last durable owner is released', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  model.retainReference(IMAGE, sessionOwner('session-a'))
  const readLease = model.acquireReadLease(IMAGE, 'reader-a')
  model.purgeSession('session-a', { artifactRemoved: true })
  advance(GRACE * 2)

  assert.equal(model.collect().objectCount, 0)
  model.releaseReadLease(readLease)
  advance(GRACE)

  assert.equal(model.collect().objectCount, 1)
})

test('a stopped Host upload lease remains protected for the full recovery grace period', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  advance(GRACE * 2)

  assert.equal(model.collect().objectCount, 0, 'a process that is still live owns its staged lease')
  model.stopInstance('host-a')
  advance(GRACE - 1)
  assert.equal(model.collect().objectCount, 0, 'the dead process lease is still inside the grace period')
  advance(1)

  const preview = model.collect()
  assert.equal(preview.objectCount, 1)
  assert.equal(model.hasObject(IMAGE.objectId), true, 'dry-run never removes the object')

  const result = model.collect({ dryRun: false })
  assert.equal(result.collectedObjectCount, 1)
  assert.equal(model.hasObject(IMAGE.objectId), false)
})

test('an incomplete reference index fails closed for the entire collection pass', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  model.releaseLease('upload-lease-1')
  advance(GRACE)
  model.markIndexIncomplete('unknown-session-event')

  const report = model.collect({ dryRun: false })
  assert.equal(report.state, 'incomplete')
  assert.deepEqual(report.blockers, ['unknown-session-event'])
  assert.equal(model.hasObject(IMAGE.objectId), true)
})

test('an unexplained generic-file hard link is skipped rather than unlinked', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: FILE_REPORT.objectId,
    kind: 'file',
    alias: FILE_REPORT.alias,
    bytes: 512,
    processId: 'host-a',
    observedLinkCount: 3,
  })
  model.releaseLease('upload-lease-1')
  advance(GRACE)

  const report = model.collect({ dryRun: false })
  assert.equal(report.objectCount, 0)
  assert.deepEqual(report.skipped, [{
    objectId: FILE_REPORT.objectId,
    reasons: ['hard-link-count-mismatch'],
  }])
  assert.equal(model.hasObject(FILE_REPORT.objectId), true)
})

test('generic-file aliases are tracked separately while their canonical object stays shared', () => {
  const { model } = createModel()
  const report = model.publish({
    objectId: FILE_REPORT.objectId,
    kind: 'file',
    alias: FILE_REPORT.alias,
    bytes: 512,
    processId: 'host-a',
  })
  model.commitLease(report.leaseId, sessionOwner('session-a', 2, 'files[0]'))

  const summary = model.publish({
    objectId: FILE_SUMMARY.objectId,
    kind: 'file',
    alias: FILE_SUMMARY.alias,
    bytes: 512,
    processId: 'host-b',
  })
  // The second display name is the same canonical file object in the provider.
  model.commitLease(summary.leaseId, sessionOwner('session-b', 3, 'files[0]'))

  const snapshot = model.objectSnapshot(FILE_REPORT.objectId)
  assert.equal(snapshot.aliases.length, 2)
  assert.deepEqual(snapshot.aliases.map((alias) => alias.name).sort(), ['report.pdf', 'summary.pdf'])
  assert.equal(snapshot.ownerCount, 2)

  model.purgeSession('session-a', { artifactRemoved: true })
  assert.equal(model.hasObject(FILE_REPORT.objectId), true)
  assert.equal(model.objectSnapshot(FILE_REPORT.objectId).aliases.length, 2)
  assert.equal(model.hasOwner(FILE_REPORT.objectId, sessionOwner('session-b', 3, 'files[0]')), true)
})

test('a dry-run reports counts and bytes without exposing object contents or mutating state', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 2_048,
    processId: 'host-a',
  })
  model.releaseLease('upload-lease-1')
  advance(GRACE)

  const preview = model.collect()
  assert.equal(preview.state, 'ready')
  assert.equal(preview.objectCount, 1)
  assert.equal(preview.bytes, 2_048)
  assert.equal(preview.candidates[0].objectId, IMAGE.objectId)
  assert.equal('content' in preview.candidates[0], false)
  assert.equal(model.hasObject(IMAGE.objectId), true)
})

test('an active mutation barrier blocks collection during reference changes', () => {
  const { model, advance } = createModel()
  model.publish({
    objectId: IMAGE.objectId,
    kind: 'image',
    bytes: 128,
    processId: 'host-a',
  })
  model.releaseLease('upload-lease-1')
  advance(GRACE)

  const releaseMutation = model.beginMutation()
  const blocked = model.collect({ dryRun: false })
  assert.equal(blocked.state, 'blocked')
  assert.deepEqual(blocked.blockers, ['active-mutation'])
  assert.equal(model.hasObject(IMAGE.objectId), true)

  releaseMutation()
  const collected = model.collect({ dryRun: false })
  assert.equal(collected.collectedObjectCount, 1)
  assert.equal(model.hasObject(IMAGE.objectId), false)
})

test('unknown references are rejected and never turned into collectible objects', () => {
  const { model } = createModel()
  assert.throws(
    () => model.retainReference({ objectId: 'missing', kind: 'image' }, sessionOwner('session-a')),
    /unknown attachment reference/,
  )
  model.markIndexIncomplete('unresolved-reference')
  assert.equal(model.collect().state, 'incomplete')
})
