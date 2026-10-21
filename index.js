/**
 * Host half of the session-delete bundle.
 *
 * Owns one operation: permanently delete a stored conversation. The session's
 * durable log directory goes away, its workspace accounting (membership, pin,
 * archive) is released, its projection-cache record is dropped, and the
 * browser is told the row is gone.
 *
 * The browser half calls `sessionDelete/delete` over the shared Remote
 * carrier. The endpoint is reachable through the API Gateway's runtime "SRC"
 * dispatch: the Gateway looks for a live Service that carries a
 * `typertRemote` binding plus Remote method markers, so this bundle needs no
 * generated Typert artifact.
 *
 * The bundle deliberately has no package dependencies: a bundle installed from
 * a local directory resolves its imports from that directory, so every import
 * would have to be a Node built-in.
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Cordis service key of this plugin's service. */
const SERVICE_KEY = 'sessionDelete'
/** Wire namespace the API Gateway exposes for this service. */
const NAMESPACE = 'sessionDelete'
/** Property the Typert protocol stores Remote method markers under. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Shared symbol Cordis uses to bind a service value to its owning context. */
const TRACKER = Symbol.for('cordis.tracker')
/** Milliseconds between removal attempts while a writer settles. */
const REMOVE_RETRY_MS = 60
/** How many times the removal is repeated. */
const REMOVE_ATTEMPTS = 4

/** Read an optional service without failing when the composition lacks it. */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Pause for `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class SessionDeleteService {
  /**
   * @param ctx - the owning plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: NAMESPACE,
    })
  }

  /**
   * Delete one conversation.
   * @param sessionId - durable Session identity.
   * @returns the deleted identity and whether a stored log was removed.
   */
  async delete(sessionId) {
    const ctx = this.ctx
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionDelete: a session id is required')
    }

    // 1. Resolve the target: a live session, otherwise a stored one.
    const live = ctx.sessions.get(sessionId)
    let header = live?.header
    if (!header) {
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      if (!snapshot) throw new Error(`sessionDelete: session "${sessionId}" was not found`)
      header = snapshot.header
      if (!header) throw new Error(`sessionDelete: session "${sessionId}" carries no stored header`)
    }

    // 2. Refuse while the conversation still owns running work.
    const activity = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId },
      () => Promise.resolve([]),
    )
    if (Array.isArray(activity) && activity.length > 0) {
      throw new Error(
        `sessionDelete: session "${sessionId}" is still running work; stop it before deleting`,
      )
    }

    // 3. Stop what is left, then let a live session leave the stores so its
    //    writer closes and the row leaves the list.
    await ctx.parallel('workspace/session-stop', { sessionId }).catch(() => {})
    if (live) {
      await ctx.sessions.flush(live).catch(() => {})
      this.detach(sessionId)
    }

    // 4. Release the durable workspace accounting.
    const registry = optionalService(ctx, 'workspaceRegistry')
    if (registry) {
      await registry.unpinSession(sessionId).catch(() => {})
      await registry.unarchiveSession(sessionId).catch(() => {})
      for (const workspace of registry.list()) {
        if (workspace.record?.sessionIds?.includes(sessionId)) {
          await workspace.detachSession(sessionId).catch(() => {})
        }
      }
    }

    // 5. Remove the stored conversation.
    const removed = await this.removeStoredLog(header)

    // 6. Drop the projection-cache record so no stale hint survives.
    await this.removeProjectionCache(sessionId)

    // 7. A live session announced its own removal through `session/disposed`;
    //    a stored one has no such event, so announce it here.
    if (!live) ctx.emit('api-session/removed', sessionId)

    return { sessionId, removed }
  }

  /**
   * Remove one session from the live session and agent stores.
   * @param sessionId - durable Session identity.
   */
  detach(sessionId) {
    const ctx = this.ctx
    const sessions = optionalService(ctx, 'sessions')
    const entry = sessions?.store?.get(sessionId)
    if (entry && typeof sessions.detachEntered === 'function') {
      try {
        sessions.detachEntered(entry)
      } catch (error) {
        ctx.logger?.warn(`sessionDelete: detaching session "${sessionId}" failed: ${String(error)}`)
      }
    }
    const agents = optionalService(ctx, 'agents')
    const agentEntry = agents?.store?.get(sessionId)
    if (agentEntry && typeof agents.detachEntered === 'function') {
      try {
        agents.detachEntered(agentEntry)
      } catch (error) {
        ctx.logger?.warn(`sessionDelete: detaching agent "${sessionId}" failed: ${String(error)}`)
      }
    }
  }

  /**
   * Remove the session's stored log directory.
   *
   * The store owns the on-disk layout, so its own locator names the artifact
   * and the session directory is that artifact's parent. A writer that is
   * still closing can append once more and recreate the file, so the removal
   * is repeated briefly.
   * @param header - the stored session header.
   * @returns whether a stored log was removed.
   */
  async removeStoredLog(header) {
    const persistence = this.ctx.sessionPersistence
    const locate = persistence?.locate
    if (typeof locate !== 'function') {
      throw new Error('sessionDelete: this session store does not expose its on-disk layout')
    }
    const location = locate.call(persistence, header)
    if (!location?.path) return false
    const directory = dirname(location.path)
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
      await rm(directory, { recursive: true, force: true })
      if (attempt < REMOVE_ATTEMPTS - 1) await delay(REMOVE_RETRY_MS)
    }
    return true
  }

  /**
   * Drop the stored projection-cache record of one session.
   * @param sessionId - durable Session identity.
   */
  async removeProjectionCache(sessionId) {
    const storageDomain = optionalService(this.ctx, 'storageDomain')
    if (!storageDomain || typeof storageDomain.get !== 'function') return
    const domain = storageDomain.get('session_projcache')
    if (!domain || typeof domain.table !== 'function') return
    await domain.table('sessions').delete(sessionId).catch(() => {})
  }
}

// Declare the Remote method for the API Gateway's runtime dispatch. The
// marker format is the Typert protocol's public, versioned descriptor: a
// frozen record on the class prototype naming the exported methods.
Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({
        method: 'delete',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({ session: (request) => request?.sessionId }),
      }),
    ]),
  }),
})

/**
 * Register the deletion service and let the browser reach it.
 * @param ctx - the owning plugin context.
 */
export function apply(ctx) {
  const service = new SessionDeleteService(ctx)
  // Bind the service to the calling context the way a Cordis Service does, so
  // the API Gateway reaches it through the same traced proxy.
  Object.defineProperty(service, TRACKER, {
    value: { associate: SERVICE_KEY, property: 'ctx' },
  })
  ctx.reflect.provide(SERVICE_KEY, service, undefined)
}
