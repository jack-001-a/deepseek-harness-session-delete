/**
 * Host-half tests for @ybbmm/dsh-session-delete.
 *
 * These run against the real module with a fake Cordis context, so they pin
 * down the ordering contract (a failed log removal must not release
 * accounting), the retry policy, the error codes the browser localizes, and
 * the Remote marker the API Gateway reads — without a running Harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
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
    logger: { warn: () => {} },
    reflect: {
      provide: (name, value) => {
        extra.__provided ??= new Map()
        extra.__provided.set(name, value)
      },
    },
  }

  apply(ctx)
  const service = extra.__provided.get('sessionDelete')
  assert.ok(service, 'apply() must provide the sessionDelete service')
  return { ctx, service, calls }
}

/** Create a real session directory with one log file inside. */
async function makeSessionDir() {
  const root = await mkdtemp(join(tmpdir(), 'session-delete-'))
  const dir = join(root, 'session-test-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.4.jsonl'), '{"seq":0}\n')
  return { root, dir, log: join(dir, 'session.4.jsonl') }
}

/** One stored session whose locator points at `dir`. */
function storedTarget(dir) {
  return {
    dir,
    stat: async () => ({ header: { id: SESSION_ID, cwd: dir } }),
    locate: () => ({ kind: 'jsonl', path: join(dir, 'session.4.jsonl') }),
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

test('stored session: removes the log, then releases accounting and cache', async () => {
  const { dir, log } = await makeSessionDir()
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
    ...storedTarget(dir),
    registry,
    services: cacheServices(cache, () => sequence.push('cache')),
  })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.removed, true)
  assert.equal(outcome.wasLive, false)
  assert.equal(outcome.stored, true)
  assert.deepEqual(outcome.children, [])
  await assert.rejects(stat(log), (error) => error.code === 'ENOENT')
  assert.deepEqual(sequence, ['detach', 'unpin', 'unarchive', 'cache'])
  assert.equal(cache.has(SESSION_ID), false)
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
  assert.deepEqual(h.calls.stopped, [SESSION_ID])
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
  const { dir, log } = await makeSessionDir()
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
    ...storedTarget(dir),
    registry,
    services: cacheServices(cache, () => accounted.push('cache')),
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
  assert.ok((await stat(log)).isFile(), 'the log must survive a failed deletion')
  assert.deepEqual(accounted, [], 'accounting and cache must not be released before the log is gone')
  assert.deepEqual(h.calls.emitted, [], 'a failed deletion must not announce a removal')
})

test('transient failure then success: retries with back-off and finishes', async () => {
  const { dir, log } = await makeSessionDir()
  const h = harness({ ...storedTarget(dir) })
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
  await assert.rejects(stat(log), (error) => error.code === 'ENOENT')
})

test('non-retryable failure: reports io immediately instead of retrying', async () => {
  const { dir } = await makeSessionDir()
  const h = harness({ ...storedTarget(dir) })
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
  const { dir, log } = await makeSessionDir()
  const target = storedTarget(dir)
  // The real store re-scans the disk, so `stat` stops resolving once the log
  // is gone; this fake mirrors that instead of replaying one frozen snapshot.
  const h = harness({
    ...target,
    stat: async () => {
      try {
        await stat(log)
        return { header: { id: SESSION_ID, cwd: dir } }
      } catch {
        return undefined
      }
    },
  })
  assert.equal((await h.service.delete(SESSION_ID)).removed, true)
  await assert.rejects(stat(log), (error) => error.code === 'ENOENT')
  await assert.rejects(h.service.delete(SESSION_ID), (error) => error.code === 'session-delete/not-found')
})

test('unmaterialized session: nothing is removed, but the row is still released', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-delete-'))
  const h = harness({
    ...storedTarget(dir),
    locate: () => ({ kind: 'jsonl', path: join(dir, 'session-test-1', 'session.4.jsonl') }),
  })
  const outcome = await h.service.delete(SESSION_ID)
  assert.equal(outcome.removed, false, 'a session with no artifact must not claim a file removal')
  assert.deepEqual(h.calls.emitted, [['api-session/removed', SESSION_ID]])
  assert.deepEqual(h.calls.stopped, [SESSION_ID])
})

test('live session: flushes, detaches, and lets the session announce its own removal', async () => {
  const { dir, log } = await makeSessionDir()
  const live = { id: SESSION_ID, header: { id: SESSION_ID, cwd: dir } }
  const agents = {
    store: new Map([[SESSION_ID, { id: 'agent' }]]),
    detachEntered: (entry) => detachAgent(entry),
  }
  const agentDetaches = []
  const detachAgent = (entry) => agentDetaches.push(entry.id)
  const h = harness({ ...storedTarget(dir), live, services: { agents } })
  h.ctx.sessions.store.set(SESSION_ID, { id: SESSION_ID })

  const outcome = await h.service.delete(SESSION_ID)

  assert.equal(outcome.wasLive, true)
  assert.deepEqual(h.calls.flushed, [SESSION_ID])
  assert.deepEqual(h.calls.detached, [SESSION_ID])
  assert.deepEqual(agentDetaches, ['agent'])
  // The disposed session emits `api-session/removed` itself; emitting again
  // would double-apply the removal on the browser.
  assert.deepEqual(h.calls.emitted, [])
  await assert.rejects(stat(log), (error) => error.code === 'ENOENT')
})

test('forked children are reported, not deleted', async () => {
  const { dir } = await makeSessionDir()
  const h = harness({
    ...storedTarget(dir),
    list: async () => [
      { header: { id: SESSION_ID, cwd: dir } },
      { header: { id: 'child-1', cwd: dir, parentSession: SESSION_ID } },
      { header: { id: 'child-2', cwd: dir, parentSession: 'other' } },
    ],
  })
  const outcome = await h.service.delete(SESSION_ID)
  assert.deepEqual(outcome.children, ['child-1'])
})

test('projection cache is re-checked when a disposal checkpoint recreates the row', async () => {
  const { dir } = await makeSessionDir()
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
    ...storedTarget(dir),
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

test('Remote marker exposes a resources reader that receives the id itself', async () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(h.service),
    REMOTE_METHODS,
  )
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value.methods.find((method) => method.method === 'delete')
  assert.ok(marker, 'delete must be marked Remote')
  assert.equal(marker.resources.session(SESSION_ID), SESSION_ID)
  assert.equal(marker.resources.session(undefined), undefined)
})

test('concurrent delete of one id shares a single run', async () => {
  const { dir } = await makeSessionDir()
  const h = harness({ ...storedTarget(dir) })
  let runs = 0
  const realRemove = h.service.removeArtifact.bind(h.service)
  h.service.removeArtifact = async (path) => {
    runs += 1
    return realRemove(path)
  }
  const [first, second] = await Promise.all([
    h.service.delete(SESSION_ID),
    h.service.delete(SESSION_ID),
  ])
  assert.equal(runs, 1, 'a double click must not interleave two deletions')
  assert.deepEqual(first, second)
})
