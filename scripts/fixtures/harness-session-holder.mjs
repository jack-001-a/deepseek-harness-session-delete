#!/usr/bin/env node
/** Child process: one real Cordis context + the pinned Harness JSONL provider. */
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root] = process.argv.slice(2)
const harnessRoot = process.env.DSH_HARNESS_ROOT
if (!root || !harnessRoot) throw new Error('Expected root and DSH_HARNESS_ROOT.')

const packages = {
  cordis: 'vendor/cordis',
  session: 'packages/core/session',
  jsonl: 'packages/session/session-persistence-jsonl',
}
async function load(key) {
  return import(pathToFileURL(join(harnessRoot, packages[key], 'lib/index.js')).href)
}
const [{ Context }, session, jsonl] = await Promise.all([load('cordis'), load('session'), load('jsonl')])
const context = new Context()
await context.plugin({ name: jsonl.name, apply: jsonl.apply }, { root, compression: 'none' })

const handles = new Map()
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
function header(id) {
  return {
    version: session.SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd: '/work',
    isSeeded: false,
  }
}

const commands = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
try {
  for await (const line of commands) {
    const [command, id] = line.trim().split(/\s+/, 2)
    if (command === 'hold') {
      if (handles.has(id)) throw new Error('Already holding ' + id)
      const handle = await context.sessionPersistence.create(header(id))
      await handle.append(events)
      handles.set(id, handle)
      process.stdout.write('held ' + id + '\n')
    } else if (command === 'release') {
      const handle = handles.get(id)
      if (handle) {
        await handle.close()
        handles.delete(id)
      }
      process.stdout.write('released ' + id + '\n')
    } else if (command === 'shutdown') {
      for (const handle of handles.values()) await handle.close()
      handles.clear()
      break
    } else {
      throw new Error('Unknown command: ' + command)
    }
  }
} finally {
  for (const handle of handles.values()) await handle.close()
  await context.fiber.dispose()
  process.stdout.write('bye\n')
}
