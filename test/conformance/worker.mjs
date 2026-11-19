import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Map()
const active = new Set()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

send({ type: 'ready', role: process.env.CONFORMANCE_ROLE, caseId: process.env.CONFORMANCE_CASE_ID, pid: process.pid })

input.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ type: 'protocol-error', error: 'invalid-json' })
    return
  }

  if (message.type === 'release') {
    const resume = pending.get(message.barrier)
    if (resume) {
      pending.delete(message.barrier)
      resume()
    }
    return
  }

  if (message.type === 'run' && message.action === 'barrier') {
    const { barrier, caseId, role } = message
    if (typeof barrier !== 'string' || !barrier || typeof caseId !== 'string' || typeof role !== 'string') {
      send({ type: 'protocol-error', error: 'invalid-barrier-request' })
      return
    }
    if (pending.has(barrier) || active.has(barrier)) {
      send({ type: 'protocol-error', error: 'duplicate-barrier', barrier })
      return
    }
    active.add(barrier)
    send({ type: 'barrier-reached', barrier, caseId, role, pid: process.pid })
    awaitRelease(barrier).then(() => {
      active.delete(barrier)
      send({ type: 'barrier-released', barrier, caseId, role })
    })
    return
  }

  if (message.type === 'run' && message.action === 'emit') {
    send({ type: 'event', event: message.event })
    return
  }

  if (message.type === 'shutdown') {
    send({ type: 'shutdown-ack' })
    input.close()
    process.exitCode = 0
  }
})

function awaitRelease(name) {
  return new Promise((resolve) => pending.set(name, resolve))
}
