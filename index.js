/**
 * Host half of the session-delete bundle.
 *
 * Owns one operation: delete a stored conversation. The session's durable
 * log artifact leaves its location — into a recoverable trash by default, or
 * off the disk entirely in permanent mode — its workspace accounting
 * (membership, pin, archive) is released, its projection-cache record is
 * dropped, and the browser is told the row is gone.
 *
 * The browser half calls `sessionDelete/delete` over the shared Remote
 * carrier. The endpoint is reachable through the API Gateway's runtime "SRC"
 * dispatch: the Gateway looks for a live Service that carries a
 * `typertRemote` binding plus Remote method markers, so this bundle needs no
 * generated Typert artifact. The same descriptor also exports `describe`,
 * `restore`, `purge` and `listTrash`, so the browser can offer the reversible
 * flow and undo it without a second plugin.
 *
 * Ordering is transactional on purpose: every step before the artifact
 * removal can still be abandoned without leaving a user-visible
 * inconsistency, so the one irreversible step runs first among the mutating
 * steps and everything after it is fail-soft. A failed deletion therefore
 * leaves the conversation exactly as it was, and retrying is meaningful.
 *
 * The bundle deliberately has no package dependencies: a bundle installed from
 * a local directory resolves its imports from that directory, so every import
 * would have to be a Node built-in.
 */
import { appendFile, cp, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
 * Artifact kinds this build knows how to remove.
 *
 * `dir` and `file` are the store naming its artifact outright. `jsonl` is
 * the shipped JSONL backend: it names the log file inside a per-session
 * directory, and the artifact that may be removed is that directory — it also
 * holds the write-lease lock file. Any other kind is a store this build does
 * not understand, and an unknown kind must never be widened into a
 * directory removal.
 */
const REMOVABLE_KINDS = new Set(['dir', 'file', 'jsonl'])
/** Default number of days a trashed artifact is kept before it is purged. */
const DEFAULT_RETENTION_DAYS = 7
/** Name of the trash directory the plugin creates beside the session store. */
const TRASH_DIR_NAME = '.trash'
/** Name of the audit trail file inside the trash root. */
const AUDIT_FILE_NAME = 'audit.jsonl'
/** Name of the manifest written beside every trashed artifact. */
const MANIFEST_FILE_NAME = 'meta.json'
/** Name of the subdirectory that holds the moved artifact in a trash entry. */
const ARTIFACT_DIR_NAME = 'artifact'
/** Marker for a trash move that may need crash recovery. */
const COPYING_MARKER_FILE_NAME = '.copying'
/** Marker for a restore move that may need crash recovery. */
const RESTORING_MARKER_FILE_NAME = '.restoring'
/** Suffix for an incomplete cross-device copy, never exposed as the artifact. */
const COPY_STAGE_SUFFIX = '.partial'
/** Most child ids one deletion reports; the true count is reported apart. */
const CHILD_LIMIT = 100
/** Most trash entries one sweep examines, so a sweep stays bounded. */
const SWEEP_ENTRY_LIMIT = 500
/** Most trash entries one sweep purges, so a sweep stays bounded. */
const SWEEP_PURGE_LIMIT = 50
/** Most startup recovery operations, so plugin readiness stays bounded. */
const STARTUP_RECOVERY_LIMIT = 50
/** Maximum time an operation waits for another process to release a session lock. */
const PROCESS_LOCK_WAIT_MS = 15000
/** Poll interval while another process owns a session lock. */
const PROCESS_LOCK_POLL_MS = 50
/** Lock owner metadata stored inside each atomically-created lock directory. */
const PROCESS_LOCK_OWNER_FILE = '.owner.json'
/** Most audit records the trail file keeps before it is trimmed. */
const AUDIT_MAX_RECORDS = 1000
/** Minimum gap between two retention sweeps. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
/** Most characters of a session id kept in a trash entry name. */
const TRASH_NAME_LIMIT = 100
/** How many names one trash entry may try before it gives up. */
const TRASH_NAME_ATTEMPTS = 5
/**
 * Manifest marker of an entry whose artifact is back in the session store but
 * whose workspace accounting could not be restored yet.
 *
 * The entry is kept so a later restore call can finish the accounting without
 * moving the artifact a second time; it holds no artifact of its own by then.
 */
const RESTORE_PENDING = 'accounting-pending'

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

/**
 * Whether two absolute paths name the same location.
 *
 * Windows filesystems are case-insensitive, so `C:\Sessions` and
 * `c:\sessions` are one directory; POSIX filesystems are case-sensitive.
 * Comparing case-insensitively on Windows keeps a differently-cased path
 * from slipping past a containment or identity check.
 * @param left - first absolute path.
 * @param right - second absolute path.
 * @returns whether both name the same location.
 */
function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * Whether `target` lies strictly inside `root`.
 *
 * `path.relative` is the containment primitive: it yields a relative path
 * only when the target is a descendant of the root, an empty string when
 * they are the same path, and an absolute path when the target escapes it.
 * The comparison follows the platform's own case rules, so it is
 * case-insensitive on Windows and case-sensitive on POSIX.
 * @param root - the absolute directory that must contain the target.
 * @param target - the absolute path to test.
 * @returns whether the target is a strict descendant of the root.
 */
function isInside(root, target) {
  const rel = relative(root, target)
  if (rel === '' || rel === undefined) return false
  if (isAbsolute(rel)) return false
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return false
  return true
}

/**
 * Resolve a path through every existing filesystem component.
 *
 * `path.resolve()` only normalizes strings; it does not follow a symlink in
 * an ancestor directory. Resolve the nearest existing ancestor and append
 * the missing suffix so delete and restore checks cannot be bypassed by a
 * project-directory symlink.
 * @param rawPath - an absolute or relative path to resolve.
 * @returns the path as it resolves on the filesystem.
 */
async function resolveThroughExistingAncestors(rawPath) {
  let current = resolve(rawPath)
  const suffix = []
  while (true) {
    try {
      const actual = await realpath(current)
      return resolve(actual, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Encode an arbitrary string as one safe path segment.
 *
 * A session id is not validated by the Host, so it may contain separators,
 * `..` or NUL. Escaping it the way the store escapes its own path segments
 * keeps a hostile id from naming a directory outside the trash root.
 * @param raw - the string to encode; must not be empty.
 * @returns one filesystem-safe path segment.
 */
function safeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index]
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${raw.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out === '' ? '~0000' : out
}

/**
 * Order two trash entries, newest first.
 *
 * The deletion time decides, and the entry name breaks a tie, so two entries
 * created in the same millisecond still have a stable order.
 * @param left - the first entry.
 * @param right - the second entry.
 * @returns the comparison result.
 */
function compareTrashEntries(left, right) {
  if (left.deletedAt !== right.deletedAt) return left.deletedAt < right.deletedAt ? 1 : -1
  if (left.trashId === right.trashId) return 0
  return left.trashId < right.trashId ? 1 : -1
}

/**
 * The trash entry name for one session.
 *
 * The timestamp suffix keeps two deletions of the same id from colliding,
 * and the encoded segment keeps an arbitrary id from escaping the trash.
 * @param sessionId - durable Session identity.
 * @param slug - the filesystem-safe timestamp of the entry.
 * @param attempt - the collision counter of the name.
 * @returns one directory name inside the trash root.
 */
function trashEntryName(sessionId, slug, attempt) {
  const segment = safeSegment(sessionId).slice(0, TRASH_NAME_LIMIT)
  return attempt === 0 ? `${segment}-${slug}` : `${segment}-${slug}-${attempt}`
}

/**
 * The identifying part of a session header.
 *
 * Only the fields that identify the artifact are kept: a title or any
 * message content must never reach the disk through this plugin.
 * @param header - the stored session header.
 * @returns the reduced header.
 */
function reducedHeader(header) {
  if (!header || typeof header !== 'object') return {}
  const kept = {}
  if (typeof header.id === 'string') kept.id = header.id
  if (typeof header.cwd === 'string') kept.cwd = header.cwd
  if (typeof header.createdAt === 'number') kept.createdAt = header.createdAt
  if (typeof header.parentSession === 'string') kept.parentSession = header.parentSession
  return kept
}

class SessionDeleteService {
  /**
   * @param ctx - the owning plugin context.
   * @param config - the plugin's configuration.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    /** Deletions in flight, so two clicks cannot interleave their steps. */
    this.inflight = new Map()
    /** Trash mutations in flight, keyed by action and session id. */
    this.trashOps = new Map()
    /** Session locks held by this process are coordinated by the filesystem. */
    this.processLockTokens = new Map()
    /** Whether the artifact is relocated into a trash or removed outright. */
    this.mode = config?.mode === 'permanent' ? 'permanent' : 'trash'
    /** Days a trashed artifact is kept before the sweep purges it. */
    this.retentionDays = this.readRetentionDays(config?.retentionDays)
    /** Explicit trash root; undefined means "beside the session store". */
    this.configuredTrashRoot = typeof config?.trashRoot === 'string' ? config.trashRoot : undefined
    /** Trashed entries by their trash id. */
    this.trashIndex = new Map()
    /** The newest trash entry per session id. */
    this.trashBySession = new Map()
    /** Whether the trash index has been read at least once. */
    this.trashLoaded = false
    /** One in-process disk refresh shared by overlapping callers. */
    this.trashRefreshPromise = undefined
    /** Counts the index changes, so an overlapping refresh can merge. */
    this.trashRevision = 0
    /** When the last retention sweep ran. */
    this.lastSweepAt = 0
    /** The last timestamp handed out, so entry names never repeat. */
    this.lastStampAt = 0
    /** The retention sweep currently running, if any. */
    this.sweepPromise = undefined
    /** How many records the audit trail holds, once it has been counted. */
    this.auditRecords = undefined
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: NAMESPACE,
    })
  }

  /**
   * Stable lock directory shared by plugin instances using the same session store.
   * It lives beside (not inside) the store so the store's project scanner cannot
   * mistake lock metadata for a project directory.
   */
  processLockRoot() {
    const storeRoot = this.storeRoot()
    const anchor = storeRoot ?? (this.configuredTrashRoot !== undefined
      ? resolve(this.configuredTrashRoot)
      : process.cwd())
    const parent = storeRoot !== undefined || this.configuredTrashRoot !== undefined
      ? dirname(anchor)
      : anchor
    return join(parent, '.session-delete-locks')
  }

  /** A filesystem-safe, fixed-length lock name for an arbitrary session id. */
  processLockPath(sessionId) {
    const key = createHash('sha256').update(sessionId).digest('hex')
    return join(this.processLockRoot(), `${key}.lock`)
  }

  /** Whether a PID is still present on this host; uncertain errors fail safe. */
  isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'ESRCH' ? false : true
    }
  }

  /** Read and validate lock metadata without treating malformed state as stale. */
  async readProcessLockOwner(lockPath) {
    try {
      const owner = JSON.parse(await readFile(join(lockPath, PROCESS_LOCK_OWNER_FILE), 'utf8'))
      if (
        owner === null ||
        typeof owner !== 'object' ||
        !Number.isSafeInteger(owner.pid) ||
        typeof owner.host !== 'string' ||
        typeof owner.token !== 'string' ||
        owner.token.length === 0
      ) return undefined
      return owner
    } catch {
      return undefined
    }
  }

  /**
   * Acquire a cross-process session lock using atomic mkdir.
   *
   * Only a lock whose owner is on this host and whose PID is definitely gone
   * may be reclaimed. Unknown, malformed, foreign-host and permission-denied
   * states are never guessed stale. A crash between mkdir and owner metadata
   * intentionally leaves a fail-closed orphan for manual inspection.
   */
  async acquireProcessLock(sessionId) {
    const root = this.processLockRoot()
    const lockPath = this.processLockPath(sessionId)
    await mkdir(root, { recursive: true })
    const startedAt = Date.now()

    const claim = async () => {
      await mkdir(lockPath)
      const owner = { pid: process.pid, host: hostname(), token: randomUUID(), createdAt: Date.now() }
      try {
        await writeFile(join(lockPath, PROCESS_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: 'wx' })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      this.processLockTokens.set(sessionId, owner.token)
      return async () => {
        const current = await this.readProcessLockOwner(lockPath)
        if (current?.token !== owner.token || current.pid !== process.pid || current.host !== owner.host) {
          this.ctx.logger?.warn(`sessionDelete: lock ownership changed for "${sessionId}"; the lock was left untouched`)
          return
        }
        try {
          await rm(lockPath, { recursive: true })
        } catch (error) {
          this.ctx.logger?.warn(`sessionDelete: releasing the lock for "${sessionId}" failed: ${String(error)}`)
        } finally {
          if (this.processLockTokens.get(sessionId) === owner.token) this.processLockTokens.delete(sessionId)
        }
      }
    }

    while (true) {
      try {
        return await claim()
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }

      const owner = await this.readProcessLockOwner(lockPath)
      if (owner !== undefined && owner.host === hostname() && !this.isProcessAlive(owner.pid)) {
        // Rename is the atomic claim on a dead lock. Immediately create our
        // replacement at the canonical path before yielding again; otherwise
        // a second stale-lock observer could rename the replacement and split
        // ownership between two live processes.
        const quarantine = `${lockPath}.stale-${randomUUID()}`
        try {
          await rename(lockPath, quarantine)
          const movedOwner = await this.readProcessLockOwner(quarantine)
          if (movedOwner?.token === owner.token && movedOwner.pid === owner.pid && !this.isProcessAlive(owner.pid)) {
            try {
              const release = await claim()
              await rm(quarantine, { recursive: true, force: true }).catch((error) => {
                this.ctx.logger?.warn(`sessionDelete: removing stale lock quarantine "${quarantine}" failed: ${String(error)}`)
              })
              return release
            } catch (error) {
              // Another contender may have won the canonical path between
              // rename and mkdir. Keep the quarantined directory for review.
              if (error?.code !== 'EEXIST') throw error
            }
          } else {
            this.ctx.logger?.warn(`sessionDelete: stale lock metadata changed for "${sessionId}"; preserved "${quarantine}"`)
          }
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
            this.ctx.logger?.warn(`sessionDelete: reclaiming a dead lock for "${sessionId}" failed: ${String(error)}`)
          }
        }
      }

      if (Date.now() - startedAt >= PROCESS_LOCK_WAIT_MS) {
        throw new SessionDeleteError(
          'session-delete/lock-timeout',
          `sessionDelete: another process holds the operation lock for "${sessionId}", or its ownership cannot be verified; no filesystem changes were made`,
          { sessionId, lockPath, ownerPid: owner?.pid, ownerHost: owner?.host },
        )
      }
      await delay(PROCESS_LOCK_POLL_MS)
    }
  }

  /** Run a session mutation while holding its cross-process filesystem lock. */
  async withProcessLock(sessionId, run) {
    const release = await this.acquireProcessLock(sessionId)
    try {
      return await run()
    } finally {
      await release()
    }
  }

  /**
   * Read the retention window from the configuration.
   *
   * A negative or non-numeric value falls back to the default: an unbounded
   * retention would let the trash grow without limit.
   * @param value - the configured number of days.
   * @returns the retention window in days.
   */
  readRetentionDays(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return DEFAULT_RETENTION_DAYS
    }
    return Math.floor(value)
  }

  /**
   * Delete one conversation.
   *
   * Steps run in an order where only the artifact removal is irreversible,
   * and it runs before the accounting release: a failure there aborts with
   * the row still listed and retryable.
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
    return this.runTrashOperation('delete', sessionId, () => this.runDelete(sessionId))
  }

  /**
   * The deletion proper; see {@link delete} for the ordering contract.
   * @param sessionId - durable Session identity.
   * @returns the deletion outcome.
   */
  async runDelete(sessionId) {
    const ctx = this.ctx

    // 0. A conversation that already sits in the trash is not an error:
    //    deleting it again reports the entry that already holds it, so a
    //    repeated click cannot fail the second time. An entry that only waits
    //    for its accounting is not holding anything: the conversation is back
    //    on the disk, so the deletion below runs as usual. A permanent store
    //    never takes this path: it must not report a trashed artifact as
    //    deleted while leaving it on the disk.
    const trashed = this.mode === 'trash' ? await this.trashEntryFor(sessionId) : undefined
    if (trashed !== undefined && trashed.restoreState === undefined) {
      // The artifact move is the durable commit point. If the process stopped
      // immediately afterwards, a retry must finish the idempotent side effects
      // instead of returning early and leaving stale workspace/cache records.
      await this.releaseWorkspaceAccounting(sessionId)
      await this.removeProjectionCache(sessionId)
      const children = Array.isArray(trashed.children) ? trashed.children : []
      return {
        sessionId,
        removed: true,
        wasLive: false,
        stored: true,
        children,
        childrenCount: typeof trashed.childrenCount === 'number' ? trashed.childrenCount : children.length,
        mode: 'trash',
        trashed: true,
        trashId: trashed.trashId,
        purged: false,
      }
    }

    try {
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
      const { ids: children, count: childrenCount } = await this.listChildren(sessionId)

      // 3b. Capture the workspace accounting this deletion is about to release.
      //     The trash manifest is the only place the restore can learn from, so
      //     the membership, its display anchor, the pin and the archive mark are
      //     read here, before step 6 clears them.
      const accounting = this.mode === 'trash' ? this.captureAccounting(sessionId) : undefined

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
      const removal = await this.removeStoredLog(
        header,
        sessionId,
        children,
        childrenCount,
        accounting,
      )

      // 6. Release the durable workspace accounting. Fail-soft: the artifact
      //    is already gone, so a stale membership must not fail the deletion.
      await this.releaseWorkspaceAccounting(sessionId)

      // 7. Drop the projection-cache record so no stale hint survives. A live
      //    session's disposal checkpoint may land after this call, so the row
      //    is re-checked before the deletion reports success.
      await this.removeProjectionCache(sessionId)

      // 8. A live session announces its own removal through `session/disposed`;
      //    a stored one has no such event, so announce it here.
      if (!live) ctx.emit('api-session/removed', sessionId)

      await this.audit('delete', sessionId, true, { children: childrenCount, mode: this.mode })

      return {
        sessionId,
        removed: removal.removed,
        wasLive: live !== undefined,
        stored,
        children,
        childrenCount,
        mode: this.mode,
        trashed: removal.trashed,
        ...(removal.trashId === undefined ? {} : { trashId: removal.trashId }),
        purged: removal.purged,
      }
    } catch (error) {
      // A failed attempt is part of the trail: the operator must be able to
      // see that a deletion was refused and why.
      await this.audit('delete', sessionId, false, {
        code: typeof error?.code === 'string' ? error.code : 'session-delete/io',
        mode: this.mode,
      })
      throw error
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
    if (!registry) return true
    let complete = true
    const attempt = async (label, run) => {
      try {
        await run()
      } catch (error) {
        complete = false
        ctx.logger?.warn(`sessionDelete: releasing ${label} for "${sessionId}" failed: ${String(error)}`)
      }
    }
    try {
      for (const workspace of registry.list()) {
        if (workspace.record?.sessionIds?.includes(sessionId)) {
          await attempt('workspace membership', () => workspace.detachSession(sessionId))
        }
      }
    } catch (error) {
      complete = false
      ctx.logger?.warn(`sessionDelete: listing workspace membership for "${sessionId}" failed: ${String(error)}`)
    }
    await attempt('pin', () => registry.unpinSession(sessionId))
    await attempt('archive mark', () => registry.unarchiveSession(sessionId))
    return complete
  }

  /**
   * Capture the workspace accounting a deletion is about to release.
   *
   * The restore is only useful when it can put the conversation back where the
   * sidebar expects it, and the host's own accounting is the only truth about
   * that: which workspace owned it, where in the ordered account it sat, and
   * whether it was pinned or archived. All of it is read before the deletion
   * releases it and written into the trash manifest, so a restore inside a
   * running app can rebuild it. History bootstrap only re-adopts unaccounted
   * sessions at startup, which is why a restore without this record leaves the
   * conversation invisible until the next launch.
   *
   * The values are read from the registry synchronously and every read is
   * fail-soft: losing one of them degrades the restore, never the deletion.
   * @param sessionId - durable Session identity.
   * @returns the recorded accounting, presence marks included.
   */
  captureAccounting(sessionId) {
    const registry = optionalService(this.ctx, 'workspaceRegistry')
    // The empty record is not a missing one: its presence tells a future
    // restore that the accounting was captured, so nothing is inferred.
    const accounting = { member: false, pinned: false, archived: false }
    if (!registry) return accounting
    try {
      for (const workspace of registry.list()) {
        const ids = workspace?.record?.sessionIds
        if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
        accounting.member = true
        if (typeof workspace.id === 'string') accounting.workspaceId = workspace.id
        // `attachSession` prepends, so the session that sat right after the
        // deleted one is the anchor that puts it back in its old slot.
        const next = ids[ids.indexOf(sessionId) + 1]
        if (typeof next === 'string') accounting.beforeSessionId = next
        // A session is accounted by at most one workspace (a registry
        // invariant), so the first match is the only match.
        break
      }
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: capturing workspace membership of "${sessionId}" failed: ${String(error)}`)
    }
    try {
      const pinned = registry.pinnedSessionIds
      if (Array.isArray(pinned) && pinned.includes(sessionId)) accounting.pinned = true
    } catch {
      // A registry that cannot report the pin set restores a session unpinned.
    }
    try {
      const archived = registry.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId)) accounting.archived = true
    } catch {
      // A registry that cannot report the archive set restores a session
      // unarchived rather than failing the deletion.
    }
    return accounting
  }

  /**
   * Put a restored conversation back into the workspace accounting.
   *
   * Runs after the artifact is back in the store, because the host validates
   * `attachSession` against the stored header (its `cwd` must resolve to the
   * workspace path). The recorded order anchor is applied best-effort: the
   * conversation is already accounted even when the anchor has since been
   * deleted, and a missing anchor only costs its exact slot.
   *
   * A legacy manifest written before 0.4.0 carries no accounting record; for
   * those the header's `cwd` is used to find the owning workspace, which is
   * the same rule the startup bootstrap uses.
   * @param manifest - the trash entry's manifest.
   * @param sessionId - durable Session identity.
   * @returns the reattachment result, or undefined when there is nothing to attempt.
   */
  async reattachAccounting(manifest, sessionId) {
    const registry = optionalService(this.ctx, 'workspaceRegistry')
    if (!registry) return undefined
    const accounting = manifest?.accounting
    const recorded = accounting !== undefined && accounting !== null && typeof accounting === 'object'
    if (recorded) {
      const member = accounting.member === true
      const pinned = accounting.pinned === true
      const archived = accounting.archived === true
      if (!member && !pinned && !archived) return undefined
      const result = { reattached: true, reordered: false, failures: [] }
      if (member) {
        const workspaceId = typeof accounting.workspaceId === 'string' ? accounting.workspaceId : undefined
        const workspace = workspaceId === undefined ? undefined : registry.get?.(workspaceId)
        if (workspace === undefined) {
          // The conversation stays on the disk with no sidebar row: history
          // bootstrap can re-adopt it from its cwd on the next launch.
          result.failures.push('workspace-missing')
        } else {
          try {
            await workspace.attachSession(sessionId)
            result.reordered = await this.reorderRestoredSession(
              workspace,
              sessionId,
              typeof accounting.beforeSessionId === 'string' ? accounting.beforeSessionId : undefined,
            )
          } catch (error) {
            this.ctx.logger?.warn(
              `sessionDelete: reattaching session "${sessionId}" to its workspace failed: ${String(error)}`,
            )
            result.failures.push('workspace')
          }
        }
      }
      // Pinning and archival are mutually exclusive in the host registry, and
      // an archive write drops a pin. Replaying the recorded archive mark is
      // therefore enough; a pin is only replayed when it was not archived.
      if (archived) {
        try {
          await registry.archiveSession?.(sessionId)
        } catch (error) {
          this.ctx.logger?.warn(`sessionDelete: re-archiving session "${sessionId}" failed: ${String(error)}`)
          result.failures.push('archive')
        }
      } else if (pinned) {
        try {
          await registry.pinSession?.(sessionId)
        } catch (error) {
          this.ctx.logger?.warn(`sessionDelete: re-pinning session "${sessionId}" failed: ${String(error)}`)
          result.failures.push('pin')
        }
      }
      result.reattached = result.failures.length === 0
      return result
    }
    // Legacy entry: infer the owning workspace from the stored cwd the same
    // way the startup bootstrap does. Nothing is claimed when this host
    // exposes no resolver or the cwd matches no registered workspace.
    const cwd = typeof manifest?.header?.cwd === 'string' ? manifest.header.cwd : undefined
    if (cwd === undefined || typeof registry.resolveByPath !== 'function') return undefined
    const result = { reattached: true, reordered: false, failures: [], inferred: true }
    let workspace
    try {
      workspace = await registry.resolveByPath(cwd)
    } catch (error) {
      // The cwd directory itself is unreadable: nothing can be attached, and
      // only the restart bootstrap can decide later.
      this.ctx.logger?.warn(`sessionDelete: resolving the workspace of "${sessionId}" failed: ${String(error)}`)
      result.failures.push('workspace-unresolved')
      result.reattached = false
      return result
    }
    if (workspace === undefined || typeof workspace.attachSession !== 'function') {
      result.failures.push('workspace-missing')
      result.reattached = false
      return result
    }
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: reattaching session "${sessionId}" by its cwd failed: ${String(error)}`)
      result.failures.push('workspace')
      result.reattached = false
    }
    return result
  }

  /**
   * Move a restored conversation back to its recorded display slot.
   *
   * `attachSession` prepends, and the host has no "insert after" operation, so
   * the anchor recorded at delete time (the session that was after the deleted
   * one) is used when it is still accounted. A missing anchor keeps the
   * conversation accounted at the front, which is a visible position; the
   * reorder is therefore a best-effort improvement, never a failure.
   * @param workspace - the workspace entity that now accounts the session.
   * @param sessionId - durable Session identity.
   * @param anchorId - the recorded session that sat after the deleted one.
   * @returns whether the recorded slot could be applied.
   */
  async reorderRestoredSession(workspace, sessionId, anchorId) {
    if (anchorId === undefined || typeof workspace.insertSessionBefore !== 'function') return false
    const ids = workspace.record?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(anchorId)) return false
    try {
      await workspace.insertSessionBefore(sessionId, anchorId)
      return true
    } catch (error) {
      // The anchor may have been detached between the check and the write; the
      // conversation is still accounted, so this is only a lost position.
      this.ctx.logger?.warn(
        `sessionDelete: restoring the display slot of "${sessionId}" failed: ${String(error)}`,
      )
      return false
    }
  }

  /**
   * Announce a restored conversation to the browser.
   *
   * Deletion emits `api-session/removed`; the inverse is `api-session/added`,
   * which the shipped session list relays into the sidebar catalog. The Host's
   * own list state builds a truthful summary from the stored header, so no
   * title or message content is invented here. A host that cannot answer is
   * only logged: the files are already back, and a failed announcement must
   * never turn the restore into a failure.
   * @param manifest - the trash entry's manifest, carrying the stored header.
   * @returns whether the addition was announced.
   */
  announceRestored(manifest) {
    const controller = optionalService(this.ctx, 'sessionController')
    const listState = controller?.listState
    const header = manifest?.header
    if (!listState || typeof header?.id !== 'string') return false
    let summary
    try {
      const live = optionalService(this.ctx, 'sessions')?.get?.(header.id)
      if (live !== undefined && typeof listState.summaryFor === 'function') summary = listState.summaryFor(live)
    } catch {
      // Fall through to the stored-header summary.
    }
    if (summary === undefined && typeof listState.summarizeCold === 'function') {
      try {
        summary = listState.summarizeCold({ header })
      } catch (error) {
        this.ctx.logger?.warn(`sessionDelete: summarizing the restored session "${header.id}" failed: ${String(error)}`)
      }
    }
    if (summary === undefined) return false
    try {
      this.ctx.emit('api-session/added', summary)
      return true
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: announcing the restored session "${header.id}" failed: ${String(error)}`)
      return false
    }
  }

  /**
   * The artifact one stored session owns, and the tree it must live in.
   *
   * The store owns the on-disk layout, so its own locator names the artifact.
   * The shipped JSONL backend names the log file inside a per-session
   * directory and reports `kind: 'jsonl'`; the artifact that may be removed
   * is that session directory, because it also holds the write-lease lock
   * file. A backend that names a directory or a file outright is honoured as
   * it is.
   *
   * Three rules keep this safe:
   *
   *  - only the kinds this build understands may be removed; an unknown kind
   *    is a store this build does not understand, and it must never be
   *    widened into a directory removal;
   *  - the resolved target must lie strictly inside the store's own root, so
   *    a locator naming an unrelated tree is refused instead of erased;
   *  - widening a log file into its session directory additionally requires
   *    that directory to sit exactly one level below a project directory of
   *    the store root, which is the layout the store itself documents.
   *
   * The root comes from the store (`sessionPersistence.root`), never from the
   * located path: a root derived from the located path would define both
   * sides of the containment check and make it vacuous.
   * @param header - the stored session header.
   * @param sessionId - durable Session identity, for diagnostics.
   * @returns the removal target, or undefined when the store names no artifact.
   */
  async resolveArtifact(header, sessionId) {
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
    const raw = location?.path
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the session store named an unusable artifact path for "${sessionId}"`,
        { sessionId, reason: 'invalid-path' },
      )
    }
    const kind = typeof location?.kind === 'string' ? location.kind : ''
    if (!REMOVABLE_KINDS.has(kind)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the session store named an unknown artifact kind "${kind}" for "${sessionId}"; nothing was removed`,
        { sessionId, kind, reason: 'unknown-kind' },
      )
    }
    // `resolve` collapses a trailing separator, a relative path and every
    // `..` segment, so the comparison below always sees one canonical form.
    const resolved = resolve(raw)
    const root = this.storeRoot()
    const target = kind === 'jsonl' ? dirname(resolved) : resolved
    if (root === undefined) {
      // Without the store's own root the plugin cannot prove the target sits
      // inside the session tree. A path the store named outright is still
      // safe to remove, but a log file may not be widened into its directory.
      if (kind === 'jsonl') {
        throw new SessionDeleteError(
          'session-delete/unsafe-path',
          `sessionDelete: this session store does not expose its storage root, so the artifact of "${sessionId}" cannot be verified; nothing was removed`,
          { sessionId, kind, reason: 'no-store-root' },
        )
      }
      return { target, root: undefined, kind }
    }
    if (!isInside(root, target)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" lies outside the session store; nothing was removed`,
        { sessionId, kind, path: target, root, reason: 'outside-store' },
      )
    }
    if (kind === 'jsonl' && !samePath(dirname(dirname(target)), root)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" is not a session directory of the session store; nothing was removed`,
        { sessionId, kind, path: target, root, reason: 'unexpected-layout' },
      )
    }
    if (kind === 'dir' && samePath(dirname(target), root)) {
      // A direct child of the store root is a project directory holding many
      // conversations, never one conversation's own directory.
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" is not a session directory of the session store; nothing was removed`,
        { sessionId, kind, path: target, root, reason: 'unexpected-layout' },
      )
    }
    // Lexical containment is necessary but not sufficient: a path component
    // below the store root may be a symlink to a directory outside the store.
    // Resolve existing components before any destructive operation.
    let canonicalRoot
    let canonicalTarget
    try {
      canonicalRoot = await realpath(root)
      canonicalTarget = await resolveThroughExistingAncestors(target)
    } catch (error) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" could not be verified against the session store; nothing was removed`,
        { sessionId, kind, path: target, root, reason: 'unverifiable-path', causeCode: error?.code },
      )
    }
    if (!isInside(canonicalRoot, canonicalTarget)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" resolves outside the session store; nothing was removed`,
        { sessionId, kind, path: canonicalTarget, root: canonicalRoot, reason: 'symlink-escape' },
      )
    }
    if (kind === 'jsonl' && !samePath(dirname(dirname(canonicalTarget)), canonicalRoot)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" resolves to an unexpected session layout; nothing was removed`,
        { sessionId, kind, path: canonicalTarget, root: canonicalRoot, reason: 'unexpected-layout' },
      )
    }
    if (kind === 'dir' && samePath(dirname(canonicalTarget), canonicalRoot)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the artifact of "${sessionId}" resolves to a project directory, not a session; nothing was removed`,
        { sessionId, kind, path: canonicalTarget, root: canonicalRoot, reason: 'unexpected-layout' },
      )
    }
    // Keep the normalized locator path for the filesystem operation. In
    // particular, rm() removes a final symlink itself instead of following
    // it; the canonical path above is only the security-check target.
    return { target, root: canonicalRoot, kind }
  }

  /**
   * The session store's own root directory, when it exposes one.
   *
   * The shipped JSONL backend publishes its configured root, which is the
   * only trustworthy anchor for the containment check.
   * @returns the absolute store root, or undefined when the store exposes none.
   */
  storeRoot() {
    const persistence = this.ctx.sessionPersistence
    let exposed
    try {
      exposed = persistence?.root
    } catch {
      return undefined
    }
    if (typeof exposed !== 'string' || exposed.length === 0) return undefined
    try {
      return resolve(exposed)
    } catch {
      return undefined
    }
  }

  /**
   * The directory that holds trashed artifacts and the audit trail.
   *
   * The trash lives beside the session store, never inside it: the store
   * lists every directory under its root as a candidate project, so a trash
   * inside the tree would be read back as live conversations. The default is
   * therefore `<parent of the store root>/.trash`, and an explicit
   * `trashRoot` configuration overrides it.
   * @returns the absolute trash root, or undefined when it cannot be derived.
   */
  trashRoot() {
    if (this.configuredTrashRoot !== undefined) return resolve(this.configuredTrashRoot)
    const root = this.storeRoot()
    if (root === undefined) return undefined
    return join(dirname(root), TRASH_DIR_NAME)
  }

  /**
   * Remove one session's stored artifact.
   *
   * The removal is the one irreversible step of a deletion. In trash mode the
   * artifact is relocated instead of erased, so the outcome reports both what
   * happened and where the artifact went.
   * @param header - the stored session header.
   * @param sessionId - durable Session identity, for diagnostics.
   * @param children - the capped child ids to record in the manifest.
   * @param childrenCount - the true child count to record in the manifest.
   * @param accounting - the workspace accounting captured before the release.
   * @returns what happened to the artifact.
   */
  async removeStoredLog(header, sessionId, children = [], childrenCount = children.length, accounting) {
    const artifact = await this.resolveArtifact(header, sessionId)
    if (artifact === undefined) {
      return { removed: false, trashed: false, purged: false }
    }
    // A session created but never materialized has no artifact; `rm` would
    // report success for a path that never existed, which would overstate the
    // outcome. Nothing on disk is still a successful deletion.
    if (!(await this.pathExists(artifact.target))) {
      return { removed: false, trashed: false, purged: false }
    }
    if (this.mode === 'trash') {
      const entry = await this.moveToTrash(artifact, sessionId, header, children, childrenCount, accounting)
      return { removed: true, trashed: true, trashId: entry.trashId, purged: false }
    }
    await this.removeWithRetries(artifact.target, sessionId)
    return { removed: true, trashed: false, purged: true }
  }

  /**
   * Remove one artifact path, retrying only transient failures.
   *
   * A writer that is still closing can recreate the artifact, so transient
   * failures are retried with back-off instead of failing the deletion.
   * @param target - absolute artifact path (session directory or file).
   * @param sessionId - durable Session identity, for diagnostics.
   */
  async removeWithRetries(target, sessionId) {
    let lastFailure
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
      try {
        await this.removeArtifact(target)
        return
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
   * Compare two artifact trees without following symlinks.
   *
   * This is used only to resolve a restore interrupted after a cross-device
   * copy was promoted but before its trash-side source was removed. Unknown
   * special files fail closed, preserving both copies.
   * @param left - the trash-side artifact.
   * @param right - the restored artifact.
   * @returns whether both trees have identical names, types and contents.
   */
  async artifactsMatch(left, right) {
    const leftStat = await lstat(left).catch(() => undefined)
    const rightStat = await lstat(right).catch(() => undefined)
    if (!leftStat || !rightStat || leftStat.isDirectory() !== rightStat.isDirectory()) return false
    if (leftStat.isDirectory()) {
      const [leftNames, rightNames] = await Promise.all([readdir(left), readdir(right)])
      if (leftNames.length !== rightNames.length) return false
      leftNames.sort()
      rightNames.sort()
      for (let index = 0; index < leftNames.length; index++) {
        if (leftNames[index] !== rightNames[index]) return false
        if (!(await this.artifactsMatch(join(left, leftNames[index]), join(right, rightNames[index])))) return false
      }
      return true
    }
    if (leftStat.isFile()) {
      const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)])
      return leftBytes.equals(rightBytes)
    }
    try {
      const [leftLink, rightLink] = await Promise.all([readlink(left), readlink(right)])
      return leftLink === rightLink
    } catch {
      return false
    }
  }

  /**
   * Move one artifact into the trash and describe it.
   *
   * The manifest is written before the artifact moves, so a failure leaves the
   * original exactly as it was: the trash entry is removed again and the
   * deletion fails with `session-delete/io`. After the move the original
   * path is verified to be gone; a source that survived the move is removed
   * with the ordinary retry policy.
   * @param artifact - the resolved removal target.
   * @param sessionId - durable Session identity.
   * @param header - the stored session header.
   * @param children - the capped child ids to record.
   * @param childrenCount - the true child count to record.
   * @param accounting - the captured workspace accounting, when there is any.
   * @returns the trash entry that now holds the artifact.
   */
  async moveToTrash(artifact, sessionId, header, children, childrenCount, accounting) {
    const root = this.trashRoot()
    if (root === undefined) {
      throw new SessionDeleteError(
        'session-delete/trash-unavailable',
        `sessionDelete: no trash directory could be derived for the session store; nothing was removed`,
        { sessionId, reason: 'no-trash-root' },
      )
    }
    try {
      await mkdir(root, { recursive: true })
    } catch (error) {
      throw new SessionDeleteError(
        'session-delete/trash-unavailable',
        `sessionDelete: the trash directory "${root}" could not be created; nothing was removed`,
        { sessionId, path: root, reason: error instanceof Error ? error.message : String(error) },
      )
    }
    // A pending-accounting entry from an earlier, half-finished restore holds
    // no artifact. A fresh deletion of the same id supersedes it, so it is
    // dropped instead of leaving a second, stale entry behind.
    const pending = this.trashBySession.get(sessionId)
    if (pending !== undefined && pending.restoreState !== undefined) {
      this.forgetTrashEntry(pending.trashId)
      await this.discardTrashEntry(pending.path)
    }
    const stamp = this.nextStamp()
    const entry = await this.createTrashEntry(root, sessionId, stamp)
    const { trashId, path: entryPath } = entry
    const manifest = {
      sessionId,
      originalPath: artifact.target,
      deletedAt: stamp.iso,
      header: reducedHeader(header),
      children,
      childrenCount,
      mode: this.mode,
      // Presence marks "captured": a manifest without this field predates
      // 0.4.0 and is restored with a best-effort workspace inference instead.
      ...(accounting === undefined ? {} : { accounting }),
    }
    try {
      await writeFile(join(entryPath, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (error) {
      await this.discardTrashEntry(entryPath)
      throw new SessionDeleteError(
        'session-delete/io',
        `sessionDelete: preparing the trash entry for session "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId, path: entryPath },
      )
    }
    const markerPath = join(entryPath, COPYING_MARKER_FILE_NAME)
    try {
      const sourceStat = await stat(artifact.target)
      await writeFile(
        markerPath,
        JSON.stringify({
          dev: sourceStat.dev,
          ino: sourceStat.ino,
          isDirectory: sourceStat.isDirectory(),
          size: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs,
        }),
        { encoding: 'utf8', flag: 'wx' },
      )
      const tombstone = join(dirname(artifact.target), `.session-delete-${trashId}.moving`)
      await this.moveArtifact(artifact.target, join(entryPath, ARTIFACT_DIR_NAME), {
        afterPromote: async (source) => {
          // Rename on the source volume is atomic. If removal is interrupted,
          // recovery can safely finish deleting this private tombstone.
          await rename(source, tombstone)
          await this.removeWithRetries(tombstone, sessionId)
        },
      })
      await this.recoverTrashMove(entryPath, manifest)
    } catch (error) {
      const copiedArtifact = await this.pathExists(join(entryPath, ARTIFACT_DIR_NAME))
      if (copiedArtifact) {
        // The destination was atomically promoted before a later step failed.
        // Keep the marker and both paths so the next refresh can finish safely.
        this.ctx.logger?.warn(
          `sessionDelete: the trash move of "${sessionId}" needs recovery; its source and destination were preserved`,
        )
      } else {
        // No complete artifact was promoted, so the original is still the
        // only authoritative copy. Removing the entry also drops any partial.
        await this.discardTrashEntry(entryPath)
      }
      throw new SessionDeleteError(
        'session-delete/io',
        `sessionDelete: moving the log of session "${sessionId}" into the trash failed: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId, path: artifact.target, trashId },
      )
    }
    // The move must have emptied the original location; a source that is
    // still there means the artifact exists twice and the deletion has not
    // happened yet.
    if (await this.pathExists(artifact.target)) {
      try {
        await this.removeWithRetries(artifact.target, sessionId)
      } catch (error) {
        this.ctx.logger?.warn(
          `sessionDelete: the artifact of session "${sessionId}" is still at "${artifact.target}" after the move; a copy also sits in the trash`,
        )
        throw error
      }
    }
    this.rememberTrashEntry({
      trashId,
      sessionId,
      deletedAt: manifest.deletedAt,
      originalPath: artifact.target,
      path: entryPath,
      children,
      childrenCount,
      header: manifest.header,
      accounting: manifest.accounting,
    })
    return { trashId, path: entryPath }
  }

  /**
   * Create the directory that will hold one trashed artifact.
   *
   * The name carries the session id and a timestamp, so two deletions of the
   * same id cannot collide; should a name still be taken, the next one is
   * used instead of overwriting the entry that is already there.
   * @param root - the trash root.
   * @param sessionId - durable Session identity.
   * @param stamp - the entry's timestamp.
   * @returns the trash id and the entry's path.
   */
  async createTrashEntry(root, sessionId, stamp) {
    for (let attempt = 0; attempt < TRASH_NAME_ATTEMPTS; attempt++) {
      const trashId = trashEntryName(sessionId, stamp.slug, attempt)
      const entryPath = join(root, trashId)
      try {
        // Without `recursive` an existing name is a collision, not a success.
        await mkdir(entryPath)
        return { trashId, path: entryPath }
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === TRASH_NAME_ATTEMPTS - 1) throw error
      }
    }
    throw new SessionDeleteError(
      'session-delete/io',
      `sessionDelete: no free trash entry name was left for session "${sessionId}"`,
      { sessionId },
    )
  }

  /**
   * A strictly increasing timestamp for one trash entry.
   *
   * Two deletions in the same millisecond would otherwise share a name and
   * a listing order, so the clock is nudged forward until it advances.
   * @returns the ISO timestamp and its filesystem-safe form.
   */
  nextStamp() {
    const now = Date.now()
    const next = now > this.lastStampAt ? now : this.lastStampAt + 1
    this.lastStampAt = next
    const iso = new Date(next).toISOString()
    return { iso, slug: iso.replace(/[:.]/g, '-') }
  }

  /**
   * Move one artifact to another path, crossing devices if it must.
   *
   * A rename is atomic within one volume. Across volumes it is impossible,
   * so the artifact is copied first and the source dropped afterwards: a
   * failed copy therefore leaves the original exactly as it was.
   * @param source - the absolute path to move.
   * @param destination - the absolute path to move it to.
   */
  async moveArtifact(source, destination, options = {}) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    // Never copy directly to the visible destination. A crash during cp would
    // otherwise leave a partial artifact that looks like a completed move.
    const staging = `${destination}${COPY_STAGE_SUFFIX}`
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true })
    // Promotion is atomic because staging and destination share the trash
    // volume. Recovery can distinguish a partial stage from a complete copy.
    await rename(staging, destination)
    if (typeof options.afterPromote === 'function') {
      await options.afterPromote(source)
    } else {
      await rm(source, { recursive: true, force: true })
    }
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
    if (!storageDomain || typeof storageDomain.get !== 'function') return true
    let table
    try {
      const domain = storageDomain.get('session_projcache')
      if (!domain || typeof domain.table !== 'function') return true
      table = domain.table('sessions')
    } catch (error) {
      this.ctx.logger?.warn(
        `sessionDelete: opening the projection cache for "${sessionId}" failed: ${String(error)}`,
      )
      return false
    }
    for (let attempt = 0; attempt < CACHE_ATTEMPTS; attempt++) {
      try {
        if (table.get(sessionId) === undefined) return true
        await table.delete(sessionId)
      } catch (error) {
        this.ctx.logger?.warn(
          `sessionDelete: dropping the projection cache of "${sessionId}" failed: ${String(error)}`,
        )
        return false
      }
      if (attempt < CACHE_ATTEMPTS - 1) await delay(CACHE_RETRY_MS)
    }
    try {
      if (table.get(sessionId) !== undefined) {
        this.ctx.logger?.warn(
          `sessionDelete: projection cache row for "${sessionId}" survived deletion; it is re-validated on the next read`,
        )
        return false
      }
    } catch {
      // A closed domain cannot hold a stale row for the browser either.
    }
    return true
  }

  /**
   * Stored sessions whose header names `sessionId` as their parent.
   *
   * Deleting a parent does not delete its forks; naming them lets the browser
   * say so instead of leaving a silently orphaned lineage. The list is capped
   * so one deletion cannot drag an unbounded number of ids across the wire;
   * the true count is reported next to the capped list.
   * @param sessionId - durable Session identity being deleted.
   * @returns the capped child ids and their true count.
   */
  async listChildren(sessionId) {
    const persistence = this.ctx.sessionPersistence
    if (!persistence || typeof persistence.list !== 'function') return { ids: [], count: 0 }
    try {
      const snapshots = await persistence.list()
      const ids = snapshots
        .map((snapshot) => snapshot?.header)
        .filter((header) => header && header.id !== sessionId && header.parentSession === sessionId)
        .map((header) => header.id)
      return { ids: ids.slice(0, CHILD_LIMIT), count: ids.length }
    } catch {
      return { ids: [], count: 0 }
    }
  }

  /**
   * The facts the browser needs before it offers the action.
   *
   * The method reads the store's own root and the trash directory, so the
   * count it reports is the count on the disk rather than a cached guess.
   * @returns the capability description.
   */
  async describe() {
    const persistence = this.ctx.sessionPersistence
    const canLocate = typeof persistence?.locate === 'function'
    const trashRoot = this.trashRoot()
    // Without a store that can name its artifacts the plugin can offer no
    // action here at all, not even the reversible ones.
    const hasTrash = this.mode === 'trash' && trashRoot !== undefined && canLocate
    let trashCount = 0
    if (hasTrash) {
      // The index is refreshed rather than trusted: the browser asks what is
      // in the trash, and only the disk knows for sure.
      trashCount = (await this.refreshTrash()).length
    }
    return {
      // The store can name its artifacts, and the trash the mode needs is
      // derivable: otherwise a deletion could not be performed here at all.
      supported: canLocate && (this.mode === 'permanent' || hasTrash),
      mode: this.mode,
      // A store without a trash keeps nothing, so it has no retention window
      // to report; the browser must not offer the user a promise it cannot keep.
      retentionDays: hasTrash ? this.retentionDays : 0,
      canRestore: hasTrash,
      canListTrash: hasTrash,
      trashCount,
      canLocate,
    }
  }

  /**
   * Put one trashed conversation back where it came from.
   *
   * The manifest names the original path, so that path is checked against the
   * store's root before anything is written: a tampered manifest must not be
   * able to place an artifact outside the session tree.
   * @param sessionId - durable Session identity.
   * @returns the restore outcome.
   */
  async restore(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionDeleteError(
        'session-delete/invalid-request',
        'sessionDelete: a session id is required',
      )
    }
    return this.runTrashOperation('restore', sessionId, () => this.runRestore(sessionId))
  }

  /**
   * Remove one trashed conversation for good.
   * @param sessionId - durable Session identity.
   * @returns the purge outcome.
   */
  async purge(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionDeleteError(
        'session-delete/invalid-request',
        'sessionDelete: a session id is required',
      )
    }
    return this.runTrashOperation('purge', sessionId, () => this.runPurge(sessionId))
  }

  /**
   * Run one trash mutation, joining a concurrent run of the same action.
   *
   * Two clicks on "Restore" must not move the same artifact twice, so the
   * second one joins the first.
   * @param action - the trash action, used as part of the key.
   * @param sessionId - durable Session identity.
   * @param run - the mutation to run once.
   * @returns the mutation's outcome.
   */
  async runTrashOperation(action, sessionId, run) {
    // One session has one filesystem artifact. Delete, restore and purge must
    // therefore share a lock: action-specific locks let a restore race a
    // retention purge and let a delete race a restore.
    const running = this.trashOps.get(sessionId)
    if (running !== undefined) {
      if (running.action === action) return running.promise
      // Different operations are serialized, not coalesced: after the current
      // mutation settles, re-evaluate the next operation against fresh state.
      return running.promise.catch(() => {}).then(() => this.runTrashOperation(action, sessionId, run))
    }
    const task = Promise.resolve().then(() => this.withProcessLock(sessionId, async () => {
      // Each process has its own index. Refresh from disk after acquiring the
      // shared lock so decisions cannot rely on another process's stale view.
      const entries = await this.refreshTrash({ recoverMoves: false, force: true })
      const interruptedMove = entries.find((entry) => entry.sessionId === sessionId)
      if (interruptedMove !== undefined && await this.pathExists(join(interruptedMove.path, COPYING_MARKER_FILE_NAME))) {
        const manifest = await this.readManifest(interruptedMove.path)
        if (manifest === undefined || !(await this.recoverTrashMove(interruptedMove.path, manifest))) {
          throw new SessionDeleteError(
            'session-delete/recovery-pending',
            `sessionDelete: the interrupted trash move for "${sessionId}" could not be verified; both paths were preserved and no further operation was attempted`,
            { sessionId, trashId: interruptedMove.trashId },
          )
        }
        await this.refreshTrash({ recoverMoves: false, force: true })
      }
      return run()
    }))
    const operation = { action, promise: task }
    this.trashOps.set(sessionId, operation)
    try {
      return await task
    } finally {
      if (this.trashOps.get(sessionId) === operation) this.trashOps.delete(sessionId)
    }
  }

  /**
   * The restore proper; see {@link restore} for the contract.
   *
   * The artifact comes back first: the host validates a reattachment against
   * the stored header, so the file has to be in its place before the workspace
   * can account for it again. The accounting is replayed from the manifest and
   * is best-effort: a reattachment failure leaves the files restored and the
   * entry in a pending state, so a repeated restore can finish the accounting
   * without copying anything twice. A restore interrupted after the move is
   * recognised the same way, which keeps the operation retryable.
   * @param sessionId - durable Session identity.
   * @returns the restore outcome.
   */
  async runRestore(sessionId) {
    const entry = await this.trashEntryFor(sessionId)
    if (entry === undefined) {
      throw new SessionDeleteError(
        'session-delete/not-found',
        `sessionDelete: session "${sessionId}" is not in the trash`,
        { sessionId },
      )
    }
    const target = entry.originalPath
    const root = this.storeRoot()
    if (typeof target !== 'string' || target.length === 0) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the trash entry of session "${sessionId}" names no path; nothing was restored`,
        { sessionId, reason: 'invalid-path' },
      )
    }
    if (root !== undefined && !isInside(root, target)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the trash entry of session "${sessionId}" names a path outside the session store; nothing was restored`,
        { sessionId, path: target, root, reason: 'outside-store' },
      )
    }
    if (root !== undefined && samePath(dirname(target), root)) {
      throw new SessionDeleteError(
        'session-delete/unsafe-path',
        `sessionDelete: the trash entry of session "${sessionId}" names a path that is not a session directory; nothing was restored`,
        { sessionId, path: target, root, reason: 'unexpected-layout' },
      )
    }
    if (root !== undefined) {
      try {
        const canonicalRoot = await realpath(root)
        const canonicalTarget = await resolveThroughExistingAncestors(target)
        if (!isInside(canonicalRoot, canonicalTarget)) {
          throw new SessionDeleteError(
            'session-delete/unsafe-path',
            `sessionDelete: the original location of session "${sessionId}" resolves outside the session store; nothing was restored`,
            { sessionId, path: canonicalTarget, root: canonicalRoot, reason: 'symlink-escape' },
          )
        }
        if (samePath(dirname(canonicalTarget), canonicalRoot)) {
          throw new SessionDeleteError(
            'session-delete/unsafe-path',
            `sessionDelete: the original location of session "${sessionId}" resolves to a project directory, not a session; nothing was restored`,
            { sessionId, path: canonicalTarget, root: canonicalRoot, reason: 'unexpected-layout' },
          )
        }
      } catch (error) {
        if (error instanceof SessionDeleteError) throw error
        throw new SessionDeleteError(
          'session-delete/unsafe-path',
          `sessionDelete: the original location of session "${sessionId}" could not be verified; nothing was restored`,
          { sessionId, path: target, root, reason: 'unverifiable-path', causeCode: error?.code },
        )
      }
    }
    const artifact = join(entry.path, ARTIFACT_DIR_NAME)
    const targetExists = await this.pathExists(target)
    const artifactExists = await this.pathExists(artifact)
    const restoreMarker = join(entry.path, RESTORING_MARKER_FILE_NAME)
    const restoreInProgress = await this.pathExists(restoreMarker)
    const staging = `${target}${COPY_STAGE_SUFFIX}`
    if (restoreInProgress) {
      let record
      try {
        record = JSON.parse(await readFile(restoreMarker, 'utf8'))
      } catch {
        throw new SessionDeleteError(
          'session-delete/io',
          `sessionDelete: the restore marker for session "${sessionId}" is unreadable; both copies were preserved`,
          { sessionId, path: restoreMarker, reason: 'invalid-restore-marker' },
        )
      }
      if (
        record?.sessionId !== sessionId ||
        typeof record.target !== 'string' ||
        !samePath(resolve(record.target), resolve(target))
      ) {
        throw new SessionDeleteError(
          'session-delete/conflict',
          `sessionDelete: the restore marker for session "${sessionId}" does not match its original path; both copies were preserved`,
          { sessionId, path: restoreMarker, reason: 'restore-marker-mismatch' },
        )
      }
    }
    // A completed move can be retried while accounting is pending. A marker
    // distinguishes that state from an unrelated file that occupied target.
    const alreadyMoved = targetExists && !artifactExists && (restoreInProgress || entry.restoreState !== undefined)
    if (targetExists && artifactExists) {
      if (!restoreInProgress || !(await this.artifactsMatch(artifact, target))) {
        throw new SessionDeleteError(
          'session-delete/conflict',
          `sessionDelete: the original location of session "${sessionId}" is occupied; both copies were preserved`,
          { sessionId, path: target, reason: 'restore-copy-conflict' },
        )
      }
      // The cross-device copy was promoted before the process stopped. Verify
      // byte-for-byte equality before dropping the trash-side source.
      await this.removeWithRetries(artifact, sessionId)
    } else if (targetExists && !alreadyMoved) {
      throw new SessionDeleteError(
        'session-delete/conflict',
        `sessionDelete: the original location of session "${sessionId}" is occupied; nothing was restored`,
        { sessionId, path: target },
      )
    }
    if (!targetExists && !artifactExists) {
      throw new SessionDeleteError(
        'session-delete/io',
        `sessionDelete: the trash entry of session "${sessionId}" holds no artifact; nothing was restored`,
        { sessionId, path: artifact, reason: 'missing-artifact' },
      )
    }
    if (!alreadyMoved && !(targetExists && artifactExists)) {
      try {
        await mkdir(dirname(target), { recursive: true })
        if (!restoreInProgress) {
          // Do not claim a pre-existing staging path: only a stage created
          // after this durable marker belongs to this restore transaction.
          if (await this.pathExists(staging)) {
            throw new SessionDeleteError(
              'session-delete/conflict',
              `sessionDelete: the restore staging path for session "${sessionId}" is already occupied`,
              { sessionId, path: staging, reason: 'restore-staging-occupied' },
            )
          }
          await writeFile(restoreMarker, JSON.stringify({ sessionId, target }), { encoding: 'utf8', flag: 'wx' })
        } else {
          // A prior process may have stopped during cp(). The marker proves
          // this transaction reserved the staging path before it was created.
          await rm(staging, { recursive: true, force: true })
        }
        await this.moveArtifact(artifact, target)
      } catch (error) {
        throw new SessionDeleteError(
          'session-delete/io',
          `sessionDelete: restoring session "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { sessionId, path: target },
        )
      }
    }
    // Once only the restored copy remains, the marker has served its purpose.
    // If marker removal is interrupted, the retry still recognizes this state.
    await rm(restoreMarker, { force: true }).catch(() => {})
    // The files are back; from here on every step reports rather than throws.
    // The store is asked for the header again so the reattachment and the
    // browser summary use the real stored header, not only the identifying
    // fields the manifest kept.
    let header = entry.header
    try {
      const snapshot = await this.ctx.sessionPersistence.stat(sessionId)
      if (snapshot?.header) header = snapshot.header
    } catch {
      // The manifest header is the recorded truth when the store cannot read.
    }
    const restoredEntry = header === entry.header ? entry : { ...entry, header }
    const reattach = await this.reattachAccounting(restoredEntry, sessionId)
    const announced = reattach === undefined || reattach.reattached === true
      ? this.announceRestored(restoredEntry)
      : false
    const incomplete = reattach !== undefined && reattach.reattached === false
    if (incomplete) {
      // Keep the entry: it no longer holds an artifact, but it is the record a
      // repeated restore needs to finish the reattachment. It is marked so the
      // deletion path does not mistake it for a conversation still in the trash.
      await this.markRestorePending(entry)
      await this.audit('restore', sessionId, true, {
        mode: this.mode,
        partial: true,
        code: 'session-delete/restore-incomplete',
      })
      return {
        sessionId,
        restored: true,
        mode: this.mode,
        reattached: false,
        needsRestart: true,
        reattachFailures: reattach.failures,
        ...(announced ? { announced: true } : {}),
      }
    }
    // The artifact is back in place, so a leftover manifest is only litter:
    // it must not turn a completed restore into a failure.
    try {
      await this.removeWithRetries(entry.path, sessionId)
    } catch (error) {
      this.ctx.logger?.warn(
        `sessionDelete: removing the trash entry of session "${sessionId}" failed: ${String(error)}`,
      )
    }
    this.forgetTrashEntry(entry.trashId)
    await this.audit('restore', sessionId, true, { mode: this.mode })
    const outcome = { sessionId, restored: true, mode: this.mode }
    if (reattach !== undefined) {
      outcome.reattached = reattach.reattached
      if (reattach.reordered === false && reattach.reattached) outcome.reordered = false
      if (reattach.inferred === true) outcome.inferred = true
    }
    if (announced) outcome.announced = true
    return outcome
  }

  /**
   * Mark a trash entry as waiting for its accounting restore.
   *
   * The manifest is rewritten in place with the marker and the moment the
   * artifact went back, so the next restore (or the next launch) can tell a
   * half-finished restore from an occupied original location.
   * @param entry - the trash entry whose artifact is already back.
   */
  async markRestorePending(entry) {
    const manifest = (await this.readManifest(entry.path)) ?? {
      sessionId: entry.sessionId,
      originalPath: entry.originalPath,
      deletedAt: entry.deletedAt,
    }
    const next = { ...manifest, restoreState: RESTORE_PENDING, restoredAt: new Date().toISOString() }
    try {
      await writeFile(join(entry.path, MANIFEST_FILE_NAME), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      entry.restoreState = RESTORE_PENDING
      return true
    } catch (error) {
      this.ctx.logger?.warn(
        `sessionDelete: marking the trash entry of session "${entry.sessionId}" as pending failed: ${String(error)}`,
      )
      return false
    }
  }

  /**
   * The purge proper; see {@link purge} for the contract.
   * @param sessionId - durable Session identity.
   * @returns the purge outcome.
   */
  async runPurge(sessionId) {
    const entry = await this.trashEntryFor(sessionId)
    if (entry === undefined) {
      throw new SessionDeleteError(
        'session-delete/not-found',
        `sessionDelete: session "${sessionId}" is not in the trash`,
        { sessionId },
      )
    }
    await this.removeWithRetries(entry.path, sessionId)
    this.forgetTrashEntry(entry.trashId)
    await this.audit('purge', sessionId, true, { mode: this.mode })
    return { sessionId, purged: true }
  }

  /**
   * The trashed conversations, newest first.
   *
   * The listing is read from the disk, so it also reports entries another
   * process left behind, and it is the moment the retention sweep runs.
   * @returns the trash entries.
   */
  async listTrash() {
    await this.sweepTrash()
    const entries = await this.refreshTrash()
    return {
      entries: entries.map((entry) => ({
        trashId: entry.trashId,
        sessionId: entry.sessionId,
        deletedAt: entry.deletedAt,
        originalPath: entry.originalPath,
        // Present only for an entry whose files are already restored but whose
        // workspace accounting still has to be replayed; such an entry holds no
        // artifact and a restore (or a launch) finishes it.
        ...(entry.restoreState === undefined ? {} : { restoreState: entry.restoreState }),
      })),
    }
  }

  /**
   * The newest trash entry of one session, when it has one.
   *
   * The index is read from the disk the first time it is needed, so a
   * conversation trashed by an earlier run is still found.
   * @param sessionId - durable Session identity.
   * @returns the trash entry, or undefined when the session is not trashed.
   */
  async trashEntryFor(sessionId) {
    if (!this.trashLoaded) await this.refreshTrash()
    return this.trashBySession.get(sessionId)
  }

  /**
   * Recover a trash move interrupted after its transaction marker was written.
   *
   * The copy is first built at a private staging path and atomically renamed
   * into place. A visible artifact therefore means the copy completed. Before
   * deleting a surviving source, compare its identity with the snapshot stored
   * in the marker; if another writer replaced it, preserve both paths.
   * @param path - the trash entry directory.
   * @param manifest - the entry manifest.
   * @returns whether the entry is safe to expose in the trash index.
   */
  async recoverTrashMove(path, manifest) {
    const markerPath = join(path, COPYING_MARKER_FILE_NAME)
    if (!(await this.pathExists(markerPath))) return true

    let identity
    try {
      identity = JSON.parse(await readFile(markerPath, 'utf8'))
    } catch {
      this.ctx.logger?.warn(`sessionDelete: the recovery marker in "${path}" is unreadable; both copies were preserved`)
      return false
    }

    const source = manifest.originalPath
    const artifact = join(path, ARTIFACT_DIR_NAME)
    const staging = `${artifact}${COPY_STAGE_SUFFIX}`
    const sourceExists = typeof source === 'string' && (await this.pathExists(source))
    const artifactExists = await this.pathExists(artifact)

    if (!artifactExists) {
      if (sourceExists) {
        // The copy was never atomically promoted. The source is untouched and
        // remains authoritative, so discard only the incomplete trash entry.
        await this.discardTrashEntry(path)
        return false
      }
      this.ctx.logger?.warn(`sessionDelete: the interrupted move in "${path}" has no surviving source or artifact`)
      return false
    }

    if (sourceExists) {
      const root = this.storeRoot()
      if (root === undefined) {
        this.ctx.logger?.warn(`sessionDelete: cannot recover "${path}" without a verifiable session-store root`)
        return false
      }
      let canonicalRoot
      let canonicalSource
      try {
        canonicalRoot = await realpath(root)
        canonicalSource = await resolveThroughExistingAncestors(source)
      } catch (error) {
        this.ctx.logger?.warn(`sessionDelete: cannot verify the source of interrupted move "${path}": ${String(error)}`)
        return false
      }
      if (
        !isInside(canonicalRoot, canonicalSource) ||
        samePath(dirname(canonicalSource), canonicalRoot) ||
        !(await this.artifactsMatch(source, artifact))
      ) {
        this.ctx.logger?.warn(
          `sessionDelete: the source of interrupted move "${path}" changed; both copies were preserved for manual recovery`,
        )
        return false
      }
    }

    // Once the complete copy is visible, move the original to a deterministic
    // tombstone on its own volume before recursively removing it. A crash
    // during rm then cannot leave a partial directory at the live session path.
    if (typeof source !== 'string' || source.length === 0) return false
    const tombstone = join(dirname(source), `.session-delete-${basename(path)}.moving`)
    const tombstoneExists = await this.pathExists(tombstone)
    if (sourceExists && tombstoneExists) {
      this.ctx.logger?.warn(`sessionDelete: both source and tombstone exist for interrupted move "${path}"`)
      return false
    }
    if (sourceExists) {
      try {
        await rename(source, tombstone)
      } catch (error) {
        // Another recovery pass may already have completed the atomic rename
        // and removed the tombstone. Treat ENOENT as complete only after
        // confirming the source is absent; other failures remain actionable.
        if (error?.code !== 'ENOENT' || (await this.pathExists(source))) throw error
      }
    }
    if (await this.pathExists(tombstone)) {
      await this.removeWithRetries(tombstone, manifest.sessionId)
    }

    await rm(markerPath, { force: true })
    await rm(staging, { recursive: true, force: true })
    return true
  }
  /**
   * Read every trash entry from the disk.
   *
   * The listing is bounded so a huge trash cannot stall one request, and an
   * entry without a readable manifest is skipped rather than guessed at.
   * @returns the trash entries, newest first.
   */
  async readTrashEntries({ recoverMoves = true } = {}) {
    const root = this.trashRoot()
    if (root === undefined) return []
    let names
    try {
      names = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      this.ctx.logger?.warn(`sessionDelete: reading the trash directory failed: ${String(error)}`)
      return []
    }
    const entries = []
    let examined = 0
    for (const item of names) {
      // The bound counts the directories read, not the usable entries, so a
      // trash full of junk cannot turn one request into a long stall.
      if (examined >= SWEEP_ENTRY_LIMIT) break
      if (!item.isDirectory()) continue
      examined += 1
      const path = join(root, item.name)
      const manifest = await this.readManifest(path)
      if (manifest === undefined) continue
      if (recoverMoves && (await this.pathExists(join(path, COPYING_MARKER_FILE_NAME)))) {
        const sessionId = typeof manifest.sessionId === 'string' ? manifest.sessionId : ''
        if (sessionId.length === 0) continue
        const recovered = await this.runTrashOperation(
          'move-recovery',
          sessionId,
          () => this.recoverTrashMove(path, manifest),
        )
        if (!recovered) continue
      }
      entries.push({
        trashId: item.name,
        sessionId: typeof manifest.sessionId === 'string' ? manifest.sessionId : '',
        deletedAt: typeof manifest.deletedAt === 'string' ? manifest.deletedAt : '',
        originalPath: typeof manifest.originalPath === 'string' ? manifest.originalPath : '',
        path,
        children: Array.isArray(manifest.children) ? manifest.children : [],
        childrenCount:
          typeof manifest.childrenCount === 'number' ? manifest.childrenCount : (manifest.children ?? []).length,
        // The header and the accounting record are what a restore needs; they
        // travel with the manifest so the trash entry alone is enough.
        header: manifest.header !== null && typeof manifest.header === 'object' ? manifest.header : undefined,
        accounting:
          manifest.accounting !== null && typeof manifest.accounting === 'object'
            ? manifest.accounting
            : undefined,
        restoreState: typeof manifest.restoreState === 'string' ? manifest.restoreState : undefined,
      })
    }
    entries.sort(compareTrashEntries)
    return entries
  }

  /**
   * Read the manifest of one trash entry.
   * @param path - the trash entry directory.
   * @returns the manifest, or undefined when it is missing or unreadable.
   */
  async readManifest(path) {
    try {
      const text = await readFile(join(path, MANIFEST_FILE_NAME), 'utf8')
      const manifest = JSON.parse(text)
      if (!manifest || typeof manifest !== 'object') return undefined
      return manifest
    } catch {
      return undefined
    }
  }

  /**
   * Replace the in-memory trash index.
   *
   * A refresh that overlapped a mutation merges instead of replacing: the
   * mutation's entry may not have been on the disk when the refresh read it.
   * @param entries - the entries read from the disk.
   * @param merge - whether the entries known already are kept.
   */
  setTrashIndex(entries, merge = false) {
    const index = merge ? new Map(this.trashIndex) : new Map()
    const bySession = merge ? new Map(this.trashBySession) : new Map()
    for (const entry of entries) {
      index.set(entry.trashId, entry)
      // The listing is newest first, so the first entry of a session wins.
      if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, entry)
    }
    this.trashIndex = index
    this.trashBySession = bySession
    this.trashLoaded = true
  }

  /**
   * Record one trash entry in the in-memory index.
   * @param entry - the entry that now exists on the disk.
   */
  rememberTrashEntry(entry) {
    this.trashIndex.set(entry.trashId, entry)
    this.trashBySession.set(entry.sessionId, entry)
    this.trashLoaded = true
    this.trashRevision += 1
  }

  /**
   * Drop one trash entry from the in-memory index.
   * @param trashId - the entry's trash id.
   */
  forgetTrashEntry(trashId) {
    const entry = this.trashIndex.get(trashId)
    this.trashIndex.delete(trashId)
    if (entry !== undefined && this.trashBySession.get(entry.sessionId)?.trashId === trashId) {
      this.trashBySession.delete(entry.sessionId)
    }
    this.trashLoaded = true
    this.trashRevision += 1
  }

  /**
   * Read the trash index from the disk.
   *
   * The service does this once when it starts, so the first request already
   * knows what an earlier run left in the trash.
   * @returns the trash entries, newest first.
   */
  async refreshTrash({ recoverMoves = true, force = false } = {}) {
    if (!force && this.trashRefreshPromise !== undefined) return this.trashRefreshPromise
    const revision = this.trashRevision
    const task = this.readTrashEntries({ recoverMoves }).then((entries) => {
      // A mutation that landed while the disk was read would be lost by a
      // plain replacement, so the fresh entries are merged into the index.
      this.setTrashIndex(entries, revision !== this.trashRevision)
      return entries
    }).finally(() => {
      if (this.trashRefreshPromise === task) this.trashRefreshPromise = undefined
    })
    if (!force) this.trashRefreshPromise = task
    return task
  }

  /**
   * Reconcile durable trash transactions once the host has finished starting.
   *
   * A trash artifact with no live source is a committed delete: replay its
   * idempotent workspace/cache cleanup. A restore marker, an accounting-pending
   * manifest, or a live target with no trash artifact is instead a committed
   * restore: resume the restore path so workspace accounting is reattached.
   * Ambiguous pairs are preserved for an explicit recovery rather than guessed.
   *
   * @returns counts of recovered deletes, restores and preserved entries.
   */
  async reconcileStartup() {
    if (this.mode !== 'trash') return { deleted: 0, restored: 0, preserved: 0 }
    const entries = await this.refreshTrash()
    let deleted = 0
    let restored = 0
    let preserved = 0
    let examined = 0

    for (const snapshot of entries) {
      if (examined >= STARTUP_RECOVERY_LIMIT) break
      if (typeof snapshot.sessionId !== 'string' || snapshot.sessionId.length === 0) continue
      examined += 1
      try {
        const outcome = await this.runTrashOperation('startup-recovery', snapshot.sessionId, async () => {
          // Re-read under the same per-session lock as delete/restore/purge.
          await this.refreshTrash({ recoverMoves: false, force: true })
          const current = await this.trashEntryFor(snapshot.sessionId)
          if (current === undefined || current.trashId !== snapshot.trashId) return 'stale'

          const artifact = join(current.path, ARTIFACT_DIR_NAME)
          const artifactExists = await this.pathExists(artifact)
          const targetExists = typeof current.originalPath === 'string' && current.originalPath.length > 0
            ? await this.pathExists(current.originalPath)
            : false
          const restoreMarkerExists = await this.pathExists(join(current.path, RESTORING_MARKER_FILE_NAME))
          const restorePending = current.restoreState === RESTORE_PENDING

          if (restorePending || restoreMarkerExists || (!artifactExists && targetExists)) {
            if (!targetExists) {
              this.ctx.logger?.warn(
                `sessionDelete: startup recovery preserved "${current.trashId}": the restore target is missing`,
              )
              return 'preserved'
            }
            // A crash can happen after the restore move and before the manifest
            // is marked pending. Persist that state before replaying accounting.
            if (!restorePending && !restoreMarkerExists) {
              const marked = await this.markRestorePending(current)
              if (!marked) return 'preserved'
            }
            const result = await this.runRestore(current.sessionId)
            return result.restored === true ? 'restored' : 'preserved'
          }

          if (artifactExists && !targetExists && !restoreMarkerExists && !restorePending) {
            // The artifact is safely in trash. These operations are
            // idempotent, so replaying them closes the crash window between
            // moving the artifact and releasing the host-side records.
            const accountingComplete = await this.releaseWorkspaceAccounting(current.sessionId)
            const cacheComplete = await this.removeProjectionCache(current.sessionId)
            return accountingComplete && cacheComplete ? 'deleted' : 'preserved'
          }

          this.ctx.logger?.warn(
            `sessionDelete: startup recovery preserved "${current.trashId}": artifact and original path are in an ambiguous state`,
          )
          return 'preserved'
        })

        if (outcome === 'deleted') deleted += 1
        else if (outcome === 'restored') restored += 1
        else if (outcome === 'preserved') preserved += 1
      } catch (error) {
        preserved += 1
        this.ctx.logger?.warn(
          `sessionDelete: startup recovery of "${snapshot.trashId}" failed; the entry was preserved: ${String(error)}`,
        )
      }
    }

    if (entries.length > examined) {
      this.ctx.logger?.warn(
        `sessionDelete: startup recovery processed ${examined} entries; ${entries.length - examined} remain for a later launch`,
      )
    }
    return { deleted, restored, preserved }
  }

  /**
   * Purge the trash entries that outlived the retention window.
   *
   * The sweep is bounded on purpose: it examines a limited number of entries
   * and purges a limited number of them, so a large trash can never turn one
   * request into a long stall. It runs at most once per interval, and the
   * call that triggers it does not wait longer than the sweep needs.
   * @returns the ids of the purged entries.
   */
  async sweepTrash() {
    const now = Date.now()
    if (this.sweepPromise !== undefined) return this.sweepPromise
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return []
    this.lastSweepAt = now
    this.sweepPromise = this.runSweep().finally(() => {
      this.sweepPromise = undefined
    })
    return this.sweepPromise
  }

  /**
   * The sweep proper; see {@link sweepTrash} for the policy.
   * @returns the ids of the purged entries.
   */
  async runSweep() {
    const entries = await this.readTrashEntries()
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    const purged = []
    for (const entry of entries) {
      if (purged.length >= SWEEP_PURGE_LIMIT) break
      const deletedAt = Date.parse(entry.deletedAt)
      if (!Number.isFinite(deletedAt) || deletedAt >= cutoff) continue
      try {
        const didPurge = await this.runTrashOperation('purge', entry.sessionId, async () => {
          // The entry may have been restored or replaced while the sweep was
          // waiting for the per-session lock. Never purge a stale snapshot.
          await this.refreshTrash({ recoverMoves: false, force: true })
          const current = await this.trashEntryFor(entry.sessionId)
          if (current === undefined || current.trashId !== entry.trashId) return false
          const currentDeletedAt = Date.parse(current.deletedAt)
          if (!Number.isFinite(currentDeletedAt) || currentDeletedAt >= cutoff) return false
          await this.removeWithRetries(current.path, current.sessionId)
          this.forgetTrashEntry(current.trashId)
          await this.audit('purge', current.sessionId, true, { mode: this.mode })
          return true
        })
        if (didPurge) purged.push(entry.sessionId)
      } catch (error) {
        this.ctx.logger?.warn(
          `sessionDelete: purging the expired trash entry "${entry.trashId}" failed: ${String(error)}`,
        )
      }
    }
    return purged
  }

  /**
   * Remove a trash entry that could not be completed.
   *
   * The entry only holds a copy of an artifact that never left its original
   * place, so dropping it loses nothing.
   * @param path - the trash entry directory.
   */
  async discardTrashEntry(path) {
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: removing the half-written trash entry failed: ${String(error)}`)
    }
  }

  /**
   * Append one record to the audit trail.
   *
   * The trail records what happened, never what was said: only ids, counts
   * and timestamps are written, so the file can be kept on disk without
   * carrying conversation content. A failing trail never fails the action it
   * describes.
   * @param action - the mutation that was attempted.
   * @param sessionId - durable Session identity.
   * @param ok - whether the mutation succeeded.
   * @param extra - the optional code, child count and mode.
   */
  async audit(action, sessionId, ok, extra = {}) {
    const root = this.trashRoot()
    if (root === undefined) return
    const record = {
      at: new Date().toISOString(),
      action,
      sessionId,
      ok,
      ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
      ...(typeof extra.children === 'number' ? { children: extra.children } : {}),
      ...(typeof extra.mode === 'string' ? { mode: extra.mode } : {}),
      // Marker only: the files are back but the accounting replay was partial.
      ...(extra.partial === true ? { partial: true } : {}),
    }
    const file = join(root, AUDIT_FILE_NAME)
    try {
      await mkdir(root, { recursive: true })
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
      await this.trimAudit(file)
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: writing the audit trail failed: ${String(error)}`)
    }
  }

  /**
   * Keep the audit trail from growing without limit.
   *
   * The file is trimmed to its newest half once it passes the record cap, so
   * the trail always holds recent history and never fills the disk. The file
   * is only read when the record count is unknown or the cap is reached, and
   * the read that counts a fresh trail is reused for the trim itself.
   * @param file - the audit trail file.
   */
  async trimAudit(file) {
    let text
    if (this.auditRecords === undefined) {
      text = await this.readAuditTrail(file)
      this.auditRecords =
        text === undefined ? 0 : text.split('\n').filter((line) => line.length > 0).length
    }
    this.auditRecords += 1
    if (this.auditRecords <= AUDIT_MAX_RECORDS) return
    if (text === undefined) {
      text = await this.readAuditTrail(file)
      if (text === undefined) {
        this.auditRecords = 0
        return
      }
    }
    const lines = text.split('\n').filter((line) => line.length > 0)
    const kept = lines.slice(Math.floor(lines.length / 2))
    try {
      await writeFile(file, `${kept.join('\n')}\n`, 'utf8')
      this.auditRecords = kept.length
    } catch (error) {
      this.ctx.logger?.warn(`sessionDelete: trimming the audit trail failed: ${String(error)}`)
    }
  }

  /**
   * Read the whole audit trail, or undefined when it cannot be read.
   * @param file - the audit trail file.
   * @returns the file's text, or undefined.
   */
  async readAuditTrail(file) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      return undefined
    }
  }
}

// Declare the Remote methods for the API Gateway's runtime dispatch. The
// marker format is the Typert protocol's public, versioned descriptor: a
// frozen record on the class prototype naming the exported methods. The
// `resources` reader is called with the method's positional arguments
// (`read(reader, positional)` in the Gateway), so for these one-parameter
// methods the reader receives the id string itself. The methods without
// parameters declare no resources and therefore act on the global scope.
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
      Object.freeze({
        method: 'describe',
        invocation: Object.freeze({ kind: 'direct' }),
      }),
      Object.freeze({
        method: 'restore',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({
          session: (sessionId) => (typeof sessionId === 'string' ? sessionId : undefined),
        }),
      }),
      Object.freeze({
        method: 'purge',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({
          session: (sessionId) => (typeof sessionId === 'string' ? sessionId : undefined),
        }),
      }),
      Object.freeze({
        method: 'listTrash',
        invocation: Object.freeze({ kind: 'direct' }),
      }),
    ]),
  }),
})

/**
 * Register the deletion service and let the browser reach it.
 * @param ctx - the owning plugin context.
 * @param config - the plugin's configuration.
 */
export function apply(ctx, config = {}) {
  if (config?.mode !== undefined && config.mode !== 'trash' && config.mode !== 'permanent') {
    ctx.logger?.warn(
      `sessionDelete: unknown mode "${String(config.mode)}"; the trash mode is used instead`,
    )
  }
  const service = new SessionDeleteService(ctx, config)
  // Bind the service to the calling context the way a Cordis Service does, so
  // the API Gateway reaches it through the same traced proxy.
  Object.defineProperty(service, TRACKER, {
    value: { associate: SERVICE_KEY, property: 'ctx' },
  })
  ctx.reflect.provide(SERVICE_KEY, service, undefined)
  // Prime the trash index immediately; the host's ready hook performs
  // reconciliation only after workspace and storage services are available.
  service.refreshTrash().catch((error) => {
    ctx.logger?.warn(`sessionDelete: reading the trash failed: ${String(error)}`)
  })
  if (typeof ctx.on === 'function') {
    ctx.on('ready', () =>
      service.reconcileStartup().catch((error) => {
        ctx.logger?.warn(`sessionDelete: startup recovery failed: ${String(error)}`)
      }),
    )
  }
}
