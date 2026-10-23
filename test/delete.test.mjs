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
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const registry = options.registry ?? {
    list: () => [],
    unpinSession: async () => {},
    unarchiveSession: async () => {},
  }

  const ctx = {
    sessions,
    sessionPersistence: persistence,
    waterfall: async (_name, _payload, base) => (options.activity ? options.activity : base()),
    parallel: async (_name, payload) => {
      calls.stopped.push(payload.sessionId)
    },
    emit: (name, payload) => {
      calls.emitted.push([name, payload])
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
    services: cacheServices(cache, () => sequence.push('cache')),
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
  assert.deepEqual(sequence, ['detach', 'unpin', 'unarchive', 'cache'])
  assert.equal(cache.has(SESSION_ID), false)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
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

test('a store without a root has no trash, so the deletion reports trash-unavailable', async () => {
  const store = await makeStore()
  const h = harness({
    ...storedTarget(store),
    root: undefined,
    locate: () => ({ kind: 'file', path: store.log }),
  })

  await assert.rejects(h.service.delete(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/trash-unavailable')
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.details.reason, 'no-trash-root')
    return true
  })
  assert.ok((await stat(store.log)).isFile(), 'the artifact must survive a refused deletion')
})

test('the trash entry holds the artifact and a manifest of the identifying fields', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store) })

  const outcome = await h.service.delete(SESSION_ID)

  const entry = trashEntry(store, outcome.trashId)
  const manifest = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8'))
  assert.equal(manifest.sessionId, SESSION_ID)
  assert.equal(manifest.originalPath, store.dir)
  assert.equal(typeof manifest.deletedAt, 'string')
  assert.equal(manifest.mode, 'trash')
  assert.deepEqual(manifest.header, { id: SESSION_ID, cwd: store.dir })
  assert.deepEqual(manifest.children, [])
  const moved = join(entry, 'artifact')
  assert.equal((await stat(join(moved, 'session.4.jsonl'))).isFile(), true)
  await assert.rejects(stat(store.dir), (error) => error.code === 'ENOENT', 'the original location must be empty')
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
  // Simulate a crash between the move and the accounting replay.
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

  await assert.rejects(h.service.restore(SESSION_ID), (error) => {
    assert.equal(error.code, 'session-delete/conflict')
    assert.equal(error.details.path, store.dir)
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

test('the trash listing reports every entry, newest first', async () => {
  const store = await makeStore()
  const second = await addSecondSession(store)
  const h = harness({ ...twoSessionTarget(store) })

  const first = await h.service.delete(SESSION_ID)
  const other = await h.service.delete(second.id)

  const listed = await h.service.listTrash()
  assert.equal(listed.entries.length, 2)
  assert.equal(listed.entries[0].trashId, other.trashId)
  assert.equal(listed.entries[1].trashId, first.trashId)
  assert.equal(listed.entries[0].sessionId, second.id)
  assert.equal(listed.entries[0].originalPath, join(store.project, second.id))
  assert.equal(typeof listed.entries[0].deletedAt, 'string')
})

test('entries older than the retention window are purged lazily', async () => {
  const store = await makeStore()
  const h = harness({ ...storedTarget(store), config: { retentionDays: 1 } })

  await h.service.delete(SESSION_ID)
  const expired = trashEntry(store, h.service.trashIndex.keys().next().value)
  const manifest = JSON.parse(await readFile(join(expired, 'meta.json'), 'utf8'))
  manifest.deletedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  await writeFile(join(expired, 'meta.json'), JSON.stringify(manifest))

  const listed = await h.service.listTrash()

  assert.deepEqual(listed.entries, [], 'an expired entry must not survive the sweep')
  await assert.rejects(stat(expired), (error) => error.code === 'ENOENT')
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
