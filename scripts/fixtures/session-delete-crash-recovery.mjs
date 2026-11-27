#!/usr/bin/env node
/**
 * Child-process fixture for the durable Trash crash-recovery contract.
 *
 * Delete crash mode exits after moving the artifact to Trash but before
 * workspace release. Restore crash mode exits after moving it back but before
 * marker removal and workspace reattachment. Recovery modes start with fresh
 * in-memory Registry state and replay the on-disk transaction.
 */
import { apply } from '../../index.js'
import { cp, rename } from 'node:fs/promises'
import { join } from 'node:path'

const [mode, root, sessionId] = process.argv.slice(2)
const validModes = ['crash-delete-after-tombstone', 'crash-delete-before-move', 'crash-delete', 'recover-delete', 'crash-restore', 'recover-restore']
if (!validModes.includes(mode) || !root || !sessionId) {
  throw new Error('Expected a supported mode, session root and session id.')
}
const restoreMode = mode.endsWith('restore')
const crashing = mode.startsWith('crash')

const sessionDir = join(root, '--project--', sessionId)
const pinned = new Set(restoreMode ? [] : [sessionId])
const archived = new Set()
const workspace = {
  id: 'workspace-process-crash',
  path: root,
  record: { sessionIds: restoreMode ? ['session-older'] : [sessionId, 'session-older'] },
  detachSession: async (id) => {
    workspace.record.sessionIds = workspace.record.sessionIds.filter((entry) => entry !== id)
  },
  attachSession: async (id) => {
    if (!workspace.record.sessionIds.includes(id)) {
      workspace.record.sessionIds = [id, ...workspace.record.sessionIds]
    }
  },
  insertSessionBefore: async (id, beforeId) => {
    const ids = workspace.record.sessionIds.filter((entry) => entry !== id)
    const index = ids.indexOf(beforeId)
    ids.splice(index < 0 ? 0 : index, 0, id)
    workspace.record.sessionIds = ids
  },
}
const registry = {
  list: () => [workspace],
  get: (id) => (id === workspace.id || id === 'ws-1' ? workspace : undefined),
  get pinnedSessionIds() { return [...pinned] },
  get archivedSessionIds() { return [...archived] },
  unpinSession: async (id) => { pinned.delete(id) },
  unarchiveSession: async (id) => { archived.delete(id) },
  pinSession: async (id) => { pinned.add(id) },
  archiveSession: async (id) => {
    pinned.delete(id)
    archived.add(id)
  },
}
const sessions = {
  get: () => undefined,
  store: new Map(),
  flush: async () => {},
  detachEntered: () => {},
}
const persistence = {
  root,
  stat: async () => ({ header: { id: sessionId, cwd: sessionDir } }),
  list: async () => [],
  locate: (header) => ({
    kind: 'jsonl',
    path: join(root, '--project--', header.id, 'session.4.jsonl'),
  }),
}
const provided = new Map()
const ctx = {
  sessions,
  sessionPersistence: persistence,
  waterfall: async (_name, _payload, base) => base(),
  parallel: async () => {},
  emit: () => {},
  on: () => {},
  get: (name) => {
    if (name === 'sessions') return sessions
    if (name === 'sessionPersistence') return persistence
    if (name === 'workspaceRegistry') return registry
    return undefined
  },
  logger: { warn: (message) => process.stderr.write(String(message) + '\n') },
  reflect: { provide: (name, value) => provided.set(name, value) },
}

apply(ctx, {})
const service = provided.get('sessionDelete')
if (!service) throw new Error('Session Delete service was not registered.')

if (mode === 'crash-delete-after-tombstone') {
  // Force the same copy/promote path used after EXDEV, even though the
  // fixture's temporary store is normally on one volume.
  service.moveArtifact = async (source, destination, options = {}) => {
    const staging = destination + '.partial'
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true })
    await rename(staging, destination)
    await options.afterPromote(source)
  }
  const removeWithRetries = service.removeWithRetries.bind(service)
  service.removeWithRetries = async (target, id) => {
    if (target.endsWith('.moving')) {
      // The source has been atomically renamed to its transaction tombstone.
      // Exit before recursive cleanup to exercise fresh-process recovery.
      process.exit(84)
    }
    return removeWithRetries(target, id)
  }
  await service.delete(sessionId)
  process.exit(88)
}

if (mode === 'crash-delete-before-move') {
  service.moveArtifact = async () => {
    // moveToTrash has durably written .copying and advanced the manifest to
    // "moving", but no source/destination artifact operation has started.
    process.exit(85)
  }
  await service.delete(sessionId)
  process.exit(88)
}

if (mode === 'crash-delete') {
  service.releaseWorkspaceAccounting = async () => {
    // process.exit intentionally bypasses the operation-lock finally block.
    process.exit(86)
  }
  await service.delete(sessionId)
  process.exit(88)
}

if (mode === 'crash-restore') {
  const move = service.moveArtifact.bind(service)
  service.moveArtifact = async (...args) => {
    await move(...args)
    // The durable restore marker remains, but the operation lock is abandoned.
    process.exit(87)
  }
  await service.restore(sessionId)
  process.exit(89)
}

const result = await service.reconcileStartup()
process.stdout.write(JSON.stringify({
  result,
  sessionIds: workspace.record.sessionIds,
  pinned: [...pinned],
  archived: [...archived],
  trashEntry: (await service.trashEntryFor(sessionId)) !== undefined,
  lockPath: await service.processLockPath(sessionId),
}) + '\n')
