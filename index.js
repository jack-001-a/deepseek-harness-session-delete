/**
 * Host half of the session-delete bundle.
 *
 * Owns one operation: permanently delete a stored conversation. The session's
 * durable log artifact goes away, its workspace accounting (membership, pin,
 * archive) is released, its projection-cache record is dropped, and the
 * browser is told the row is gone.
 *
 * The browser half calls `sessionDelete/delete` over the shared Remote
 * carrier. The endpoint is reachable through the API Gateway's runtime "SRC"
 * dispatch: the Gateway looks for a live Service that carries a
 * `typertRemote` binding plus Remote method markers, so this bundle needs no
 * generated Typert artifact.
 *
 * Ordering is transactional on purpose: every step before the log removal can
 * still be abandoned without leaving a user-visible inconsistency, so the one
 * irreversible step runs first among the mutating steps and everything after
 * it is fail-soft. A failed deletion therefore leaves the conversation exactly
 * as it was, and retrying is meaningful.
 *
 * The bundle deliberately has no package dependencies: a bundle installed from
 * a local directory resolves its imports from that directory, so every import
 * would have to be a Node built-in.
 */
import { rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Cordis service key of this plugin's service. */
const SERVICE_KEY = 'sessionDelete'
/** Wire namespace the API Gateway exposes for this service. */
const NAMESPACE = 'sessionDelete'
/** Property the Typert protocol stores Remote method markers under. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Shared symbol Cordis uses to bind a service value to its owning context. */
const TRACKER = Symbol.for('cordis.tracker')
/** Bounded retries for a removal a closing writer may still be holding open. */
const REMOVE_ATTEMPTS = 8
/** First back-off delay; doubled per attempt up to the ceiling. */
const REMOVE_RETRY_BASE_MS = 40
/** Ceiling of the removal back-off delay. */
const REMOVE_RETRY_MAX_MS = 400
/** How many times the projection-cache row is re-checked after a delete. */
const CACHE_ATTEMPTS = 4
/** Pause between projection-cache checks. */
const CACHE_RETRY_MS = 60
/** Errors that mean "a handle is still open", not "this will never work". */
const RETRYABLE_REMOVE_CODES = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'ENOTEMPTY',
  'EEXIST',
  'EMFILE',
  'ENFILE',
])

/**
 * One deletion failure with a stable code and caller-facing message.
 *
 * The Gateway forwards any thrown value carrying the protocol's structural
 * Remote marker unchanged, so `code` crosses the wire instead of folding into
 * `gateway/internal`; a plain Error would lose it.
 */
class SessionDeleteError extends Error {
  /**
   * @param code - stable failure code the browser localizes.
   * @param message - diagnostic text, also the browser's fallback copy.
   * @param details - structured payload for the dialog.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SessionDeleteError'
    this.code = code
    this.details = details
    // Cross-bundle identification: the Gateway tests this marker rather than
    // `instanceof`, because the protocol package resolves separately.
    this.isDSHRemoteError = true
  }
}

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

/** Whether a filesystem failure is worth retrying while the writer settles. */
function isRetryableRemoveFailure(error) {
  const code = error?.code
  return typeof code === 'string' && RETRYABLE_REMOVE_CODES.has(code)
}

/** The back-off delay before attempt `attempt` (0-based). */
function removeRetryDelay(attempt) {
  return Math.min(REMOVE_RETRY_BASE_MS * 2 ** attempt, REMOVE_RETRY_MAX_MS)
}

class SessionDeleteService {
  /**
   * @param ctx - the owning plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    /** Deletions in flight, so two clicks cannot interleave their steps. */
    this.inflight = new Map()
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: NAMESPACE,
    })
  }

  /**
   * Delete one conversation.
   *
   * Steps run in an order where only the log removal is irreversible, and it
   * runs before the accounting release: a failure there aborts with the row
   * still listed and retryable.
   * @param sessionId - durable Session identity.
   * @returns the deleted identity, what was removed, and surviving children.
   */
  async delete(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionDeleteError(
        'session-delete/invalid-request',
        'sessionDelete: a session id is required',
      )
    }
    const running = this.inflight.get(sessionId)
    if (running !== undefined) return running
    const task = this.runDelete(sessionId)
    this.inflight.set(sessionId, task)
    try {
      return await task
    } finally {
      if (this.inflight.get(sessionId) === task) this.inflight.delete(sessionId)
    }
  }

  /**
   * The deletion proper; see {@link delete} for the ordering contract.
   * @param sessionId - durable Session identity.
   * @returns the deletion outcome.
   */
  async runDelete(sessionId) {
    const ctx = this.ctx

    // 1. Resolve the target: a live session, otherwise a stored one.
    const live = ctx.sessions.get(sessionId)
    let header = live?.header
    let stored = false
    if (!header) {
      let snapshot
      try {
        snapshot = await ctx.sessionPersistence.stat(sessionId)
      } catch (error) {
        // A log this build cannot interpret is not a missing log; refuse with
        // its own code so the dialog does not claim the conversation is gone.
        throw new SessionDeleteError(
          'session-delete/unreadable',
          `sessionDelete: session "${sessionId}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
          { sessionId },
        )
      }
      if (!snapshot?.header) {
        throw new SessionDeleteError(
          'session-delete/not-found',
          `sessionDelete: session "${sessionId}" was not found`,
          { sessionId },
        )
      }
      header = snapshot.header
      stored = true
    }

    // 2. Refuse while the conversation still owns running work. The same gate
    //    the shipped archive action uses, so the answer matches the UI's own.
    const activity = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId },
      () => Promise.resolve([]),
    )
    const reported = Array.isArray(activity) ? activity : []
    if (reported.length > 0) {
      throw new SessionDeleteError(
        'session-delete/active',
        `sessionDelete: session "${sessionId}" is still running work; stop it before deleting`,
        {
          sessionId,
          activity: reported.map((entry) => (typeof entry?.kind === 'string' ? entry.kind : 'unknown')),
        },
      )
    }

    // 3. Children survive their parent: name them so the browser can say so.
    const children = await this.listChildren(sessionId)

    // 4. Stop what is left, then let a live session leave the stores so its
    //    writer closes. The writer itself removes its handle on
    //    `session/disposed`; the removal below retries through that delay.
    await ctx.parallel('workspace/session-stop', { sessionId }).catch(() => {})
    if (live) {
      await ctx.sessions.flush(live).catch(() => {})
      this.detach(sessionId)
    }

    // 5. Remove the stored conversation. This is the irreversible step; a
    //    session that never materialized has no artifact, which counts as
    //    success rather than failure.
    const removed = await this.removeStoredLog(header, sessionId)

    // 6. Release the durable workspace accounting. Fail-soft: the log is
    //    already gone, so a stale membership must not fail the deletion.
    await this.releaseWorkspaceAccounting(sessionId)

    // 7. Drop the projection-cache record so no stale hint survives. A live
    //    session's disposal checkpoint may land after this call, so the row is
    //    re-checked before the deletion reports success.
    await this.removeProjectionCache(sessionId)

    // 8. A live session announces its own removal through `session/disposed`;
    //    a stored one has no such event, so announce it here.
    if (!live) ctx.emit('api-session/removed', sessionId)

    return {
      sessionId,
      removed,
      wasLive: live !== undefined,
      stored,
      children,
    }
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
   * Release membership, saved order, pin and archive mark for one session.
   *
   * Every call is fail-soft and in a stable order: membership first, so the
   * row leaves the sidebar even when a later step throws.
   * @param sessionId - durable Session identity.
   */
  async releaseWorkspaceAccounting(sessionId) {
    const ctx = this.ctx
    const registry = optionalService(ctx, 'workspaceRegistry')
    if (!registry) return
    const attempt = async (label, run) => {
      try {
        await run()
      } catch (error) {
        ctx.logger?.warn(`sessionDelete: releasing ${label} for "${sessionId}" failed: ${String(error)}`)
      }
    }
    for (const workspace of registry.list()) {
      if (workspace.record?.sessionIds?.includes(sessionId)) {
        await attempt('workspace membership', () => workspace.detachSession(sessionId))
      }
    }
    await attempt('pin', () => registry.unpinSession(sessionId))
    await attempt('archive mark', () => registry.unarchiveSession(sessionId))
  }

  /**
   * Remove the session's stored log artifact.
   *
   * The store owns the on-disk layout, so its own locator names the artifact.
   * The shipped JSONL backend keeps one directory per session (holding the
   * log, its kernel lock file and any future session-local artifact), so the
   * removal targets that directory; a backend that names a session-owned
   * directory directly, or a single file, is honoured as-is. A writer that is
   * still closing can recreate the artifact, so transient failures are
   * retried with back-off instead of failing the whole deletion.
   * @param header - the stored session header.
   * @param sessionId - durable Session identity, for diagnostics.
   * @returns whether a stored artifact was removed.
   */
  async removeStoredLog(header, sessionId) {
    const persistence = this.ctx.sessionPersistence
    const locate = persistence?.locate
    if (typeof locate !== 'function') {
      throw new SessionDeleteError(
        'session-delete/unsupported-store',
        'sessionDelete: this session store does not expose its on-disk layout',
        { sessionId },
      )
    }
    const location = locate.call(persistence, header)
    if (!location?.path) return false
    const target =
      location.kind === 'dir' ? location.path : location.kind === 'file' ? location.path : dirname(location.path)
    // A session created but never materialized has no artifact; `rm` would
    // report success for a path that never existed, which would overstate the
    // outcome. Nothing on disk is still a successful deletion.
    if (!(await this.pathExists(target))) return false

    let lastFailure
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
      try {
        await this.removeArtifact(target)
        return true
      } catch (error) {
        lastFailure = error
        // `force: true` already ignores ENOENT, so a non-transient failure
        // means retrying cannot help: report it instead of burning the budget.
        if (!isRetryableRemoveFailure(error)) break
        if (attempt < REMOVE_ATTEMPTS - 1) await delay(removeRetryDelay(attempt))
      }
    }
    const reason = lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
    throw new SessionDeleteError(
      'session-delete/io',
      `sessionDelete: removing the log of session "${sessionId}" failed: ${reason}`,
      { sessionId, path: target, attempts: REMOVE_ATTEMPTS },
    )
  }

  /**
   * Remove one artifact path.
   *
   * The single filesystem call the deletion makes, kept as its own method so
   * the retry loop above stays testable without provoking real Windows sharing
   * violations.
   * @param target - absolute artifact path (session directory or file).
   * @returns resolution once the artifact is absent.
   */
  removeArtifact(target) {
    return rm(target, { recursive: true, force: true })
  }

  /**
   * Whether a path still exists.
   *
   * A non-ENOENT failure counts as present: the caller then attempts the
   * removal and reports its real outcome instead of silently skipping it.
   * @param target - absolute artifact path.
   * @returns whether the path exists.
   */
  async pathExists(target) {
    try {
      await stat(target)
      return true
    } catch (error) {
      return error?.code === 'ENOENT' ? false : true
    }
  }

  /**
   * Drop the stored projection-cache record of one session.
   *
   * A live session's disposal checkpoint is written asynchronously right after
   * the detach, so one delete can be followed by the row reappearing. The row
   * is re-checked until it stays gone; a row that survives the whole budget is
   * only logged, because the log is already deleted and every reader
   * re-validates a cached row against the header — a stale hint must not turn
   * a successful deletion into a failure.
   * @param sessionId - durable Session identity.
   */
  async removeProjectionCache(sessionId) {
    const storageDomain = optionalService(this.ctx, 'storageDomain')
    if (!storageDomain || typeof storageDomain.get !== 'function') return
    let table
    try {
      const domain = storageDomain.get('session_projcache')
      if (!domain || typeof domain.table !== 'function') return
      table = domain.table('sessions')
    } catch {
      return
    }
    for (let attempt = 0; attempt < CACHE_ATTEMPTS; attempt++) {
      try {
        if (table.get(sessionId) === undefined) return
        await table.delete(sessionId)
      } catch (error) {
        this.ctx.logger?.warn(
          `sessionDelete: dropping the projection cache of "${sessionId}" failed: ${String(error)}`,
        )
        return
      }
      if (attempt < CACHE_ATTEMPTS - 1) await delay(CACHE_RETRY_MS)
    }
    try {
      if (table.get(sessionId) !== undefined) {
        this.ctx.logger?.warn(
          `sessionDelete: projection cache row for "${sessionId}" survived deletion; it is re-validated on the next read`,
        )
      }
    } catch {
      // A closed domain cannot hold a stale row for the browser either.
    }
  }

  /**
   * Stored sessions whose header names `sessionId` as their parent.
   *
   * Deleting a parent does not delete its forks; naming them lets the browser
   * say so instead of leaving a silently orphaned lineage.
   * @param sessionId - durable Session identity being deleted.
   * @returns child session ids, or an empty list when the store cannot list.
   */
  async listChildren(sessionId) {
    const persistence = this.ctx.sessionPersistence
    if (!persistence || typeof persistence.list !== 'function') return []
    try {
      const snapshots = await persistence.list()
      return snapshots
        .map((snapshot) => snapshot?.header)
        .filter((header) => header && header.id !== sessionId && header.parentSession === sessionId)
        .map((header) => header.id)
    } catch {
      return []
    }
  }
}

// Declare the Remote method for the API Gateway's runtime dispatch. The
// marker format is the Typert protocol's public, versioned descriptor: a
// frozen record on the class prototype naming the exported methods. The
// `resources` reader is called with the method's positional arguments
// (`read(reader, positional)` in the Gateway), so for this one-parameter
// method the reader receives the id string itself.
Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({
        method: 'delete',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({
          session: (sessionId) => (typeof sessionId === 'string' ? sessionId : undefined),
        }),
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
