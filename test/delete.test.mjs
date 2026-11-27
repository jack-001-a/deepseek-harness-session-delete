/**
 * Host-half tests for @ybbmm/dsh-session-delete.
 *
 * These run against the real module with a fake Cordis context, so they pin
 * down the ordering contract (a failed artifact removal must not release
 * accounting), the path guard, the trash and restore flow, the retry policy,
 * the error codes the browser localizes, and the Remote marker the API
 * Gateway reads — without a running Harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, link, mkdtemp, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const SESSION_ID = 'session-test-1'

/**
 * Build a fake Cordis context around the plugin's real apply().
 * @param options - per-test overrides for the fake host services.
 * @returns the captured service plus every call the plugin made.
 */
function harness(options = {}) {
  const calls = {
    emitted: [],
    detached: [],
    flushed: [],
    stopped: [],
    accounting: [],
    warnings: [],
    ready: undefined,
  }
  const extra = options.services ?? {}
  const sessions = {
    get: () => options.live,
    store: new Map(),
    flush: async () => {
      calls.flushed.push(SESSION_ID)
    },
    detachEntered: (entry) => {
      calls.detached.push(entry.id)
    },
  }
  const persistence = {
    // The shipped JSONL backend publishes its root; the plugin uses it as
    // the anchor of every containment check.
    root: options.root,
    stat: options.stat ?? (async () => undefined),
    list: options.list ?? (async () => []),
    locate: options.locate ?? (() => ({ kind: 'jsonl', path: join(options.dir ?? tmpdir(), 'session.4.jsonl') })),
  }
  if (typeof options.open === 'function') persistence.open = options.open
  const registry = options.registry ?? {
    list: () => [],
    unpinSession: async () => {},
    unarchiveSession: async () => {},
  }

  const ctx = {
    sessions,
    sessionPersistence: persistence,
    fileUploads: extra.fileUploads,
    waterfall: async (_name, _payload, base) => (options.activity ? options.activity : base()),
    parallel: async (name, payload) => {
      calls.stopped.push(payload.sessionId)
      await options.parallel?.(name, payload, { calls, registry })
    },
    emit: (name, payload) => {
      calls.emitted.push([name, payload])
    },
    on: (event, callback) => {
      if (event === 'ready') calls.ready = callback
    },
    get: (name) => {
      if (name === 'sessions') return sessions
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return registry
      return extra[name]
    },
    logger: {
      warn: (message) => calls.warnings.push(message),
    },
    reflect: {
      provide: (name, value) => {
        extra.__provided ??= new Map()
        extra.__provided.set(name, value)
      },
    },
  }

  apply(ctx, options.config ?? {})
  const service = extra.__provided.get('sessionDelete')
  assert.ok(service, 'apply() must provide the sessionDelete service')
  return { ctx, service, calls }
}

/**
 * Create a session store laid out the way the shipped backend lays it out.
 *
 * The store root holds one project directory, which holds one session
 * directory, which holds the log. The trash belongs beside the store root, so
 * the temporary base holds both and the default trash root is isolated per
 * test.
 * @returns the paths of one stored session.
 */
async function makeStore() {
  const base = await mkdtemp(join(tmpdir(), 'session-delete-'))
  const root = join(base, 'sessions')
  const project = join(root, '--project--')
  const dir = join(project, SESSION_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.4.jsonl'), '{"seq":0}\n')
  return {
    base,
    root,
    project,
    dir,
    log: join(dir, 'session.4.jsonl'),
    trashRoot: join(base, '.trash'),
  }
}

/**
 * Create representative provider-owned attachment paths next to the session
 * store. The Host attachment provider owns these objects; Session Delete must
 * never move or remove them during Trash, purge, or permanent session delete.
 */
async function makeAttachmentFixtures(store) {
  const root = join(store.base, 'attachments', 'v1')
  const imageDigest = 'a'.repeat(64)
  const fileDigest = 'b'.repeat(64)
  const imagePath = join(root, 'objects', imageDigest.slice(0, 2), imageDigest)
  const fileObjectPath = join(root, 'file-objects', fileDigest.slice(0, 2), fileDigest)
  const aliasPath = join(root, 'files', fileDigest.slice(0, 2), fileDigest, 'report.pdf')

  await mkdir(join(root, 'objects', imageDigest.slice(0, 2)), { recursive: true })
  await mkdir(join(root, 'file-objects', fileDigest.slice(0, 2)), { recursive: true })
  await mkdir(join(root, 'files', fileDigest.slice(0, 2), fileDigest), { recursive: true })
  await writeFile(imagePath, 'normalized image object')
  await writeFile(fileObjectPath, 'verbatim file object')
  await link(fileObjectPath, aliasPath)

  return { imagePath, fileObjectPath, aliasPath }
}

/** Assert that both durable objects and the generic-file hard-link alias survive. */
async function assertAttachmentFixturesIntact(fixtures) {
  assert.equal(await readFile(fixtures.imagePath, 'utf8'), 'normalized image object')
  assert.equal(await readFile(fixtures.fileObjectPath, 'utf8'), 'verbatim file object')
  assert.equal(await readFile(fixtures.aliasPath, 'utf8'), 'verbatim file object')
  assert.equal((await stat(fixtures.fileObjectPath)).ino, (await stat(fixtures.aliasPath)).ino)
}

/**
 * One stored session whose locator points at the session directory's log.
 * @param store - the paths of the stored session.
 * @returns the harness options for that session.
 */
function storedTarget(store) {
  return {
    root: store.root,
    dir: store.dir,
    stat: async () => ({ header: { id: SESSION_ID, cwd: store.dir } }),
    locate: () => ({ kind: 'jsonl', path: join(store.dir, 'session.4.jsonl') }),
  }
}

/**
 * Add a second stored session to one store.
 * @param store - the paths of the stored session.
 * @returns the second session's id and directory.
 */
async function addSecondSession(store) {
  const id = 'session-test-2'
  const dir = join(store.project, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.4.jsonl'), '{"seq":0}\n')
  return { id, dir }
}

/**
 * Harness options for a store holding two sessions.
 * @param store - the paths of the stored session.
 * @returns the harness options for that store.
 */
function twoSessionTarget(store) {
  return {
    root: store.root,
    stat: async (id) => ({ header: { id, cwd: store.project } }),
    locate: (header) => ({ kind: 'jsonl', path: join(store.project, header.id, 'session.4.jsonl') }),
  }
}

/** A storage domain whose projection cache is backed by `cache`. */
function cacheServices(cache, onDelete = () => {}) {
  const table = {
    get: (key) => cache.get(key),
    delete: async (key) => {
      onDelete(key)
      cache.delete(key)
      return true
    },
  }
  return { storageDomain: { get: () => ({ table: () => table }) } }
}

/**
 * A workspace registry that records the accounting calls a deletion releases
 * and a restore replays.
 *
 * `options` is read on every call, so a test can repair a failure it injected
 * and retry the restore. The entity's record mirrors the host's prepend rule.
 * @param store - the paths of the stored session.
 * @param options - `pinned`, `archived`, `failAttach`, `sessionIds` overrides.
 * @returns the fake registry, its entity and its call log.
 */
function accountingRegistry(store, options = {}) {
  const calls = []
  const workspace = {
    id: 'ws-1',
    path: store.root,
    record: { sessionIds: options.sessionIds ?? [SESSION_ID, 'session-older'] },
    detachSession: async (sessionId) => {
      calls.push(['detach', sessionId])
      workspace.record.sessionIds = workspace.record.sessionIds.filter((id) => id !== sessionId)
    },
    attachSession: async (sessionId) => {
      if (options.failAttach === true) throw new Error('cannot attach: injected failure')
      calls.push(['attach', sessionId])
      if (!workspace.record.sessionIds.includes(sessionId)) {
        workspace.record.sessionIds = [sessionId, ...workspace.record.sessionIds]
      }
    },
    insertSessionBefore: async (sessionId, beforeSessionId) => {
      calls.push(['insert', sessionId, beforeSessionId])
    },
  }
  const registry = {
    calls,
    workspace,
    list: () => [workspace],
    get: (id) => (id === workspace.id ? workspace : undefined),
    get pinnedSessionIds() {
      return options.pinned === true ? [SESSION_ID] : []
    },
    get archivedSessionIds() {
      return options.archived === true ? [SESSION_ID] : []
    },
    pinSession: async (sessionId) => {
      calls.push(['pin', sessionId])
    },
    unpinSession: async (sessionId) => {
      calls.push(['unpin', sessionId])
    },
    archiveSession: async (sessionId) => {
      calls.push(['archive', sessionId])
    },
    unarchiveSession: async (sessionId) => {
      calls.push(['unarchive', sessionId])
    },
  }
  return registry
}

/** The lines of the audit trail, newest last. */
async function auditLines(store) {
  return (await readFile(join(store.trashRoot, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/**
 * The trash entry one deletion created.
 * @param store - the paths of the stored session.
 * @param trashId - the trash entry id.
 * @returns the trash entry directory.
 */
function trashEntry(store, trashId) {
  return join(store.trashRoot, trashId)
}

test('stored session: moves the log into the trash, then releases accounting and cache', async () => {
  const store = await makeStore()
  const sequence = []
  const cache = new Map([[SESSION_ID, { rows: {} }]])
  const registry = {
    list: () => [
      {
        record: { sessionIds: [SESSION_ID] },
        detachSession: async () => {
          sequence.push('detach')
        },
      },
    ],
    unpinSession: async () => {
      sequence.push('unpin')
    },
    unarchiveSession: async () => {
      sequence.push('unarchive')
    },
  }
  const h = harness({
    ...storedTarget(store),
    registry,
    services: cacheServices(cache, () => sequence.push('cache')),
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.removed, true)
  assert.equal(outcome.wasLive, false)
  assert.equal(outcome.stored, true)
  assert.deepEqual(outcome.children, [])
  assert.equal(outcome.childrenCount, 0)
  assert.equal(outcome.mode, 'trash')
  assert.equal(outcome.trashed, true)
  assert.equal(outcome.purged, false)
  assert.equal(typeof outcome.trashId, 'string')
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  assert.deepEqual(sequence, ['detach', 'unpin', 'unarchive', 'cache'])
  assert.equal(cache.has(SESSION_ID), false)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
  assert.deepEqual(h.calls.stopped, [SESSION_ID])
})

test('Trash captures the latest workspace accounting after stop hooks settle', async () => {
  const store = await makeStore()
  const registryOptions = {
    pinned: true,
    archived: false,
    sessionIds: [SESSION_ID, 'session-before', 'session-after'],
  }
  const registry = accountingRegistry(store, registryOptions)
  const h = harness({
    ...storedTarget(store),
    registry,
    parallel: async (name, payload) => {
      assert.equal(name, 'workspace/session-stop')
      assert.equal(payload.sessionId, SESSION_ID)
      // Model a pin/archive/order update that commits while the stop hook is
      // awaited. The Trash manifest must capture the state at the move, not
      // the stale snapshot taken before these asynchronous Host callbacks.
      registryOptions.pinned = false
      registryOptions.archived = true
      registry.workspace.record.sessionIds = [
        'session-before',
        SESSION_ID,
        'session-after',
      ]
    },
  })

  const deleted = await h.service.delete(SESSION_ID)
  const entryPath = trashEntry(store, deleted.trashId)
  const manifest = JSON.parse(await readFile(join(entryPath, 'meta.json'), 'utf8'))

  assert.deepEqual(manifest.accounting, {
    member: true,
    pinned: false,
    archived: true,
    workspaceId: 'ws-1',
    beforeSessionId: 'session-after',
  })

  const restored = await h.service.restore(SESSION_ID)
  assert.equal(restored.restored, true)
  assert.ok(
    registry.calls.some((call) => call[0] === 'insert' && call[1] === SESSION_ID && call[2] === 'session-after'),
    'Restore must use the updated display-order anchor',
  )
  assert.ok(
    registry.calls.some((call) => call[0] === 'archive' && call[1] === SESSION_ID),
    'Restore must replay the latest committed archive state',
  )
  assert.equal(
    registry.calls.some((call) => call[0] === 'pin' && call[1] === SESSION_ID),
    false,
    'an archive committed while stopping must not be restored as a stale pin',
  )
})

test('permanent mode: removes the artifact outright', async () => {
  const store = await makeStore()
  const sequence = []
  const cache = new Map([[SESSION_ID, { rows: {} }]])
  const registry = {
    list: () => [
      {
        record: { sessionIds: [SESSION_ID] },
        detachSession: async () => sequence.push('detach'),
      },
    ],
    unpinSession: async () => sequence.push('unpin'),
    unarchiveSession: async () => sequence.push('unarchive'),
  }
  const h = harness({
    ...storedTarget(store),
    registry,
    services: {
      ...cacheServices(cache, () => sequence.push('cache')),
      fileUploads: {
        onSessionPermanentlyPurged: async (sessionId) => {
          assert.equal(sessionId, SESSION_ID)
          await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
          sequence.push('owners')
          return true
        },
      },
    },
    config: { mode: 'permanent' },
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.removed, true)
  assert.equal(outcome.mode, 'permanent')
  assert.equal(outcome.trashed, false)
  assert.equal(outcome.purged, true)
  assert.equal(outcome.trashId, undefined)
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  assert.deepEqual(sequence, ['owners', 'detach', 'unpin', 'unarchive', 'cache'])
  assert.equal(cache.has(SESSION_ID), false)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
})

test('permanent deletion remains successful when attachment-owner notification fails', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    config: { mode: 'permanent' },
    services: {
      fileUploads: {
        onSessionPermanentlyPurged: async () => {
          await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
          throw new Error('attachment ledger unavailable')
        },
      },
    },
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.purged, true)
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
  assert.ok(
    h.calls.warnings.some(message => message.includes('attachment-owner release failed') && message.includes('attachment ledger unavailable')),
    'a stale attachment owner must be reported as a safe leak',
  )
})

test('manual Trash purge remains successful when attachment-owner notification fails', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    services: {
      fileUploads: {
        onSessionPermanentlyPurged: async () => { throw new Error('provider busy') },
      },
    },
  })
  const deleted = await h.service.delete(SESSION_ID)

  const outcome = await h.service.purge(SESSION_ID)

  assert.deepEqual(outcome, { sessionId: SESSION_ID, purged: true })
  await assert.rejects(stat(trashEntry(store, deleted.trashId)), (error) => error.code === 'ENOENT')
  assert.ok(h.calls.warnings.some(message => message.includes('provider busy')))
})

test('retention sweep continues after attachment-owner notification fails', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    config: { retentionDays: 1 },
    services: {
      fileUploads: {
        onSessionPermanentlyPurged: async () => { throw new Error('provider unavailable') },
      },
    },
  })
  await h.service.delete(SESSION_ID)
  const expired = trashEntry(store, h.service.trashIndex.keys().next().value)
  const manifest = JSON.parse(await readFile(join(expired, 'meta.json'), 'utf8'))
  manifest.deletedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  await writeFile(join(expired, 'meta.json'), JSON.stringify(manifest))

  const purged = await h.service.listTrash()

  assert.deepEqual(purged.entries, [])
  await assert.rejects(stat(expired), (error) => error.code === 'ENOENT')
  assert.ok(h.calls.warnings.some(message => message.includes('provider unavailable')))
})

test('Trash and later purge leave provider-owned attachment objects and aliases intact', async () => {
  const store = await makeStore()
  const attachments = await makeAttachmentFixtures(store)
  const released = []
  let deletedTrashId
  const h = harness({
    ...storedTarget(store),
    services: {
      fileUploads: {
        onSessionPermanentlyPurged: async (sessionId) => {
          assert.equal(sessionId, SESSION_ID)
          await assert.rejects(stat(trashEntry(store, deletedTrashId)), (error) => error.code === 'ENOENT')
          released.push(sessionId)
          return true
        },
      },
    },
  })

  const deleted = await h.service.delete(SESSION_ID)
  deletedTrashId = deleted.trashId
  assert.equal(deleted.trashed, true)
  assert.deepEqual(released, [], 'moving a Session to Trash must preserve attachment owners')
  await assertAttachmentFixturesIntact(attachments)

  const purged = await h.service.purge(SESSION_ID)
  assert.deepEqual(purged, { sessionId: SESSION_ID, purged: true })
  assert.deepEqual(released, [SESSION_ID], 'only permanent purge releases Session owners')
  await assertAttachmentFixturesIntact(attachments)
})

test('permanent session deletion leaves provider-owned attachment objects and aliases intact', async () => {
  const store = await makeStore()
  const attachments = await makeAttachmentFixtures(store)
  const h = harness({
    ...storedTarget(store),
    config: { mode: 'permanent' },
  })

  const deleted = await h.service.delete(SESSION_ID)
  assert.equal(deleted.purged, true)
  await assertAttachmentFixturesIntact(attachments)
})

test('unknown session: fails with a stable not-found code and touches nothing', async () => {
  const h = harness({ stat: async () => undefined })
  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/not-found')
    assert.equal(error.isDSHRemoteError, true)
    return true
  })
  assert.deepEqual(h.calls.emitted, [])
  assert.deepEqual(h.calls.detached, [])
})

test('empty id: rejected as invalid-request without resolving a target', async () => {
  const h = harness()
  await assert.rejects(h.service.delete(''), (error) => error.code === 'session-delete/invalid-request')
  await assert.rejects(h.service.delete(undefined), (error) => error.code === 'session-delete/invalid-request')
})

test('busy session: refuses before any mutation and names the work', async () => {
  const h = harness({
    ...storedTarget(join(tmpdir(), 'never-touched')),
    activity: [{ kind: 'turn' }, { kind: 'jobs' }],
  })
  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/active')
    assert.deepEqual(error.details.activity, ['turn', 'jobs'])
    return true
  })
  assert.deepEqual(h.calls.stopped, [])
  assert.deepEqual(h.calls.detached, [])
  assert.deepEqual(h.calls.emitted, [])
})

test('io failure: aborts before accounting and cache, leaving the log intact', async () => {
  const store = await makeStore()
  const accounted = []
  const cache = new Map([[SESSION_ID, { rows: {} }]])
  const registry = {
    list: () => [
      {
        record: { sessionIds: [SESSION_ID] },
        detachSession: async () => accounted.push('detach'),
      },
    ],
    unpinSession: async () => accounted.push('unpin'),
    unarchiveSession: async () => accounted.push('unarchive'),
  }
  const h = harness({
    ...storedTarget(store),
    registry,
    services: cacheServices(cache, () => accounted.push('cache')),
    config: { mode: 'permanent' },
  })
  let attempts = 0
  h.service.removeArtifact = async () => {
    attempts += 1
    const error = new Error('EBUSY: resource busy or locked')
    error.code = 'EBUSY'
    throw error
  }

  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/io')
  assert.equal(attempts, 8, 'a transient failure must consume the whole retry budget')
  assert.ok((await stat(store.log)).isFile(), 'the log must survive a failed deletion')
  assert.deepEqual(accounted, [], 'accounting and cache must not be released before the log is gone')
  assert.deepEqual(h.calls.emitted, [], 'a failed deletion must not announce a removal')
})

test('a failed move leaves the artifact in place and releases nothing', async () => {
  const store = await makeStore()
  const accounted = []
  const h = harness({
    ...storedTarget(store),
    registry: {
      list: () => [],
      unpinSession: async () => accounted.push('unpin'),
      unarchiveSession: async () => accounted.push('unarchive'),
    },
  })
  h.service.moveArtifact = async () => {
    const error = new Error('EXDEV: cross-device link not permitted')
    error.code = 'EXDEV'
    throw error
  }

  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/io')
  assert.ok((await stat(store.log)).isFile(), 'the log must survive a failed move')
  assert.deepEqual(accounted, [], 'accounting must not be released before the artifact is gone')
  assert.deepEqual(h.calls.emitted, [])
  const entries = await readdir(store.trashRoot).catch(() => [])
  assert.deepEqual(entries.filter((name) => name !== 'audit.jsonl'), [], 'no trash entry may survive')
})

test('transient failure then success: retries with back-off and finishes', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store), config: { mode: 'permanent' } })
  let attempts = 0
  h.service.removeArtifact = async (path) => {
    attempts += 1
    if (attempts < 3) {
      const error = new Error('EPERM: operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
  }

  const outcome = await h.service.delete(SESSION_ID)
  assert.equal(attempts, 3)
  assert.equal(outcome.removed, true)
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
})

test('non-retryable failure: reports io immediately instead of retrying', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store), config: { mode: 'permanent' } })
  let attempts = 0
  h.service.removeArtifact = async () => {
    attempts += 1
    const error = new Error('ENOTDIR: not a directory')
    error.code = 'ENOTDIR'
    throw error
  }
  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/io')
  assert.equal(attempts, 1)
})

test('already deleted: a second call reports not-found rather than claiming a removal', async () => {
  const store = await makeStore()
  const target = storedTarget(store)
  // The real store re-scans the disk, so `stat` stops resolving once the log
  // is gone; this fake mirrors that instead of replaying one frozen snapshot.
  const h = harness({
    ...target,
    config: { mode: 'permanent' },
    stat: async () => {
      try {
        await stat(store.log)
        return { header: { id: SESSION_ID, cwd: store.dir } }
      } catch {
        return undefined
      }
    },
  })
  assert.equal((await h.service.delete(SESSION_ID)).removed, true)
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/not-found')
})

test('unmaterialized session: nothing is removed, but the row is still released', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    locate: () => ({ kind: 'jsonl', path: join(store.dir, 'session.4.jsonl') }),
    stat: async () => ({ header: { id: SESSION_ID, cwd: store.dir } }),
  })
  await rm(store.dir, { recursive: true, force: true })
  const outcome = await h.service.delete(SESSION_ID)
  assert.equal(outcome.removed, false, 'a session with no artifact must not claim a file removal')
  assert.equal(outcome.trashed, false)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
  assert.deepEqual(h.calls.stopped, [SESSION_ID])
})

test('live session: flushes, detaches, and lets the session announce its own removal', async () => {
  const store = await makeStore()
  const live = { id: SESSION_ID, header: { id: SESSION_ID, cwd: store.dir } }
  const agents = {
    store: new Map([[SESSION_ID, { id: 'agent' }]]),
    detachEntered: (entry) => detachAgent(entry),
  }
  const agentDetaches = []
  const detachAgent = (entry) => agentDetaches.push(entry.id)
  const h = harness({ ...storedTarget(store), live, services: { agents } })
  h.ctx.sessions.store.set(SESSION_ID, { id: SESSION_ID })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.wasLive, true)
  assert.deepEqual(h.calls.flushed, [SESSION_ID])
  assert.deepEqual(h.calls.detached, [SESSION_ID])
  assert.deepEqual(agentDetaches, ['agent'])
  // The disposed session emits `api-session/removed` itself; emitting again
  // would double-apply the removal on the browser.
  assert.deepEqual(h.calls.emitted, [])
  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
})

test('stored deletion holds the Host write lease until its artifact has moved to trash', async () => {
  const store = await makeStore()
  await writeFile(join(store.dir, 'session.lock'), '')
  let opened = false
  let closed = false
  const h = harness({
    ...storedTarget(store),
    open: async (id, access) => {
      assert.equal(id, SESSION_ID)
      assert.equal(access, 'write')
      opened = true
      return {
        access,
        header: { id: SESSION_ID, cwd: store.dir },
        close: async () => {
          assert.equal(opened, true)
          await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
          closed = true
        },
      }
    },
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.trashed, true)
  assert.equal(opened, true)
  assert.equal(closed, true)
  assert.ok((await stat(join(trashEntry(store, outcome.trashId), 'artifact', 'session.lock'))).isFile())
})

test('stored deletion refuses a session owned by another Harness writer', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    open: async () => {
      const error = new Error('another Harness process owns the write handle')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    },
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/locked')
    assert.equal(error.details.reason, 'write-owned')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'the stored artifact must remain untouched')
  assert.deepEqual(h.calls.emitted, [], 'a refused deletion must not announce a removal')
  // The refusal is still audited, so the trash root may exist; it must not
  // contain a promoted artifact for this session.
  assert.deepEqual(
    (await readdir(store.trashRoot)).filter((name) => name !== 'audit.jsonl'),
    [],
  )
})

test('live deletion acquires the Host lease only after stopping and detaching the live writer', async () => {
  const store = await makeStore()
  await writeFile(join(store.dir, 'session.lock'), '')
  const live = { id: SESSION_ID, header: { id: SESSION_ID, cwd: store.dir } }
  const h = harness({
    ...storedTarget(store),
    live,
    open: async (id, access) => {
      assert.equal(id, SESSION_ID)
      assert.equal(access, 'write')
      assert.deepEqual(h.calls.stopped, [SESSION_ID])
      assert.deepEqual(h.calls.flushed, [SESSION_ID])
      assert.deepEqual(h.calls.detached, [SESSION_ID])
      return {
        access,
        header: live.header,
        close: async () => {
          await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
        },
      }
    },
  })
  h.ctx.sessions.store.set(SESSION_ID, { id: SESSION_ID })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.wasLive, true)
  assert.equal(outcome.removed, true)
})

test('live deletion retries briefly while the prior Host writer is closing', async () => {
  const store = await makeStore()
  await writeFile(join(store.dir, 'session.lock'), '')
  const live = { id: SESSION_ID, header: { id: SESSION_ID, cwd: store.dir } }
  let attempts = 0
  const h = harness({
    ...storedTarget(store),
    live,
    open: async (id, access) => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('the previous live writer is still closing')
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      assert.equal(id, SESSION_ID)
      assert.equal(access, 'write')
      return {
        access,
        header: live.header,
        close: async () => {
          await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
        },
      }
    },
  })
  h.ctx.sessions.store.set(SESSION_ID, { id: SESSION_ID })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.removed, true)
  assert.equal(attempts, 2)
})

test('permanent deletion preserves the POSIX Host lease inode but removes the session log', async () => {
  const store = await makeStore()
  if (process.platform !== 'win32') await writeFile(join(store.dir, 'session.lock'), '')
  const h = harness({
    ...storedTarget(store),
    config: { mode: 'permanent' },
    open: async (id, access) => ({
      access,
      header: { id: SESSION_ID, cwd: store.dir },
      close: async () => {
        await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
        if (process.platform !== 'win32') {
          assert.ok((await stat(join(store.dir, 'session.lock'))).isFile(), 'the stable POSIX lease inode remains until close')
          assert.ok((await stat(store.dir)).isDirectory(), 'only the empty lease directory remains')
        } else {
          await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
        }
      },
    }),
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.purged, true)
  if (process.platform !== 'win32') {
    assert.deepEqual(await readdir(store.dir), ['session.lock'])
  } else {
    await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  }
})

test('forked children are reported, not deleted', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    list: async () => [
      { header: { id: SESSION_ID, cwd: store.dir } },
      { header: { id: 'child-1', cwd: store.dir, parentSession: SESSION_ID } },
      { header: { id: 'child-2', cwd: store.dir, parentSession: 'other' } },
    ],
  })
  const outcome = await h.service.delete(SESSION_ID)
  assert.deepEqual(outcome.children, ['child-1'])
  assert.equal(outcome.childrenCount, 1)
})

test('the child list is capped but the true count is reported', async () => {
  const store = await makeStore()
  const children = Array.from({ length: 150 }, (_, index) => ({
    header: { id: `child-${index}`, cwd: store.dir, parentSession: SESSION_ID },
  }))
  const h = harness({ ...storedTarget(store), list: async () => children })
  const outcome = await h.service.delete(SESSION_ID)
  assert.equal(outcome.children.length, 100, 'the reported list must stay bounded')
  assert.equal(outcome.childrenCount, 150, 'the true count must survive the cap')
})

test('projection cache is re-checked when a disposal checkpoint recreates the row', async () => {
  const store = await makeStore()
  const cache = new Map([[SESSION_ID, { rows: {} }]])
  let deletes = 0
  const table = {
    get: (key) => cache.get(key),
    delete: async (key) => {
      deletes += 1
      if (deletes === 1) {
        // A still-closing writer rewrites the checkpoint after the first delete.
        cache.set(key, { rows: { late: true } })
        return true
      }
      cache.delete(key)
      return true
    },
  }
  const h = harness({
    ...storedTarget(store),
    services: { storageDomain: { get: () => ({ table: () => table }) } },
  })

  const outcome = await h.service.delete(SESSION_ID)
  assert.equal(outcome.removed, true)
  assert.ok(deletes >= 2, 'the cache row must be re-checked after it reappears')
  assert.equal(cache.has(SESSION_ID), false)
})

test('a store without a locator fails with the unsupported-store code', async () => {
  const h = harness({
    stat: async () => ({ header: { id: SESSION_ID, cwd: tmpdir() } }),
    locate: undefined,
  })
  h.ctx.sessionPersistence.locate = undefined
  await assert.rejects(
    h.service.delete(SESSION_ID),
    (error) => error.code === 'session-delete/unsupported-store',
  )
})

test('an unknown artifact kind is refused and nothing is removed', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    locate: () => ({ kind: 'mystery', path: store.dir }),
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.details.reason, 'unknown-kind')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'the artifact must survive a refused target')
  assert.deepEqual(h.calls.emitted, [], 'a refused deletion must not announce a removal')
})

test('an artifact outside the store root is refused', async () => {
  const store = await makeStore()
  const outside = await makeStore()
  const h = harness({
    ...storedTarget(store),
    locate: () => ({ kind: 'dir', path: outside.dir }),
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'outside-store')
    return true
  })
  assert.ok((await stat(outside.log)).isFile(), 'a foreign directory must survive')
})

test('a symlinked project directory cannot redirect deletion outside the session store', async (t) => {
  const store = await makeStore()
  const outsideProject = join(store.base, 'outside-project')
  const outsideDir = join(outsideProject, SESSION_ID)
  const outsideLog = join(outsideDir, 'session.4.jsonl')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(outsideLog, '{"seq":0}\\n')
  await rm(store.project, { recursive: true, force: true })
  try {
    await symlink(outsideProject, store.project, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip('the runner does not permit creating directory symlinks')
      return
    }
    throw error
  }
  const h = harness({ ...storedTarget(store) })
  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'symlink-escape')
    return true
  })
  assert.ok((await stat(outsideLog)).isFile(), 'the external session artifact must survive')
})
test('a log file may not be widened into its directory without a store root', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    root: undefined,
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'no-store-root')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'the artifact must survive a refused target')
})

test('a file artifact is refused when the store does not expose a root', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    root: undefined,
    locate: () => ({ kind: 'file', path: store.log }),
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.details.reason, 'no-store-root')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'the artifact must survive a refused deletion')
})

test('a directory artifact is refused when the store has no root, including permanent mode', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    root: undefined,
    config: { mode: 'permanent' },
    locate: () => ({ kind: 'dir', path: store.dir }),
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'no-store-root')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'permanent mode must not remove an unverified directory')
})

test('trash listing refuses a symlinked manifest without reading its target', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const manifest = join(entry, 'meta.json')
  const outside = join(store.base, 'outside-manifest.json')
  const sentinel = JSON.stringify({
    sessionId: SESSION_ID,
    originalPath: store.dir,
    deletedAt: new Date().toISOString(),
  })
  await writeFile(outside, sentinel)
  await rm(manifest)
  await symlink(outside, manifest)

  assert.equal(await h.service.readManifest(entry), undefined)
  assert.deepEqual((await h.service.listTrash()).entries, [])
  assert.equal(await readFile(outside, 'utf8'), sentinel)
})

test('restore-pending metadata refuses to replace an unreadable or linked manifest', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = await h.service.trashEntryFor(SESSION_ID)
  const manifest = join(entry.path, 'meta.json')
  const outside = join(store.base, 'outside-manifest.json')
  const sentinel = 'preserve outside metadata'
  await writeFile(outside, sentinel)
  await rm(manifest)
  await symlink(outside, manifest)

  assert.equal(await h.service.markRestorePending(entry), false)
  assert.equal(await readFile(outside, 'utf8'), sentinel)
  assert.ok(
    h.calls.warnings.some((message) => message.includes('refusing to replace an unreadable trash manifest')),
  )
  assert.equal(deleted.trashId, entry.trashId)
})

test('restore refuses a symlinked restore marker without following it', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const outside = join(store.base, 'outside-restore-marker.json')
  const sentinel = JSON.stringify({ sessionId: SESSION_ID, target: store.dir })
  await writeFile(outside, sentinel)
  await symlink(outside, join(entry, '.restoring'))

  await assert.rejects(
    h.service.restore(SESSION_ID),
    (error) => error.code === 'session-delete/io',
  )
  assert.equal(await readFile(outside, 'utf8'), sentinel)
  assert.equal((await stat(join(entry, 'artifact'))).isDirectory(), true)
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
})

test('trash manifests above the byte limit are rejected before parsing', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const manifest = join(entry, 'meta.json')
  await writeFile(manifest, Buffer.alloc(256 * 1024 + 1, 0x61))

  assert.equal(await h.service.readManifest(entry), undefined)
  assert.equal((await stat(manifest)).size, 256 * 1024 + 1)
})

test('recovery markers refuse symbolic links without touching their targets', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entryPath = trashEntry(store, deleted.trashId)
  const outside = join(store.base, 'outside-copy-marker.json')
  const sentinel = JSON.stringify({ dev: 1, ino: 2, isDirectory: true, size: 3, mtimeMs: 4 })
  await writeFile(outside, sentinel)
  const marker = join(entryPath, '.copying')
  await symlink(outside, marker)
  const manifest = await h.service.readManifest(entryPath)

  assert.equal(await h.service.recoverTrashMove(entryPath, manifest), false)
  assert.equal(await readFile(outside, 'utf8'), sentinel)
  assert.ok(
    h.calls.warnings.some((message) => message.includes('recovery marker') && message.includes('unreadable')),
  )
})


test('process lock owner metadata is bounded before JSON parsing', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const lockPath = join(store.base, '.process-lock-owner-test')
  const ownerPath = join(lockPath, '.owner.json')
  await mkdir(lockPath, { recursive: true })
  const bytes = Buffer.alloc(4 * 1024 + 1, 0x7b)
  await writeFile(ownerPath, bytes)

  assert.equal(await h.service.readProcessLockOwner(lockPath), undefined)
  assert.equal((await stat(ownerPath)).size, bytes.length)
})


test('restore recovery compares large artifact files in bounded chunks', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-session-delete-stream-compare-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const left = join(base, 'left')
  const right = join(base, 'right')
  await Promise.all([mkdir(left), mkdir(right)])
  const leftFile = join(left, 'session.jsonl')
  const rightFile = join(right, 'session.jsonl')
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x61)
  await Promise.all([writeFile(leftFile, payload), writeFile(rightFile, payload)])

  const h = harness()
  assert.equal(await h.service.artifactsMatch(left, right), true)

  payload[payload.length - 1] = 0x62
  await writeFile(rightFile, payload)
  assert.equal(await h.service.artifactsMatch(left, right), false)
})


test('the trash entry holds the artifact and a manifest of the identifying fields', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  const canonicalDir = await realpath(store.dir)

  const outcome = await h.service.delete(SESSION_ID)

  const entry = trashEntry(store, outcome.trashId)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  assert.equal(manifest.sessionId, SESSION_ID)
  assert.equal(manifest.originalPath, canonicalDir)
  assert.equal(typeof manifest.deletedAt, 'string')
  assert.equal(manifest.mode, 'trash')
  assert.deepEqual(manifest.header, { id: SESSION_ID, cwd: store.dir })
  assert.deepEqual(manifest.children, [])
  const moved = join(entry, 'artifact')
  assert.equal((await stat(join(moved, 'session.4.jsonl'))).isFile(), true)
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT', 'the original location must be empty')
})

test('trash refresh completes a promoted cross-device copy after a simulated crash', async () => {
  const store = await makeStore()
  const entryPath = join(store.trashRoot, 'interrupted-copy')
  const artifactPath = join(entryPath, 'artifact')
  await mkdir(artifactPath, { recursive: true })
  const original = await readFile(store.log, 'utf8')
  await writeFile(join(artifactPath, 'session.4.jsonl'), original)
  const sourceStat = await stat(store.dir)
  await writeFile(join(entryPath, 'meta.json'), JSON.stringify({
    sessionId: SESSION_ID,
    originalPath: store.dir,
    deletedAt: new Date().toISOString(),
    header: { id: SESSION_ID, cwd: store.dir },
    children: [],
    childrenCount: 0,
    mode: 'trash',
  }))
  await writeFile(join(entryPath, '.copying'), JSON.stringify({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    isDirectory: sourceStat.isDirectory(),
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }))

  const h = harness({ ...storedTarget(store) })
  const entries = await h.service.refreshTrash()

  assert.equal(entries.length, 1)
  assert.equal(entries[0].trashId, 'interrupted-copy')
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  assert.equal(await readFile(join(artifactPath, 'session.4.jsonl'), 'utf8'), original)
  await assert.rejects(stat(join(entryPath, '.copying')), (error) => error.code === 'ENOENT')
})


test('trash recovery preserves a same-content replacement source with a different inode', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const entryPath = join(store.trashRoot, 'interrupted-replaced-source')
  const artifactPath = join(entryPath, 'artifact')
  await mkdir(artifactPath, { recursive: true })
  const original = await readFile(store.log, 'utf8')
  await writeFile(join(artifactPath, 'session.4.jsonl'), original)
  const sourceStat = await stat(store.dir)
  const manifest = {
    sessionId: SESSION_ID,
    originalPath: store.dir,
    deletedAt: new Date().toISOString(),
    header: { id: SESSION_ID, cwd: store.dir },
    children: [],
    childrenCount: 0,
    mode: 'trash',
  }
  await writeFile(join(entryPath, 'meta.json'), JSON.stringify(manifest))
  await writeFile(join(entryPath, '.copying'), JSON.stringify({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    isDirectory: sourceStat.isDirectory(),
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }))

  const displacedOriginal = join(store.base, 'displaced-original-session')
  await rename(store.dir, displacedOriginal)
  await mkdir(store.dir, { recursive: true })
  await writeFile(join(store.dir, 'session.4.jsonl'), original)
  assert.notEqual(
    (await stat(store.dir)).ino,
    sourceStat.ino,
    'the replacement directory must have a different filesystem identity',
  )

  const h = harness({ ...storedTarget(store) })
  const recovered = await h.service.recoverTrashMove(entryPath, manifest)

  assert.equal(recovered, false, 'recovery must not delete a replacement based only on equal file contents')
  assert.equal(await readFile(store.log, 'utf8'), original, 'the replacement session must remain intact')
  assert.equal(await readFile(join(displacedOriginal, 'session.4.jsonl'), 'utf8'), original)
  assert.equal(await readFile(join(artifactPath, 'session.4.jsonl'), 'utf8'), original)
  assert.ok((await stat(join(entryPath, '.copying'))).isFile(), 'the ambiguous transaction marker must be preserved')
})

test('trash recovery keeps its source anchored when a project alias is replaced after comparison', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const alias = join(store.root, 'project-alias')
  try {
    await symlink(store.project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('the runner does not permit creating directory symlinks')
    return
  }

  const outsideProject = join(store.base, 'outside-project')
  const outsideSession = join(outsideProject, SESSION_ID)
  await mkdir(outsideSession, { recursive: true })
  await writeFile(join(outsideSession, 'session.4.jsonl'), 'outside sentinel\\n')

  const entryPath = join(store.trashRoot, 'interrupted-alias-source')
  const artifactPath = join(entryPath, 'artifact')
  await mkdir(artifactPath, { recursive: true })
  const original = await readFile(store.log, 'utf8')
  await writeFile(join(artifactPath, 'session.4.jsonl'), original)
  const sourceStat = await stat(join(alias, SESSION_ID))
  const manifest = {
    sessionId: SESSION_ID,
    originalPath: join(alias, SESSION_ID),
    deletedAt: new Date().toISOString(),
    header: { id: SESSION_ID, cwd: store.dir },
    children: [],
    childrenCount: 0,
    mode: 'trash',
  }
  await writeFile(join(entryPath, 'meta.json'), JSON.stringify(manifest))
  await writeFile(join(entryPath, '.copying'), JSON.stringify({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    isDirectory: sourceStat.isDirectory(),
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }))

  const h = harness({ ...storedTarget(store) })
  const originalArtifactsMatch = h.service.artifactsMatch.bind(h.service)
  let aliasReplaced = false
  h.service.artifactsMatch = async (left, right) => {
    const matches = await originalArtifactsMatch(left, right)
    if (!aliasReplaced) {
      aliasReplaced = true
      await rm(alias)
      await symlink(outsideProject, alias, process.platform === 'win32' ? 'junction' : 'dir')
    }
    return matches
  }

  const recovered = await h.service.recoverTrashMove(entryPath, manifest)

  assert.equal(recovered, true)
  assert.equal(aliasReplaced, true, 'the fixture must replace the alias after artifact comparison')
  assert.equal(
    await readFile(join(outsideSession, 'session.4.jsonl'), 'utf8'),
    'outside sentinel\\n',
    'recovery must not follow the replaced alias when removing its source',
  )
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  assert.equal(await readFile(join(artifactPath, 'session.4.jsonl'), 'utf8'), original)
})

test('trash recovery preserves a replacement tombstone whose inode differs from the recorded source', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const entryPath = join(store.trashRoot, 'interrupted-replaced-tombstone')
  const artifactPath = join(entryPath, 'artifact')
  await mkdir(artifactPath, { recursive: true })
  const original = await readFile(store.log, 'utf8')
  await writeFile(join(artifactPath, 'session.4.jsonl'), original)
  const sourceStat = await stat(store.dir)
  const tombstone = join(store.project, `.session-delete-${entryPath.split(/[\\\\/]/).pop()}.moving`)
  const manifest = {
    sessionId: SESSION_ID,
    originalPath: store.dir,
    deletedAt: new Date().toISOString(),
    header: { id: SESSION_ID, cwd: store.dir },
    children: [],
    childrenCount: 0,
    mode: 'trash',
  }
  await writeFile(join(entryPath, 'meta.json'), JSON.stringify(manifest))
  await writeFile(join(entryPath, '.copying'), JSON.stringify({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    isDirectory: sourceStat.isDirectory(),
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }))

  await rename(store.dir, join(store.base, 'original-tombstone-source'))
  await mkdir(tombstone, { recursive: true })
  await writeFile(join(tombstone, 'session.4.jsonl'), original)

  const h = harness({ ...storedTarget(store) })
  const recovered = await h.service.recoverTrashMove(entryPath, manifest)

  assert.equal(recovered, false)
  assert.equal(await readFile(join(tombstone, 'session.4.jsonl'), 'utf8'), original)
  assert.equal(await readFile(join(artifactPath, 'session.4.jsonl'), 'utf8'), original)
  assert.ok((await stat(join(entryPath, '.copying'))).isFile())
})

test('trash refresh discards an unpromoted partial copy and preserves its source', async () => {
  const store = await makeStore()
  const entryPath = join(store.trashRoot, 'interrupted-partial')
  await mkdir(join(entryPath, 'artifact.partial'), { recursive: true })
  const sourceStat = await stat(store.dir)
  await writeFile(join(entryPath, 'meta.json'), JSON.stringify({
    sessionId: SESSION_ID,
    originalPath: store.dir,
    deletedAt: new Date().toISOString(),
    header: { id: SESSION_ID, cwd: store.dir },
    children: [],
    childrenCount: 0,
    mode: 'trash',
  }))
  await writeFile(join(entryPath, '.copying'), JSON.stringify({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }))

  const h = harness({ ...storedTarget(store) })
  const entries = await h.service.refreshTrash()

  assert.deepEqual(entries, [])
  assert.ok((await stat(store.log)).isFile(), 'the original must remain the authoritative copy')
  await assert.rejects(stat(entryPath), (error) => error.code === 'ENOENT')
})

test('restore puts the artifact back and empties the trash', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const deleted = await h.service.delete(SESSION_ID)
  const restored = await h.service.restore(SESSION_ID)

  assert.deepEqual(restored, { sessionId: SESSION_ID, restored: true, mode: 'trash' })
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
  await assert.rejects(stat(trashEntry(store, deleted.trashId)), (error) => error.code === 'ENOENT')
  const listed = await h.service.listTrash()
  assert.deepEqual(listed.entries, [])
})

test('restoring a session that is not in the trash fails with not-found', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/not-found')
    return true
  })
})

test('restore reattaches the recorded workspace, its slot and the pin, then announces the row', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store, { pinned: true })
  const sessionController = {
    listState: {
      summarizeCold: ({ header }) => ({ sessionId: header.id, updatedAt: 7, running: false }),
    },
  }
  const h = harness({ ...storedTarget(store), registry, services: { sessionController } })

  const deleted = await h.service.delete(SESSION_ID)
  const manifest = JSON.parse(await readFile(join(trashEntry(store, deleted.trashId), 'meta.json'), 'utf8'))
  assert.deepEqual(manifest.accounting, {
    member: true,
    pinned: true,
    archived: false,
    workspaceId: 'ws-1',
    beforeSessionId: 'session-older',
  })
  assert.deepEqual(registry.calls, [
    ['detach', SESSION_ID],
    ['unpin', SESSION_ID],
    ['unarchive', SESSION_ID],
  ])
  registry.calls.length = 0

  const outcome = await h.service.restore(SESSION_ID)

  assert.deepEqual(registry.calls, [
    ['attach', SESSION_ID],
    ['insert', SESSION_ID, 'session-older'],
    ['pin', SESSION_ID],
  ])
  assert.equal(outcome.reattached, true)
  assert.equal(outcome.announced, true)
  assert.deepEqual(h.calls.emitted.at(-1), [
    'api-session/added',
    { sessionId: SESSION_ID, updatedAt: 7, running: false },
  ])
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
  await assert.rejects(stat(trashEntry(store, deleted.trashId)), (error) => error.code === 'ENOENT')
})

test('restore replays a recorded archive mark instead of a pin', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store, { archived: true })
  const h = harness({ ...storedTarget(store), registry })

  const deleted = await h.service.delete(SESSION_ID)
  const manifest = JSON.parse(await readFile(join(trashEntry(store, deleted.trashId), 'meta.json'), 'utf8'))
  assert.equal(manifest.accounting.archived, true)
  assert.equal(manifest.accounting.pinned, false)
  registry.calls.length = 0

  const outcome = await h.service.restore(SESSION_ID)

  assert.equal(outcome.reattached, true)
  assert.deepEqual(registry.calls, [
    ['attach', SESSION_ID],
    ['insert', SESSION_ID, 'session-older'],
    ['archive', SESSION_ID],
  ])
  assert.equal(registry.calls.some(([name]) => name === 'pin'), false, 'an archived session is not pinned')
})

test('a failed reattachment is reported, keeps the files and stays retryable', async () => {
  const store = await makeStore()
  const options = { pinned: true, failAttach: true }
  const registry = accountingRegistry(store, options)
  const h = harness({ ...storedTarget(store), registry })

  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  registry.calls.length = 0

  const partial = await h.service.restore(SESSION_ID)

  assert.equal(partial.restored, true, 'the files are back and the outcome says so')
  assert.equal(partial.reattached, false)
  assert.equal(partial.needsRestart, true)
  assert.deepEqual(partial.reattachFailures, ['workspace'])
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
  assert.deepEqual((await h.service.listTrash()).entries.length, 1, 'the entry survives as the retry record')
  assert.equal((await h.service.listTrash()).entries[0].restoreState, 'accounting-pending')
  assert.equal((await stat(entry)).isDirectory(), true)
  await assert.rejects(stat(join(entry, 'artifact')), (error) => error.code === 'ENOENT')
  const trail = await auditLines(store)
  assert.equal(trail.at(-1).action, 'restore')
  assert.equal(trail.at(-1).ok, true)
  assert.equal(trail.at(-1).partial, true)
  assert.equal(trail.at(-1).code, 'session-delete/restore-incomplete')

  // Repair the host-side failure and retry: only the accounting is replayed.
  options.failAttach = false
  registry.calls.length = 0
  let moves = 0
  const realMove = h.service.moveArtifact.bind(h.service)
  h.service.moveArtifact = async (source, destination) => {
    moves += 1
    return realMove(source, destination)
  }
  const done = await h.service.restore(SESSION_ID)

  assert.equal(done.reattached, true)
  assert.equal(moves, 0, 'an already-moved artifact must not be copied twice')
  assert.deepEqual((await h.service.listTrash()).entries, [])
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
})

test('a restore interrupted after the move is completed instead of conflicting', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store, { pinned: true })
  const h = harness({ ...storedTarget(store), registry })

  const deleted = await h.service.delete(SESSION_ID)
  const artifact = join(trashEntry(store, deleted.trashId), 'artifact')
  // Simulate the durable marker written before a real restore move, then
  // a crash after the artifact has reached its destination.
  await writeFile(join(trashEntry(store, deleted.trashId), '.restoring'), JSON.stringify({
    sessionId: SESSION_ID,
    target: store.dir,
  }))
  await h.service.moveArtifact(artifact, store.dir)
  registry.calls.length = 0

  const outcome = await h.service.restore(SESSION_ID)

  assert.equal(outcome.restored, true)
  assert.equal(outcome.reattached, true)
  assert.deepEqual(registry.calls, [
    ['attach', SESSION_ID],
    ['insert', SESSION_ID, 'session-older'],
    ['pin', SESSION_ID],
  ])
  assert.deepEqual((await h.service.listTrash()).entries, [])
})

test('a legacy manifest without accounting is restored by inferring the workspace from cwd', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store)
  let resolved
  registry.resolveByPath = async (cwd) => {
    resolved = cwd
    return registry.list()[0]
  }
  const h = harness({ ...storedTarget(store), registry })

  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  delete manifest.accounting
  await writeFile(join(entry, 'meta.json'), JSON.stringify(manifest))
  await h.service.refreshTrash()
  registry.calls.length = 0

  const outcome = await h.service.restore(SESSION_ID)

  assert.equal(resolved, store.dir, 'the recorded header cwd names the owning workspace')
  assert.equal(outcome.reattached, true)
  assert.equal(outcome.inferred, true)
  assert.deepEqual(registry.calls[0], ['attach', SESSION_ID])
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
})

test('a legacy manifest still restores when the host exposes no workspace resolver', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  delete manifest.accounting
  await writeFile(join(entry, 'meta.json'), JSON.stringify(manifest))
  await h.service.refreshTrash()

  assert.deepEqual(await h.service.restore(SESSION_ID), {
    sessionId: SESSION_ID,
    restored: true,
    mode: 'trash',
  })
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
})

test('a summary the host cannot build does not fail the restore', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store, { pinned: true })
  const sessionController = {
    listState: {
      summarizeCold: () => {
        throw new Error('projection store unavailable')
      },
    },
  }
  const h = harness({ ...storedTarget(store), registry, services: { sessionController } })

  await h.service.delete(SESSION_ID)
  const outcome = await h.service.restore(SESSION_ID)

  assert.equal(outcome.restored, true)
  assert.equal(outcome.reattached, true)
  assert.equal(outcome.announced, undefined, 'a summary failure is only logged')
  assert.ok(
    h.calls.warnings.some((warning) => warning.includes('summarizing the restored session')),
    'the failure has to be visible in the host log',
  )
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
})

test('restoring onto an occupied path fails with conflict', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  await h.service.delete(SESSION_ID)
  await mkdir(store.dir, { recursive: true })
  await writeFile(join(store.dir, 'session.4.jsonl'), '{"seq":9}\n')
  const canonicalDir = await realpath(store.dir)

  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/conflict')
    assert.equal(error.details.path, canonicalDir)
    return true
  })
  assert.equal((await stat(join(store.dir, 'session.4.jsonl'))).isFile(), true)
})

test('a manifest that names a path outside the store is refused', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, h.service.trashIndex.keys().next().value)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  manifest.originalPath = join(store.base, 'outside')
  await writeFile(join(entry, 'meta.json'), JSON.stringify(manifest))
  await h.service.refreshTrash()

  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    return true
  })
})

test('restore refuses to use a trash manifest when the store root is unavailable', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    config: { trashRoot: store.trashRoot },
  })
  const deleted = await h.service.delete(SESSION_ID)
  h.ctx.sessionPersistence.root = undefined

  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'no-store-root')
    return true
  })
  assert.ok(
    (await stat(join(trashEntry(store, deleted.trashId), 'artifact', 'session.4.jsonl'))).isFile(),
    'the trashed artifact must remain intact when restore cannot verify its destination',
  )
  assert.equal(await h.service.pathExists(store.dir), false)
})

test('restore refuses an original path redirected outside the store by a symlink', async (t) => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  const outsideProject = join(store.base, 'outside-project')
  await mkdir(outsideProject, { recursive: true })
  await rm(store.project, { recursive: true, force: true })
  try {
    await symlink(outsideProject, store.project, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip('the runner does not permit creating directory symlinks')
      return
    }
    throw error
  }
  await h.service.refreshTrash()
  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/unsafe-path')
    assert.equal(error.details.reason, 'symlink-escape')
    return true
  })
  assert.ok((await stat(join(entry, 'artifact', 'session.4.jsonl'))).isFile(), 'the trashed artifact must remain intact')
  assert.equal(await h.service.pathExists(join(outsideProject, SESSION_ID)), false)
})
test('purge removes the trash entry for good', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const deleted = await h.service.delete(SESSION_ID)
  const purged = await h.service.purge(SESSION_ID)

  assert.deepEqual(purged, { sessionId: SESSION_ID, purged: true })
  await assert.rejects(stat(trashEntry(store, deleted.trashId)), (error) => error.code === 'ENOENT')
  await assert.rejects(h.service.purge(SESSION_ID), (error) => error.code === 'session-delete/not-found')
})

test('deleting a trashed session again reports the same trash entry', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const first = await h.service.delete(SESSION_ID)
  const second = await h.service.delete(SESSION_ID)

  assert.equal(second.trashId, first.trashId)
  assert.equal(second.trashed, true)
  assert.equal(second.removed, true)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]], 'the removal is announced once')
})

test('trash listing examines at most its bounded number of raw directory entries', { timeout: 15000 }, async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await mkdir(store.trashRoot, { recursive: true })
  for (let index = 0; index < 501; index += 1) {
    const entryName = 'bounded-entry-' + String(index).padStart(4, '0')
    const entryPath = join(store.trashRoot, entryName)
    await mkdir(entryPath)
    await writeFile(
      join(entryPath, 'meta.json'),
      JSON.stringify({
        sessionId: 'bounded-session-' + index,
        originalPath: store.dir,
        deletedAt: new Date().toISOString(),
      }),
    )
  }

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  const entries = await h.service.readTrashEntries({ recoverMoves: false })
  assert.equal(entries.length, 500, 'the 501st raw entry must not be examined')
})


test('the trash listing reports every entry, newest first', async () => {
  const store = await makeStore()
  const second = await addSecondSession(store)
  const h = harness({ ...twoSessionTarget(store) })
  const canonicalSecondDir = await realpath(join(store.project, second.id))

  const first = await h.service.delete(SESSION_ID)
  const other = await h.service.delete(second.id)

  const listed = await h.service.listTrash()
  assert.equal(listed.entries.length, 2)
  assert.equal(listed.entries[0].trashId, other.trashId)
  assert.equal(listed.entries[1].trashId, first.trashId)
  assert.equal(listed.entries[0].sessionId, second.id)
  assert.equal(listed.entries[0].originalPath, canonicalSecondDir)
  assert.equal(typeof listed.entries[0].deletedAt, 'string')
})

test('entries older than the retention window are purged lazily', async () => {
  const store = await makeStore()
  const released = []
  const h = harness({
    ...storedTarget(store),
    config: { retentionDays: 1 },
    services: {
      fileUploads: {
        onSessionPermanentlyPurged: async (sessionId) => {
          released.push(sessionId)
          return true
        },
      },
    },
  })

  await h.service.delete(SESSION_ID)
  const expired = trashEntry(store, h.service.trashIndex.keys().next().value)
  const manifest = JSON.parse(await readFile(join(expired, 'meta.json'), 'utf8'))
  manifest.deletedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  await writeFile(join(expired, 'meta.json'), JSON.stringify(manifest))

  const listed = await h.service.listTrash()

  assert.deepEqual(listed.entries, [], 'an expired entry must not survive the sweep')
  await assert.rejects(stat(expired), (error) => error.code === 'ENOENT')
  assert.deepEqual(released, [SESSION_ID], 'retention sweep releases owners only after the trash entry is removed')
})

test('every mutation is recorded in the audit trail without any content', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  await h.service.delete(SESSION_ID)
  await h.service.restore(SESSION_ID)
  await h.service.delete(SESSION_ID)
  await h.service.purge(SESSION_ID)

  const lines = (await readFile(join(store.trashRoot, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    lines.map((line) => line.action),
    ['delete', 'restore', 'delete', 'purge'],
  )
  assert.ok(lines.every((line) => line.sessionId === SESSION_ID))
  assert.ok(lines.every((line) => typeof line.at === 'string'))
  assert.ok(lines.every((line) => line.ok === true))
  assert.ok(lines.every((line) => line.mode === 'trash'))
  assert.equal(lines[0].children, 0)
  const text = JSON.stringify(lines)
  assert.equal(text.includes('session.4.jsonl'), false, 'the trail must not carry artifact names')
  assert.equal(text.includes('seq'), false, 'the trail must not carry content')
})


test('the audit trail refuses a symbolic-link file without modifying its target', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const target = join(store.base, 'outside-audit-target.txt')
  const file = join(store.trashRoot, 'audit.jsonl')
  await writeFile(target, 'preserve this file\n')
  await mkdir(store.trashRoot, { recursive: true })
  try {
    await symlink(target, file)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      t.skip('the current platform does not permit symbolic links')
      return
    }
    throw error
  }

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  assert.equal(await readFile(target, 'utf8'), 'preserve this file\n')
  assert.equal(await readlink(file), target)
  assert.ok(h.calls.warnings.some((message) => message.includes('writing the audit trail failed')))
})

test('deletion refuses a symbolic-link Trash root before moving the artifact', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const outside = join(store.base, 'outside-trash-root')
  await mkdir(outside)
  try {
    await symlink(outside, store.trashRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      t.skip('the current platform does not permit directory symbolic links')
      return
    }
    throw error
  }

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  const original = await readFile(store.log, 'utf8')
  await assert.rejects(
    h.service.delete(SESSION_ID),
    (error) => error.code === 'session-delete/trash-unavailable',
  )

  assert.deepEqual(await readdir(outside), [], 'the linked Trash target must remain untouched')
  assert.equal(await readFile(store.log, 'utf8'), original, 'the source artifact must remain in the store')
  assert.equal(await readlink(store.trashRoot), outside)
})

test('the audit trail does not create the target of a symbolic-link Trash root', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const outside = join(store.base, 'missing-outside-trash', 'nested')
  try {
    await symlink(outside, store.trashRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      t.skip('the current platform does not permit directory symbolic links')
      return
    }
    throw error
  }

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  await assert.rejects(stat(outside), (error) => error?.code === 'ENOENT')
  assert.equal(await readlink(store.trashRoot), outside)
  assert.ok(h.calls.warnings.some((message) => message.includes('writing the audit trail failed')))
})

test('the audit trail refuses a symbolic-link Trash root without writing into its target', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const outside = join(store.base, 'outside-trash-root')
  await mkdir(outside)
  try {
    await symlink(outside, store.trashRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      t.skip('the current platform does not permit directory symbolic links')
      return
    }
    throw error
  }

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  assert.deepEqual(await readdir(outside), [])
  assert.equal(await readlink(store.trashRoot), outside)
  assert.ok(h.calls.warnings.some((message) => message.includes('writing the audit trail failed')))
})

test('the audit trail refuses a hard-linked file without modifying either name', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const target = join(store.base, 'outside-audit-target.txt')
  const file = join(store.trashRoot, 'audit.jsonl')
  await writeFile(target, 'preserve this file\n')
  await mkdir(store.trashRoot, { recursive: true })
  await link(target, file)

  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })
  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  assert.equal(await readFile(target, 'utf8'), 'preserve this file\n')
  assert.equal(await readFile(file, 'utf8'), 'preserve this file\n')
  assert.ok(h.calls.warnings.some((message) => message.includes('writing the audit trail failed')))
})

test('a refused deletion is recorded with its code', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store), activity: [{ kind: 'turn' }] })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/active')

  const lines = (await readFile(join(store.trashRoot, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].ok, false)
  assert.equal(lines[0].code, 'session-delete/active')
  assert.equal(lines[0].action, 'delete')
})

test('the audit trail refuses an oversized existing file without reading or growing it', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const file = join(store.trashRoot, 'audit.jsonl')
  await mkdir(store.trashRoot, { recursive: true })
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 0x61))
  const before = await stat(file)
  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })

  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  const after = await stat(file)
  assert.equal(after.size, before.size, 'an oversized trail must never be appended to')
  assert.equal(await h.service.readAuditTrail(file), undefined, 'oversized input must be refused')
  assert.ok(
    h.calls.warnings.some((message) => message.includes('1 MiB storage limit')),
    'the skipped audit write must be observable',
  )
})

test('the audit trail refuses one oversized record before creating its file', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store), config: { trashRoot: store.trashRoot } })

  await h.service.audit('delete', 'x'.repeat(9000), true, { mode: 'trash' })

  await assert.rejects(stat(store.trashRoot), (error) => error.code === 'ENOENT')
  assert.ok(
    h.calls.warnings.some((message) => message.includes('8 KiB')),
    'an oversized record must be rejected with a diagnostic',
  )
})


test('the audit trail stays bounded', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  // A trail that already holds more records than the cap must be trimmed
  // instead of growing without limit.
  const file = join(store.trashRoot, 'audit.jsonl')
  await mkdir(store.trashRoot, { recursive: true })
  const records = Array.from({ length: 1100 }, (_, index) =>
    JSON.stringify({ at: new Date(0).toISOString(), action: 'delete', sessionId: `old-${index}`, ok: true }),
  )
  await writeFile(file, `${records.join('\n')}\n`)

  await h.service.delete(SESSION_ID)

  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0)
  assert.ok(lines.length <= 1000, `the trail must stay within its cap, found ${lines.length}`)
  assert.ok(lines.length > 0)
})

test('audit append and retention trimming are serialized across Harness processes', async () => {
  const store = await makeStore()
  await mkdir(store.trashRoot, { recursive: true })
  const file = join(store.trashRoot, 'audit.jsonl')
  const initial = Array.from({ length: 990 }, (_, index) =>
    JSON.stringify({ at: new Date(0).toISOString(), action: 'old', sessionId: 'old-' + index, ok: true }),
  )
  await writeFile(file, initial.join('\n') + '\n')

  const moduleUrl = new URL('../index.js', import.meta.url).href
  const worker = `
    const [moduleUrl, root, prefix, count] = process.argv.slice(1)
    const { apply } = await import(moduleUrl)
    const provided = new Map()
    const sessions = { get: () => undefined, store: new Map() }
    const persistence = { root, stat: async () => undefined, list: async () => [] }
    const ctx = {
      sessions,
      sessionPersistence: persistence,
      get: (name) => name === 'sessions' ? sessions : name === 'sessionPersistence' ? persistence : undefined,
      reflect: { provide: (name, value) => provided.set(name, value) },
      on: () => {},
      waterfall: async (_name, _payload, base) => base(),
      parallel: async () => {},
      emit: () => {},
      logger: { warn: (message) => console.error('sessionDelete audit worker: ' + message) },
    }
    apply(ctx)
    const service = provided.get('sessionDelete')
    await Promise.all(Array.from({ length: Number(count) }, (_, index) =>
      service.audit('worker-audit', prefix + '-' + index, true, { mode: 'trash' }),
    ))
  `
  const launch = (prefix) => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', worker, moduleUrl, store.root, prefix, '15'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ prefix, stderr })
      else reject(new Error('audit worker ' + prefix + ' exited with ' + code + (stderr ? '\\n' + stderr : '')))
    })
  })

  const workers = await Promise.all([launch('worker-a'), launch('worker-b')])
  const diagnostics = workers.map((worker) => worker.stderr).filter(Boolean).join('\\n')

  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const workerIds = new Set(lines
    .filter((line) => line.action === 'worker-audit')
    .map((line) => line.sessionId))
  assert.ok(lines.length <= 1000, 'cross-process trimming must keep the audit trail bounded')
  assert.equal(diagnostics, '', 'audit workers reported write/lock failures:\\n' + diagnostics)
  const expectedWorkerIds = ['worker-a', 'worker-b'].flatMap((prefix) =>
    Array.from({ length: 15 }, (_, index) => prefix + '-' + index),
  )
  const missingWorkerIds = expectedWorkerIds.filter((id) => !workerIds.has(id))
  assert.equal(
    workerIds.size,
    30,
    'no concurrent audit record may be lost during trimming; missing: ' + missingWorkerIds.join(', '),
  )
  for (const prefix of ['worker-a-', 'worker-b-']) {
    for (let index = 0; index < 15; index += 1) {
      assert.ok(workerIds.has(prefix + index), 'missing audit record: ' + prefix + index)
    }
  }
})

test('the audit trail is read once when a fresh trail needs trimming', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  const records = Array.from({ length: 1100 }, (_, index) =>
    JSON.stringify({ at: new Date(0).toISOString(), action: 'delete', sessionId: `old-${index}`, ok: true }),
  )
  let reads = 0
  // The counting read and the trim read are the same read; the second one
  // would double the work of the mutation that crosses the cap.
  h.service.readAuditTrail = async () => {
    reads += 1
    return `${records.join('\n')}\n`
  }

  await h.service.audit('delete', SESSION_ID, true, { mode: 'trash' })

  assert.equal(reads, 1, 'the trail must not be read twice for one trim')
  const lines = (await readFile(join(store.trashRoot, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
  assert.ok(lines.length <= 1000, 'the trim still has to bound the trail')
})

test('describe reports the capabilities of the store', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  assert.deepEqual(await h.service.describe(), {
    supported: true,
    mode: 'trash',
    retentionDays: 7,
    canRestore: true,
    canListTrash: true,
    trashCount: 0,
    canLocate: true,
  })

  const deleted = await h.service.delete(SESSION_ID)
  const described = await h.service.describe()
  assert.equal(described.trashCount, 1)
  assert.equal(described.mode, 'trash')
  assert.equal(described.canRestore, true)
  assert.equal(typeof deleted.trashId, 'string')
})

test('describe reports a permanent store without a trash', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store), config: { mode: 'permanent' } })

  assert.deepEqual(await h.service.describe(), {
    supported: true,
    mode: 'permanent',
    retentionDays: 0,
    canRestore: false,
    canListTrash: false,
    trashCount: 0,
    canLocate: true,
  })
})

test('the trash lives beside the session store, never inside it', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(h.service.trashRoot(), store.trashRoot)
  assert.equal(store.trashRoot.startsWith(`${store.root}`), false, 'the trash must stay out of the store')
  assert.ok((await stat(trashEntry(store, outcome.trashId))).isDirectory())
})

test('an explicit trash root is honoured', async () => {
  const store = await makeStore()
  const custom = join(store.base, 'custom-trash')
  const h = harness({ ...storedTarget(store), config: { trashRoot: custom } })

  const outcome = await h.service.delete(SESSION_ID)

  assert.ok((await stat(join(custom, outcome.trashId))).isDirectory())
  await assert.rejects(stat(store.trashRoot), (error) => error.code === 'ENOENT')
})

test('Remote marker exposes a resources reader that receives the id itself', async () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(h.service),
    REMOTE_METHODS,
  )
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  assert.equal(descriptor.value.version, 1)

  const binding = h.service.typertRemote
  assert.ok(binding, 'the Host service must expose a Gateway binding')
  assert.strictEqual(binding.service, h.service, 'the binding must point to the exact provided service instance')
  assert.equal(binding.serviceKey, 'sessionDelete')
  assert.equal(binding.namespace, 'sessionDelete')
  const marker = descriptor.value.methods.find((method) => method.method === 'delete')
  assert.ok(marker, 'delete must be marked Remote')
  assert.equal(marker.resources.session(SESSION_ID), SESSION_ID)
  assert.equal(marker.resources.session(undefined), undefined)
  assert.deepEqual(descriptor.value.methods.map((method) => method.method), [
    'delete',
    'describe',
    'restore',
    'purge',
    'listTrash',
  ])
  for (const method of descriptor.value.methods) {
    assert.deepEqual(method.invocation, { kind: 'direct' })
  }
  for (const name of ['restore', 'purge']) {
    const remote = descriptor.value.methods.find((method) => method.method === name)
    assert.equal(remote.resources.session(SESSION_ID), SESSION_ID)
  }
})

test('the Remote methods carry signatures the Gateway can parse', async () => {
  const h = harness()
  const proto = Object.getPrototypeOf(h.service)
  // The Gateway reads the parameter names out of the method's source text and
  // rejects a default, a destructuring or a rest parameter, so the signature
  // is part of the wire contract.
  for (const name of ['delete', 'describe', 'restore', 'purge', 'listTrash']) {
    const implementation = Object.getOwnPropertyDescriptor(proto, name).value
    const source = Function.prototype.toString.call(implementation)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    const body = source.slice(open + 1, close).trim()
    if (body.length === 0) continue
    const parts = body.split(',').map((part) => part.trim())
    assert.equal(new Set(parts).size, parts.length, `${name} must use unique parameter names`)
    for (const part of parts) {
      assert.match(part, /^[$A-Z_a-z][$\w]*$/u, `${name} must use plain identifier parameters`)
    }
  }
  assert.equal(typeof h.service.describe().then, 'function', 'describe must be awaitable')
})

test('describe reports a store that cannot locate its artifacts', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  h.ctx.sessionPersistence.locate = undefined

  const described = await h.service.describe()
  assert.equal(described.canLocate, false)
  assert.equal(described.supported, false)
  assert.equal(described.canRestore, false)
  assert.equal(described.canListTrash, false)
  assert.equal(described.trashCount, 0)
})

test('concurrent delete of one id shares a single run', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  let runs = 0
  const realMove = h.service.moveArtifact.bind(h.service)
  h.service.moveArtifact = async (source, destination) => {
    runs += 1
    return realMove(source, destination)
  }
  const [first, second] = await Promise.all([
    h.service.delete(SESSION_ID),
    h.service.delete(SESSION_ID),
  ])
  assert.equal(runs, 1, 'a double click must not interleave two deletions')
  assert.deepEqual(first, second)
})


test('different trash mutations for one session are serialized', async () => {
  const h = harness()
  let release
  const firstGate = new Promise((resolve) => { release = resolve })
  let restoreStarted
  const restoreStartedGate = new Promise((resolve) => { restoreStarted = resolve })
  const events = []
  const first = h.service.runTrashOperation('restore', SESSION_ID, async () => {
    events.push('restore:start')
    restoreStarted()
    await firstGate
    events.push('restore:end')
    return 'restored'
  })
  const second = h.service.runTrashOperation('purge', SESSION_ID, async () => {
    events.push('purge:start')
    return 'purged'
  })
  await restoreStartedGate
  assert.deepEqual(events, ['restore:start'])
  release()
  assert.equal(await first, 'restored')
  assert.equal(await second, 'purged')
  assert.deepEqual(events, ['restore:start', 'restore:end', 'purge:start'])
})

test('a queued trash mutation proceeds after the previous mutation rejects', async () => {
  const h = harness()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let started
  const startedGate = new Promise((resolve) => { started = resolve })
  const events = []
  const first = h.service.runTrashOperation('purge', SESSION_ID, async () => {
    events.push('purge:start')
    started()
    await gate
    events.push('purge:failed')
    throw new Error('simulated purge failure')
  })
  const second = h.service.runTrashOperation('restore', SESSION_ID, async () => {
    events.push('restore:start')
    return 'restored'
  })

  await startedGate
  assert.deepEqual(events, ['purge:start'])
  release()
  await assert.rejects(first, /simulated purge failure/)
  assert.equal(await second, 'restored')
  assert.deepEqual(events, ['purge:start', 'purge:failed', 'restore:start'])
})

test('same trash mutation joins the in-flight operation', async () => {
  const h = harness()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let started
  const startedGate = new Promise((resolve) => { started = resolve })
  let runs = 0
  const run = () => h.service.runTrashOperation('restore', SESSION_ID, async () => {
    runs += 1
    started()
    await gate
    return { restored: true }
  })
  const first = run()
  const second = run()
  await startedGate
  assert.equal(runs, 1)
  release()
  assert.deepEqual(await first, { restored: true })
  assert.deepEqual(await second, { restored: true })
  assert.equal(runs, 1)
})

test('retrying an already-trashed delete completes accounting after an interrupted first attempt', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store)
  const cache = new Map([[SESSION_ID, { rows: {} }]])
  const h = harness({
    ...storedTarget(store),
    registry,
    services: cacheServices(cache),
  })
  const release = h.service.releaseWorkspaceAccounting.bind(h.service)
  h.service.releaseWorkspaceAccounting = async () => {
    throw new Error('simulated interruption after the artifact move')
  }

  await assert.rejects(h.service.delete(SESSION_ID), /simulated interruption/)
  assert.deepEqual(registry.workspace.record.sessionIds, [SESSION_ID, 'session-older'])
  assert.ok((await readdir(store.trashRoot)).some((name) => name !== 'audit.jsonl'))

  // A fresh process sees the durable trash entry; retrying delete must replay
  // cleanup even though the session is no longer live or stored at its path.
  h.service.releaseWorkspaceAccounting = release
  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.trashed, true)
  assert.equal(registry.workspace.record.sessionIds.includes(SESSION_ID), false)
  assert.ok(registry.calls.some(([kind]) => kind === 'unpin'))
  assert.ok(registry.calls.some(([kind]) => kind === 'unarchive'))
  assert.equal(cache.has(SESSION_ID), false)
})

test('restore recovers a promoted cross-device copy left beside its trash source', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const originalMove = h.service.moveArtifact.bind(h.service)
  let interrupted = false
  h.service.moveArtifact = async (source, destination, options) => {
    if (!interrupted) {
      interrupted = true
      const { cp, mkdir } = await import('node:fs/promises')
      await mkdir(join(destination, '..'), { recursive: true })
      await cp(source, destination, { recursive: true })
      throw new Error('simulated process interruption after destination promotion')
    }
    return originalMove(source, destination, options)
  }

  await assert.rejects(h.service.restore(SESSION_ID), /simulated process interruption/)
  const entryPath = trashEntry(store, deleted.trashId)
  assert.ok((await stat(store.dir)).isDirectory(), 'the promoted destination must remain')
  assert.ok((await stat(join(entryPath, 'artifact'))).isDirectory(), 'the trash source must remain until verified')

  h.service.moveArtifact = originalMove
  const restored = await h.service.restore(SESSION_ID)
  assert.equal(restored.restored, true)
  assert.equal((await readFile(store.log, 'utf8')), '{"seq":0}\n')
  await assert.rejects(stat(entryPath), (error) => error.code === 'ENOENT')
})

test('restore preserves both copies when an interrupted destination differs', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  const deleted = await h.service.delete(SESSION_ID)
  const originalMove = h.service.moveArtifact.bind(h.service)
  h.service.moveArtifact = async (source, destination) => {
    const { cp, writeFile } = await import('node:fs/promises')
    await cp(source, destination, { recursive: true })
    await writeFile(join(destination, 'session.4.jsonl'), 'different\n')
    throw new Error('simulated interruption')
  }

  await assert.rejects(h.service.restore(SESSION_ID), /simulated interruption/)
  h.service.moveArtifact = originalMove
  await assert.rejects(h.service.restore(SESSION_ID), (error) => error.code === 'session-delete/conflict')
  assert.ok((await stat(store.dir)).isDirectory())
  assert.ok((await stat(trashEntry(store, deleted.trashId))).isDirectory())
})

test('restore retries after an interrupted partial cross-device copy', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })
  await h.service.delete(SESSION_ID)
  const originalMove = h.service.moveArtifact.bind(h.service)
  let interrupted = false
  h.service.moveArtifact = async (_source, destination) => {
    if (!interrupted) {
      interrupted = true
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(destination + '.partial', { recursive: true })
      await writeFile(join(destination + '.partial', 'partial.txt'), 'incomplete')
      throw new Error('simulated interruption during cross-device copy')
    }
    return originalMove(_source, destination)
  }

  await assert.rejects(h.service.restore(SESSION_ID), /simulated interruption during cross-device copy/)
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT', 'the original path remains absent')
  assert.ok((await stat(store.dir + '.partial')).isDirectory())

  h.service.moveArtifact = originalMove
  const restored = await h.service.restore(SESSION_ID)
  assert.equal(restored.restored, true)
  assert.equal(await readFile(store.log, 'utf8'), '{"seq":0}\n')
  await assert.rejects(stat(store.dir + '.partial'), (error) => error.code === 'ENOENT')
})

test('startup recovery releases stale workspace and projection accounting for committed trash entries', async () => {
  const store = await makeStore()
  const options = { pinned: true, archived: false }
  const registry = accountingRegistry(store, options)
  const cache = new Map()
  const h = harness({
    ...storedTarget(store),
    registry,
    services: cacheServices(cache),
  })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)

  // Simulate a process stop immediately after the artifact reached trash,
  // before workspace membership, pin/archive or cache cleanup completed.
  registry.workspace.record.sessionIds = [SESSION_ID, 'session-older']
  options.pinned = true
  cache.set(SESSION_ID, { rows: { stale: true } })
  registry.calls.length = 0
  h.calls.emitted.length = 0

  const result = await h.service.reconcileStartup()

  assert.deepEqual(result, { deleted: 1, restored: 0, preserved: 0 })
  assert.deepEqual(registry.workspace.record.sessionIds, ['session-older'])
  assert.deepEqual(registry.calls, [
    ['detach', SESSION_ID],
    ['unpin', SESSION_ID],
    ['unarchive', SESSION_ID],
  ])
  assert.equal(cache.has(SESSION_ID), false)
  assert.equal((await stat(join(entry, 'artifact'))).isDirectory(), true)
  assert.deepEqual(h.calls.emitted, [])
})

test('startup recovery finishes workspace accounting after a restore move lost its process', async () => {
  const store = await makeStore()
  const registryOptions = { pinned: true, failAttach: false }
  const registry = accountingRegistry(store, registryOptions)
  const h = harness({ ...storedTarget(store), registry })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)

  // Model the crash window after the artifact is back at its original path,
  // before .restoring is removed and before the manifest gets accounting-pending.
  await rename(join(entry, 'artifact'), store.dir)

  registryOptions.failAttach = false
  registry.calls.length = 0
  const result = await h.service.reconcileStartup()

  assert.deepEqual(result, { deleted: 0, restored: 1, preserved: 0 })
  assert.deepEqual(registry.calls, [['attach', SESSION_ID], ['insert', SESSION_ID, 'session-older'], ['pin', SESSION_ID]])
  assert.equal((await stat(store.log)).isFile(), true)
  await assert.rejects(stat(entry), (error) => error.code === 'ENOENT')
})

test('startup recovery resumes an explicit restore marker after the cross-device move', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store, { pinned: true })
  const h = harness({ ...storedTarget(store), registry })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  await writeFile(join(entry, '.restoring'), JSON.stringify({ sessionId: SESSION_ID, target: store.dir }))
  await rename(join(entry, 'artifact'), store.dir)

  const result = await h.service.reconcileStartup()

  assert.deepEqual(result, { deleted: 0, restored: 1, preserved: 0 })
  assert.equal((await stat(store.log)).isFile(), true)
  await assert.rejects(stat(entry), (error) => error.code === 'ENOENT')
})

test('startup recovery preserves a target/artifact conflict without releasing accounting', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store)
  const h = harness({ ...storedTarget(store), registry })
  const deleted = await h.service.delete(SESSION_ID)
  const entry = trashEntry(store, deleted.trashId)
  await mkdir(store.dir, { recursive: true })
  await writeFile(store.log, 'unrelated replacement\n')
  registry.workspace.record.sessionIds = [SESSION_ID, 'session-older']
  registry.calls.length = 0

  const result = await h.service.reconcileStartup()

  assert.deepEqual(result, { deleted: 0, restored: 0, preserved: 1 })
  assert.deepEqual(registry.workspace.record.sessionIds, [SESSION_ID, 'session-older'])
  assert.deepEqual(registry.calls, [])
  assert.equal((await stat(join(entry, 'artifact'))).isDirectory(), true)
  assert.match(h.calls.warnings.join('\n'), /ambiguous state/)
})

test('the Cordis ready hook starts startup reconciliation after services are ready', async () => {
  const store = await makeStore()
  const registry = accountingRegistry(store)
  const h = harness({ ...storedTarget(store), registry })
  const deleted = await h.service.delete(SESSION_ID)
  registry.workspace.record.sessionIds = [SESSION_ID, 'session-older']
  registry.calls.length = 0

  assert.equal(typeof h.calls.ready, 'function')
  await h.calls.ready()

  assert.deepEqual(registry.workspace.record.sessionIds, ['session-older'])
  assert.deepEqual(registry.calls, [
    ['detach', SESSION_ID],
    ['unpin', SESSION_ID],
    ['unarchive', SESSION_ID],
  ])
  assert.equal((await stat(join(trashEntry(store, deleted.trashId), 'artifact'))).isDirectory(), true)
})

test('startup recovery retries workspace accounting when a host write fails', async () => {
  const store = await makeStore()
  let failDetach = true
  const calls = []
  const workspace = {
    id: 'ws-1',
    path: store.root,
    record: { sessionIds: [SESSION_ID] },
    detachSession: async (id) => {
      calls.push(['detach', id])
      if (failDetach) throw new Error('injected detach failure')
      workspace.record.sessionIds = workspace.record.sessionIds.filter((entry) => entry !== id)
    },
  }
  const registry = {
    list: () => [workspace],
    unpinSession: async (id) => calls.push(['unpin', id]),
    unarchiveSession: async (id) => calls.push(['unarchive', id]),
  }
  const h = harness({ ...storedTarget(store), registry })
  await h.service.delete(SESSION_ID)

  // The first pass cannot complete membership cleanup and must leave the
  // committed trash entry eligible for a later retry.
  workspace.record.sessionIds = [SESSION_ID]
  calls.length = 0
  const first = await h.service.reconcileStartup()
  assert.deepEqual(first, { deleted: 0, restored: 0, preserved: 1 })
  assert.deepEqual(workspace.record.sessionIds, [SESSION_ID])

  failDetach = false
  calls.length = 0
  const second = await h.service.reconcileStartup()
  assert.deepEqual(second, { deleted: 1, restored: 0, preserved: 0 })
  assert.deepEqual(workspace.record.sessionIds, [])
  assert.deepEqual(calls, [
    ['detach', SESSION_ID],
    ['unpin', SESSION_ID],
    ['unarchive', SESSION_ID],
  ])
})

test('stale-lock reclaimers cannot rename a replacement lock held by another contender', async () => {
  const store = await makeStore()
  const h = harness({ root: store.root })
  const lockPath = await h.service.processLockPath(SESSION_ID)
  await mkdir(lockPath, { recursive: true })

  const deadOwnerProcess = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const deadPid = deadOwnerProcess.pid
  assert.ok(deadPid, 'the stale owner process must have a PID')
  await new Promise((resolve, reject) => {
    deadOwnerProcess.once('error', reject)
    deadOwnerProcess.once('exit', resolve)
  })
  assert.equal(h.service.isProcessAlive(deadPid), false, 'the fixture owner process must be definitely dead')

  const staleOwner = { pid: deadPid, host: hostname(), token: 'stale-owner-token', createdAt: Date.now() }
  await writeFile(join(lockPath, '.owner.json'), JSON.stringify(staleOwner) + '\n')

  const originalReadOwner = h.service.readProcessLockOwner.bind(h.service)
  let canonicalReads = 0
  let openRevalidation
  const revalidationGate = new Promise((resolve) => { openRevalidation = resolve })
  let announceRevalidation
  const revalidationStarted = new Promise((resolve) => { announceRevalidation = resolve })
  let openDelayedRead
  const delayedReadGate = new Promise((resolve) => { openDelayedRead = resolve })
  let announceDelayedRead
  const delayedReadStarted = new Promise((resolve) => { announceDelayedRead = resolve })

  h.service.readProcessLockOwner = async (candidatePath) => {
    const owner = await originalReadOwner(candidatePath)
    if (candidatePath !== lockPath) return owner
    canonicalReads += 1
    if (canonicalReads === 2) {
      announceRevalidation()
      await revalidationGate
    } else if (canonicalReads === 3) {
      announceDelayedRead()
      await delayedReadGate
    }
    return owner
  }

  let firstPromise
  let secondPromise
  let firstRelease
  let secondRelease
  let firstReleased = false
  let secondReleased = false
  try {
    firstPromise = h.service.acquireProcessLock(SESSION_ID)
    await revalidationStarted
    secondPromise = h.service.acquireProcessLock(SESSION_ID)
    await delayedReadStarted

    openRevalidation()
    firstRelease = await firstPromise
    openDelayedRead()

    let secondError
    const secondSettlement = secondPromise.then(
      (release) => {
        secondRelease = release
        return 'acquired'
      },
      (error) => {
        secondError = error
        return 'rejected'
      },
    )
    const secondBeforeRelease = await Promise.race([
      secondSettlement,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 200)),
    ])
    assert.equal(
      secondBeforeRelease,
      'pending',
      'a delayed observer of the dead owner must not move the first contender live replacement lock',
    )
    if (secondError) throw secondError

    await firstRelease()
    firstReleased = true
    if (!secondRelease) secondRelease = await secondPromise
    await secondRelease()
    secondReleased = true
  } finally {
    openRevalidation()
    openDelayedRead()
    if (firstRelease && !firstReleased) await firstRelease()
    if (secondPromise && !secondReleased) {
      const lateRelease = await Promise.race([
        secondPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ])
      if (typeof lateRelease === 'function') await lateRelease()
    } else if (secondRelease && !secondReleased) {
      await secondRelease()
    }
  }
})

test('a symlinked process-lock root is rejected before creating session locks', async (t) => {
  const store = await makeStore()
  const h = harness({ root: store.root })
  const lockRoot = join(store.base, '.session-delete-locks')
  const outside = join(store.base, 'outside-lock-root')
  await mkdir(outside)

  try {
    await symlink(outside, lockRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('the runner does not permit creating directory symlinks')
    return
  }

  await assert.rejects(
    h.service.acquireProcessLock(SESSION_ID),
    (error) => error?.code === 'session-delete/unsafe-path',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('a symlinked process-lock directory is rejected without following its target', async (t) => {
  const store = await makeStore()
  const h = harness({ root: store.root })
  const lockPath = await h.service.processLockPath(SESSION_ID)
  const lockRoot = join(store.base, '.session-delete-locks')
  const outside = join(store.base, 'outside-lock-target')
  await mkdir(lockRoot, { recursive: true })
  await mkdir(outside)

  try {
    await symlink(outside, lockPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('the runner does not permit creating directory symlinks')
    return
  }

  await assert.rejects(
    h.service.acquireProcessLock(SESSION_ID),
    (error) => error?.code === 'session-delete/unsafe-path',
  )
  assert.ok((await stat(outside)).isDirectory())
  assert.deepEqual(await readdir(outside), [])
})

test('a symlinked process-lock owner file is rejected without reading its target', async (t) => {
  const store = await makeStore()
  const h = harness({ root: store.root })
  const lockPath = await h.service.processLockPath(SESSION_ID)
  const lockRoot = join(store.base, '.session-delete-locks')
  const outside = join(store.base, 'outside-lock-owner.json')
  await mkdir(lockRoot, { recursive: true })
  await mkdir(lockPath)
  await writeFile(outside, 'external-owner-data', 'utf8')

  try {
    await symlink(outside, join(lockPath, '.owner.json'), 'file')
  } catch {
    t.skip('the runner does not permit creating file symlinks')
    return
  }

  await assert.rejects(
    h.service.acquireProcessLock(SESSION_ID),
    (error) => error?.code === 'session-delete/unsafe-path',
  )
  assert.equal(await readFile(outside, 'utf8'), 'external-owner-data')
})

test('filesystem session locks use one canonical path for symlinked store roots', async () => {
  const store = await makeStore()
  const alias = join(store.base, 'sessions-alias')
  await symlink(store.root, alias, process.platform === 'win32' ? 'junction' : 'dir')

  const direct = harness({ root: store.root })
  const linked = harness({ root: alias })
  assert.equal(
    await direct.service.processLockPath(SESSION_ID),
    await linked.service.processLockPath(SESSION_ID),
  )
})

test('filesystem session locks serialize two independent Node processes', async () => {
  const store = await makeStore()
  const marker = join(store.base, 'lock-events.txt')
  const moduleUrl = new URL('../index.js', import.meta.url).href
  const worker = `
    import { appendFile } from 'node:fs/promises'
    const [moduleUrl, root, sessionId, marker, holdMs] = process.argv.slice(1)
    const { apply } = await import(moduleUrl)
    const provided = new Map()
    const sessions = { get: () => undefined, store: new Map() }
    const persistence = { root, stat: async () => undefined, list: async () => [] }
    const ctx = {
      sessions,
      sessionPersistence: persistence,
      get: (name) => name === 'sessions' ? sessions : name === 'sessionPersistence' ? persistence : undefined,
      reflect: { provide: (name, value) => provided.set(name, value) },
      on: () => {},
      waterfall: async (_name, _payload, base) => base(),
      parallel: async () => {},
      emit: () => {},
      logger: { warn: () => {} },
    }
    apply(ctx, { mode: 'permanent' })
    const service = provided.get('sessionDelete')
    await service.withProcessLock(sessionId, async () => {
      await appendFile(marker, 'start\\n')
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
      await appendFile(marker, 'end\\n')
    })
  `
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, moduleUrl, store.root, SESSION_ID, marker, '250'], {
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock worker exited with ${code}`)))
  })
  await Promise.all([launch(), launch()])
  const events = (await readFile(marker, 'utf8')).trim().split('\n')
  assert.deepEqual(events, ['start', 'end', 'start', 'end'])
})

test('lock release preserves a directory after its owner token is replaced', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const h = harness({ ...storedTarget(store) })
  const lockPath = await h.service.processLockPath(SESSION_ID)
  const release = await h.service.acquireProcessLock(SESSION_ID)
  const ownerPath = join(lockPath, '.owner.json')
  const replacement = {
    pid: process.pid,
    host: hostname(),
    token: 'replacement-owner-token',
    createdAt: Date.now(),
  }

  await writeFile(ownerPath, JSON.stringify(replacement) + '\n')
  await release()

  const current = await h.service.readProcessLockOwner(lockPath)
  assert.equal(current?.token, replacement.token)
  assert.equal((await stat(lockPath)).isDirectory(), true)
})

test('a dead same-host lock owner is reclaimed after process exit', async () => {
  const store = await makeStore()
  const marker = join(store.base, 'stale-lock-events.txt')
  const moduleUrl = new URL('../index.js', import.meta.url).href
  const worker = `
    import { appendFile } from 'node:fs/promises'
    const [moduleUrl, root, sessionId, marker] = process.argv.slice(1)
    const { apply } = await import(moduleUrl)
    const provided = new Map()
    const sessions = { get: () => undefined, store: new Map() }
    const persistence = { root, stat: async () => undefined, list: async () => [] }
    const ctx = {
      sessions,
      sessionPersistence: persistence,
      get: (name) => name === 'sessions' ? sessions : name === 'sessionPersistence' ? persistence : undefined,
      reflect: { provide: (name, value) => provided.set(name, value) },
      on: () => {},
      waterfall: async (_name, _payload, base) => base(),
      parallel: async () => {},
      emit: () => {},
      logger: { warn: () => {} },
    }
    apply(ctx, { mode: 'permanent' })
    await provided.get('sessionDelete').withProcessLock(sessionId, async () => {
      await appendFile(marker, 'held\\n')
      process.exit(0)
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, moduleUrl, store.root, SESSION_ID, marker], {
    stdio: 'ignore',
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        ready = (await readFile(marker, 'utf8')).includes('held')
        if (ready) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(ready, true, 'the child must acquire the lock before it is terminated')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      child.kill()
      await exited
    }
  }

  const h = harness({ ...storedTarget(store) })
  await h.service.withProcessLock(SESSION_ID, async () => {
    await appendFile(marker, 'reclaimed\n')
  })
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['held', 'reclaimed'])
})


test('independent plugin instances serialize delete and restore for the same session', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const deleting = harness({ ...storedTarget(store) })
  const restoring = harness({ ...storedTarget(store) })

  const originalMove = deleting.service.moveArtifact.bind(deleting.service)
  let announceMove
  const moveStarted = new Promise((resolve) => { announceMove = resolve })
  let releaseMove
  const moveGate = new Promise((resolve) => { releaseMove = resolve })
  deleting.service.moveArtifact = async (...args) => {
    announceMove()
    await moveGate
    return originalMove(...args)
  }

  const originalAcquire = restoring.service.acquireProcessLock.bind(restoring.service)
  let announceLockAttempt
  const lockAttempt = new Promise((resolve) => { announceLockAttempt = resolve })
  restoring.service.acquireProcessLock = async (...args) => {
    announceLockAttempt()
    return originalAcquire(...args)
  }

  const deletePromise = deleting.service.delete(SESSION_ID)
  await moveStarted
  const restorePromise = restoring.service.restore(SESSION_ID)
  // Do not release delete until the other service has actually attempted
  // to acquire the shared filesystem lock.
  await lockAttempt
  releaseMove()

  const [deleted, restored] = await Promise.all([deletePromise, restorePromise])
  assert.equal(deleted.trashed, true)
  assert.equal(restored.restored, true)
  assert.equal((await stat(store.dir)).isDirectory(), true)
  await assert.rejects(stat(trashEntry(store, deleted.trashId)), (error) => error.code === 'ENOENT')
  assert.deepEqual((await restoring.service.listTrash()).entries, [])
})


test('independent plugin instances serialize restore and purge for the same session', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const initial = harness({ ...storedTarget(store) })
  const restoring = harness({ ...storedTarget(store) })
  const purging = harness({ ...storedTarget(store) })
  await initial.service.delete(SESSION_ID)

  const originalMove = restoring.service.moveArtifact.bind(restoring.service)
  let announceMove
  const moveStarted = new Promise((resolve) => { announceMove = resolve })
  let releaseMove
  const moveGate = new Promise((resolve) => { releaseMove = resolve })
  restoring.service.moveArtifact = async (...args) => {
    announceMove()
    await moveGate
    return originalMove(...args)
  }

  const restorePromise = restoring.service.restore(SESSION_ID)
  await moveStarted

  const originalAcquire = purging.service.acquireProcessLock.bind(purging.service)
  let announceLockAttempt
  const lockAttempt = new Promise((resolve) => { announceLockAttempt = resolve })
  purging.service.acquireProcessLock = async (...args) => {
    announceLockAttempt()
    return originalAcquire(...args)
  }
  const purgePromise = purging.service.purge(SESSION_ID).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await lockAttempt
  releaseMove()

  const restored = await restorePromise
  const purge = await purgePromise
  assert.equal(restored.restored, true)
  assert.equal(purge.error?.code, 'session-delete/not-found')
  assert.equal((await stat(store.dir)).isDirectory(), true)
  assert.deepEqual((await purging.service.listTrash()).entries, [])
});

test('artifact operations stay on the canonical parent when a project symlink is replaced', async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const alias = join(store.root, 'project-alias')
  await symlink(store.project, alias, 'dir')
  const outsideProject = join(store.base, 'outside-project')
  const outsideSession = join(outsideProject, SESSION_ID)
  await mkdir(outsideSession, { recursive: true })
  await writeFile(join(outsideSession, 'session.4.jsonl'), 'outside sentinel\\n')

  const h = harness({
    root: store.root,
    locate: () => ({ kind: 'jsonl', path: join(alias, SESSION_ID, 'session.4.jsonl') }),
  })
  const artifact = await h.service.resolveArtifact({ id: SESSION_ID }, SESSION_ID)

  assert.equal(artifact.target, await realpath(store.dir), 'the operation path must use the canonical project parent')

  // Simulate an attacker replacing the original project alias after the
  // safety check but before the destructive operation.
  await rm(alias)
  await symlink(outsideProject, alias, 'dir')
  await h.service.removeArtifact(artifact.target)

  assert.equal(
    await readFile(join(outsideSession, 'session.4.jsonl'), 'utf8'),
    'outside sentinel\\n',
    'replacing the locator alias must not redirect removal outside the store',
  )
  await assert.rejects(stat(store.dir), (error) => error?.code === 'ENOENT')
})


test('process crash after the Trash move is recovered by a fresh process', { timeout: 30000 }, async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const workerPath = fileURLToPath(new URL('../scripts/fixtures/session-delete-crash-recovery.mjs', import.meta.url))

  const runWorker = (mode) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, mode, store.root, SESSION_ID], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })

  // The worker exits from inside releaseWorkspaceAccounting, after the
  // artifact and manifest have reached Trash but before membership/pin/cache
  // cleanup or the normal operation-lock finally block can run.
  const crashed = await runWorker('crash-delete')
  assert.equal(crashed.code, 86, crashed.stderr)

  await assert.rejects(stat(store.log), (error) => error.code === 'ENOENT')
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
  const entryIds = (await readdir(store.trashRoot)).filter((name) => name !== 'audit.jsonl')
  assert.equal(entryIds.length, 1, 'the durable Trash entry must survive process termination')
  const entry = trashEntry(store, entryIds[0])
  assert.equal((await stat(join(entry, 'artifact'))).isDirectory(), true)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  assert.deepEqual(manifest.accounting, {
    member: true,
    pinned: true,
    archived: false,
    workspaceId: 'workspace-process-crash',
    beforeSessionId: 'session-older',
  })

  // This is a separate Node process with fresh in-memory Registry state. It
  // must reclaim the dead process's filesystem lock and replay cleanup from
  // the durable Trash manifest.
  const recovered = await runWorker('recover-delete')
  assert.equal(recovered.code, 0, recovered.stderr)
  const report = JSON.parse(recovered.stdout.trim())
  assert.deepEqual(report.result, { deleted: 1, restored: 0, preserved: 0 })
  assert.deepEqual(report.sessionIds, ['session-older'])
  assert.deepEqual(report.pinned, [])
  assert.deepEqual(report.archived, [])
  await assert.rejects(stat(report.lockPath), (error) => error.code === 'ENOENT')

  // Recovery is bookkeeping-only: it must not move, purge or rewrite the
  // trashed artifact, so the user can still restore it later.
  assert.equal((await stat(join(entry, 'artifact'))).isDirectory(), true)
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT')
})


test('process crash after a restore move is recovered by a fresh process', { timeout: 30000 }, async (t) => {
  const store = await makeStore()
  t.after(() => rm(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const registry = accountingRegistry(store, {
    pinned: false,
    archived: true,
    sessionIds: [SESSION_ID, 'session-older'],
  })
  const h = harness({ ...storedTarget(store), registry })
  const deleted = await h.service.delete(SESSION_ID)
  assert.equal(deleted.trashed, true)

  const entry = trashEntry(store, deleted.trashId)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  assert.deepEqual(manifest.accounting, {
    member: true,
    pinned: false,
    archived: true,
    workspaceId: 'ws-1',
    beforeSessionId: 'session-older',
  })

  const workerPath = fileURLToPath(new URL('../scripts/fixtures/session-delete-crash-recovery.mjs', import.meta.url))
  const runWorker = (mode) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, mode, store.root, SESSION_ID], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })

  // The child performs the real move from Trash to the session store, then
  // exits before marker removal, Registry reattachment or Trash cleanup.
  const crashed = await runWorker('crash-restore')
  assert.equal(crashed.code, 87, crashed.stderr)
  await assert.equal((await stat(store.dir)).isDirectory(), true)
  assert.equal(await readFile(store.log, 'utf8'), '{"seq":0}\n')
  await assert.rejects(stat(join(entry, 'artifact')), (error) => error.code === 'ENOENT')
  assert.equal((await stat(join(entry, '.restoring'))).isFile(), true)

  // A new process sees the restore marker and the already-promoted artifact.
  // It must reclaim the dead lock, reattach the saved workspace slot/archive
  // mark, and remove only the now-obsolete Trash transaction.
  const recovered = await runWorker('recover-restore')
  assert.equal(recovered.code, 0, recovered.stderr)
  const report = JSON.parse(recovered.stdout.trim())
  assert.deepEqual(report.result, { deleted: 0, restored: 1, preserved: 0 })
  assert.deepEqual(report.sessionIds, [SESSION_ID, 'session-older'])
  assert.deepEqual(report.pinned, [])
  assert.deepEqual(report.archived, [SESSION_ID])
  assert.equal(report.trashEntry, false)
  await assert.rejects(stat(report.lockPath), (error) => error.code === 'ENOENT')
  assert.equal((await stat(store.dir)).isDirectory(), true)
  assert.equal(await readFile(store.log, 'utf8'), '{"seq":0}\n')
  await assert.rejects(stat(entry), (error) => error.code === 'ENOENT')
})
