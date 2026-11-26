/**
 * In-memory executable reference model for the proposed Harness attachment
 * ownership contract.
 *
 * This is test-only code. It does not inspect, write, or delete real Harness
 * attachment files and is not a production garbage collector. Host
 * implementations should run the same contract scenarios against their real
 * provider and lifecycle coordinator.
 */

function ownerKey(owner) {
  if (!owner || typeof owner !== 'object') throw new TypeError('owner must be an object')
  if (owner.kind === 'session-event') {
    if (typeof owner.sessionId !== 'string' || owner.sessionId.length === 0) throw new TypeError('session owner requires sessionId')
    if (!Number.isSafeInteger(owner.eventSeq) || owner.eventSeq < 0) throw new TypeError('session owner requires a non-negative eventSeq')
    if (typeof owner.slot !== 'string' || owner.slot.length === 0) throw new TypeError('session owner requires slot')
    return JSON.stringify([owner.kind, owner.sessionId, owner.eventSeq, owner.slot])
  }
  if (owner.kind === 'command-execution') {
    if (typeof owner.sessionId !== 'string' || owner.sessionId.length === 0) throw new TypeError('command owner requires sessionId')
    if (typeof owner.executionId !== 'string' || owner.executionId.length === 0) throw new TypeError('command owner requires executionId')
    return JSON.stringify([owner.kind, owner.sessionId, owner.executionId])
  }
  throw new TypeError('unsupported owner kind')
}

function referenceKey(reference) {
  if (!reference || typeof reference !== 'object') throw new TypeError('reference must be an object')
  if (typeof reference.objectId !== 'string' || reference.objectId.length === 0) throw new TypeError('reference requires objectId')
  if (reference.kind !== 'image' && reference.kind !== 'file') throw new TypeError('reference kind must be image or file')
  if (reference.kind === 'file' && (typeof reference.alias !== 'string' || reference.alias.length === 0)) {
    throw new TypeError('file reference requires a display alias')
  }
  if (reference.kind === 'image' && reference.alias !== undefined) throw new TypeError('image reference cannot carry a file alias')
  return reference.kind === 'file'
    ? JSON.stringify([reference.kind, reference.objectId, reference.alias])
    : JSON.stringify([reference.kind, reference.objectId])
}

function summarize(objects) {
  let bytes = 0
  let aliases = 0
  for (const object of objects) {
    bytes += object.bytes
    aliases += object.aliases.size
  }
  return {
    objectCount: objects.length,
    bytes,
    aliasCount: aliases,
    candidates: objects.map((object) => ({
      objectId: object.objectId,
      kind: object.kind,
      bytes: object.bytes,
      aliasCount: object.aliases.size,
    })),
  }
}

/**
 * Model provider-owned leases, Session owners, fork/Trash lifecycle, read
 * leases, index completeness, the maintenance barrier, and mark/sweep rules.
 */
export class AttachmentReferenceModel {
  #objects = new Map()
  #leases = new Map()
  #readLeases = new Map()
  #instances = new Map()
  #trash = new Set()
  #deletedSessions = new Set()
  #nextLease = 1
  #nextReadLease = 1
  #activeMutations = 0
  #index = { state: 'incomplete', generation: 'unreconciled', blockers: ['not-reconciled'] }

  constructor({ now = () => Date.now(), graceMs = 60_000 } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new TypeError('graceMs must be a non-negative integer')
    this.now = now
    this.graceMs = graceMs
  }

  /** Start a Host mutation; the returned release function is idempotent. */
  beginMutation() {
    this.#activeMutations += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#activeMutations -= 1
    }
  }

  /** Publish an immutable object and durably stage an upload lease before returning. */
  publish({ objectId, kind, bytes, processId, alias, at = this.now(), observedLinkCount }) {
    if (typeof objectId !== 'string' || objectId.length === 0) throw new TypeError('objectId is required')
    if (kind !== 'image' && kind !== 'file') throw new TypeError('kind must be image or file')
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('bytes must be a non-negative integer')
    if (typeof processId !== 'string' || processId.length === 0) throw new TypeError('processId is required')
    if (!Number.isFinite(at)) throw new TypeError('at must be a finite timestamp')
    if (kind === 'file' && (typeof alias !== 'string' || alias.length === 0)) throw new TypeError('file uploads require an alias')
    if (kind === 'image' && alias !== undefined) throw new TypeError('image uploads cannot have aliases')

    let object = this.#objects.get(objectId)
    if (object && (object.kind !== kind || object.bytes !== bytes)) throw new Error('object identity conflict')
    if (!object) {
      object = {
        objectId,
        kind,
        bytes,
        createdAt: at,
        unreferencedAt: at,
        owners: new Map(),
        aliases: new Map(),
        leases: new Set(),
        readLeases: new Set(),
        observedLinkCount: kind === 'file' ? (observedLinkCount ?? 2) : 1,
      }
      this.#objects.set(objectId, object)
    }
    if (kind === 'file') {
      if (!object.aliases.has(alias)) {
        object.aliases.set(alias, new Set())
        // One canonical object link plus one provider-owned link per alias.
        if (observedLinkCount === undefined) object.observedLinkCount = 1 + object.aliases.size
      }
      if (observedLinkCount !== undefined) object.observedLinkCount = observedLinkCount
    }

    this.#instances.set(processId, 'live')
    const leaseId = `upload-lease-${this.#nextLease++}`
    const lease = { leaseId, objectId, alias, processId, createdAt: at, committedOwner: undefined }
    this.#leases.set(leaseId, lease)
    object.leases.add(leaseId)
    return {
      reference: kind === 'file' ? { objectId, kind, alias } : { objectId, kind },
      leaseId,
    }
  }

  /** Idempotently transfer a staged upload lease to one durable owner. */
  commitLease(leaseId, owner) {
    const key = ownerKey(owner)
    const lease = this.#leases.get(leaseId)
    if (!lease) {
      const committed = [...this.#objects.values()].some((object) => object.owners.has(key))
      if (committed) return { committed: true, idempotent: true }
      throw new Error('unknown or released lease')
    }
    const object = this.#objects.get(lease.objectId)
    if (object.kind === 'file' && owner.kind === 'session-event' && lease.alias === undefined) {
      throw new Error('file lease is missing its alias')
    }
    if (object.kind === 'image' && lease.alias !== undefined) throw new Error('image lease has an unexpected alias')

    object.owners.set(key, { ...owner })
    if (object.kind === 'file') object.aliases.get(lease.alias).add(key)
    object.leases.delete(leaseId)
    this.#leases.delete(leaseId)
    lease.committedOwner = key
    object.unreferencedAt = undefined
    return { committed: true, idempotent: false }
  }

  /** Add an owner for a reference that is already durable elsewhere. */
  retainReference(reference, owner) {
    const objectId = reference.objectId
    const object = this.#objects.get(objectId)
    if (!object || object.kind !== reference.kind) throw new Error('unknown attachment reference')
    const key = ownerKey(owner)
    if (object.kind === 'file') {
      if (!object.aliases.has(reference.alias)) throw new Error('unknown file alias')
      object.aliases.get(reference.alias).add(key)
    }
    if (object.owners.has(key)) return { retained: true, idempotent: true }
    object.owners.set(key, { ...owner })
    object.unreferencedAt = undefined
    return { retained: true, idempotent: false }
  }

  /** Release one or more staged leases after their producer has stopped. */
  releaseLease(leaseId, reason = 'discarded') {
    if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('release reason is required')
    const lease = this.#leases.get(leaseId)
    if (!lease) return { released: false, alreadyReleased: true }
    const object = this.#objects.get(lease.objectId)
    object.leases.delete(leaseId)
    this.#leases.delete(leaseId)
    this.#updateUnreferencedAt(object)
    return { released: true, reason }
  }

  /** Record that a Host process has stopped; its staged leases still need a grace period. */
  stopInstance(processId) {
    if (!this.#instances.has(processId)) return false
    this.#instances.set(processId, 'stopped')
    return true
  }

  /** Acquire a provider read lease so GC cannot unlink an object under an active reader. */
  acquireReadLease(reference, processId) {
    referenceKey(reference)
    const object = this.#objects.get(reference.objectId)
    if (!object || object.kind !== reference.kind) throw new Error('unknown attachment reference')
    if (object.kind === 'file' && !object.aliases.has(reference.alias)) throw new Error('unknown file alias')
    const readLeaseId = `read-lease-${this.#nextReadLease++}`
    this.#readLeases.set(readLeaseId, { readLeaseId, objectId: object.objectId, processId })
    object.readLeases.add(readLeaseId)
    this.#instances.set(processId, 'live')
    return readLeaseId
  }

  releaseReadLease(readLeaseId) {
    const lease = this.#readLeases.get(readLeaseId)
    if (!lease) return { released: false, alreadyReleased: true }
    const object = this.#objects.get(lease.objectId)
    object.readLeases.delete(readLeaseId)
    this.#readLeases.delete(readLeaseId)
    this.#updateUnreferencedAt(object)
    return { released: true }
  }

  /** Create independent child owners for an inherited Session event prefix. */
  retainFork({ childSessionId, references }) {
    if (typeof childSessionId !== 'string' || childSessionId.length === 0) throw new TypeError('childSessionId is required')
    if (!Array.isArray(references)) throw new TypeError('references must be an array')
    for (const occurrence of references) {
      this.retainReference(occurrence.reference, {
        kind: 'session-event',
        sessionId: childSessionId,
        eventSeq: occurrence.eventSeq,
        slot: occurrence.slot,
      })
    }
    return { childSessionId, retainedReferenceCount: references.length }
  }

  /** Trash and restore retain all Session owners; they are not ownership changes. */
  moveToTrash(sessionId) {
    this.#trash.add(sessionId)
    return { sessionId, trashed: true }
  }

  restoreSession(sessionId) {
    this.#trash.delete(sessionId)
    return { sessionId, restored: true }
  }

  /** Release only Session-event owners after the Session artifact was irreversibly removed. */
  purgeSession(sessionId, { artifactRemoved = false } = {}) {
    if (!artifactRemoved) throw new Error('Session artifact must be removed before owner release')
    this.#deletedSessions.add(sessionId)
    this.#trash.delete(sessionId)
    let releasedOwnerCount = 0
    for (const object of this.#objects.values()) {
      for (const [key, owner] of object.owners) {
        if (owner.kind !== 'session-event' || owner.sessionId !== sessionId) continue
        object.owners.delete(key)
        if (object.kind === 'file') {
          for (const aliasOwners of object.aliases.values()) aliasOwners.delete(key)
        }
        releasedOwnerCount += 1
      }
      this.#updateUnreferencedAt(object)
    }
    return { sessionId, releasedOwnerCount }
  }

  /** Mark the inventory incomplete whenever a source cannot be enumerated safely. */
  markIndexIncomplete(reason) {
    if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('reason is required')
    const blockers = new Set(this.#index.blockers)
    blockers.add(reason)
    this.#index = { ...this.#index, state: 'incomplete', blockers: [...blockers] }
  }

  /** Reconciliation succeeds only when every required source has been inspected. */
  setIndexComplete({ generation, blockers = [] } = {}) {
    if (typeof generation !== 'string' || generation.length === 0) throw new TypeError('generation is required')
    if (!Array.isArray(blockers)) throw new TypeError('blockers must be an array')
    this.#index = {
      state: blockers.length === 0 ? 'complete' : 'incomplete',
      generation,
      blockers: [...new Set(blockers)],
    }
    return this.indexStatus()
  }

  indexStatus() {
    let indexedReferenceCount = 0
    let retainedSessionCount = 0
    const sessions = new Set()
    for (const object of this.#objects.values()) {
      indexedReferenceCount += object.owners.size
      for (const owner of object.owners.values()) {
        if (owner.kind === 'session-event') sessions.add(owner.sessionId)
      }
    }
    retainedSessionCount = sessions.size
    return {
      ...this.#index,
      retainedSessionCount,
      indexedReferenceCount,
    }
  }

  /** Inspect or collect unreferenced objects under the exclusive maintenance barrier. */
  collect({ dryRun = true } = {}) {
    if (this.#index.state !== 'complete' || this.#index.blockers.length > 0) {
      return {
        state: 'incomplete',
        blockers: [...this.#index.blockers],
        ...summarize([]),
      }
    }
    if (this.#activeMutations > 0) {
      return {
        state: 'blocked',
        blockers: ['active-mutation'],
        ...summarize([]),
      }
    }

    const now = this.now()
    const candidates = []
    const skipped = []
    for (const object of this.#objects.values()) {
      const reasons = []
      if (object.owners.size > 0) reasons.push('durable-references')
      if (object.readLeases.size > 0) reasons.push('active-read-lease')
      const activeOrRecentLease = [...object.leases]
        .map((id) => this.#leases.get(id))
        .filter(Boolean)
        .some((lease) => this.#instances.get(lease.processId) !== 'stopped' || now - lease.createdAt < this.graceMs)
      if (activeOrRecentLease) reasons.push('staged-upload-lease')
      if (object.kind === 'file' && object.observedLinkCount !== 1 + object.aliases.size) {
        reasons.push('hard-link-count-mismatch')
      }
      const eligibleAt = object.unreferencedAt === undefined
        ? Number.POSITIVE_INFINITY
        : object.unreferencedAt + this.graceMs
      if (now < eligibleAt) reasons.push('grace-period')
      if (reasons.length > 0) {
        if (reasons.includes('hard-link-count-mismatch')) {
          skipped.push({ objectId: object.objectId, reasons })
        }
        continue
      }
      candidates.push(object)
    }

    const report = {
      state: 'ready',
      generation: this.#index.generation,
      skipped,
      ...summarize(candidates),
    }
    if (!dryRun) {
      for (const object of candidates) {
        this.#objects.delete(object.objectId)
      }
      return { ...report, collectedObjectCount: candidates.length }
    }
    return report
  }

  hasObject(objectId) {
    return this.#objects.has(objectId)
  }

  hasOwner(objectId, owner) {
    return this.#objects.get(objectId)?.owners.has(ownerKey(owner)) ?? false
  }

  objectSnapshot(objectId) {
    const object = this.#objects.get(objectId)
    if (!object) return undefined
    return {
      objectId: object.objectId,
      kind: object.kind,
      bytes: object.bytes,
      ownerCount: object.owners.size,
      aliases: [...object.aliases.entries()].map(([name, owners]) => ({ name, ownerCount: owners.size })),
      leaseCount: object.leases.size,
      readLeaseCount: object.readLeases.size,
      observedLinkCount: object.observedLinkCount,
      expectedLinkCount: object.kind === 'file' ? 1 + object.aliases.size : 1,
    }
  }

  #updateUnreferencedAt(object) {
    if (object.owners.size === 0 && object.leases.size === 0 && object.readLeases.size === 0) {
      if (object.unreferencedAt === undefined) object.unreferencedAt = this.now()
    } else {
      object.unreferencedAt = undefined
    }
  }
}
