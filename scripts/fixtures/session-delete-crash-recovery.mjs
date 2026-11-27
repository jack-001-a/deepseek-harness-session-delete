#!/usr/bin/env node
/**
 * Child-process fixture for the durable Trash crash-recovery contract.
 *
 * "crash" exits at the exact point after the artifact move and before
 * workspace/cache release. "recover" starts with a fresh in-memory Registry
 * and replays startup recovery from the on-disk Trash entry.
 */
import { apply } from '../../index.js'
import { join } from 'node:path'

const [mode, root, sessionId] = process.argv.slice(2)
if (!['crash', 'recover'].includes(mode) || !root || !sessionId) {
  throw new Error('Expected mode (crash|recover), session root and session id.')
}

const sessionDir = join(root, '--project--', sessionId)
const pinned = new Set([sessionId])
const archived = new Set([sessionId])
const workspace = {
  id: 'workspace-process-crash',
  path: root,
  record: { sessionIds: [sessionId, 'session-older'] },
  detachSession: async (id) => {
    workspace.record.sessionIds = workspace.record.sessionIds.filter((entry) => entry !== id)
  },
}
const registry = {
  list: () => [workspace],
  get: (id) => (id === workspace.id ? workspace : undefined),
  get pinnedSessionIds() { return [...pinned] },
  get archivedSessionIds() { return [...archived] },
  unpinSession: async (id) => { pinned.delete(id) },
  unarchiveSession: async (id) => { archived.delete(id) },
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

if (mode === 'crash') {
  service.releaseWorkspaceAccounting = async () => {
    // process.exit intentionally bypasses the operation-lock finally block.
    process.exit(86)
  }
  await service.delete(sessionId)
  process.exit(87)
}

const result = await service.reconcileStartup()
process.stdout.write(JSON.stringify({
  result,
  sessionIds: workspace.record.sessionIds,
  pinned: [...pinned],
  archived: [...archived],
  lockPath: await service.processLockPath(sessionId),
}) + '\n')
