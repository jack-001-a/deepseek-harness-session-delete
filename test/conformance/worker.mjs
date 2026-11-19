import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

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
    if (typeof barrier !== 'string' || typeof caseId !== 'string' || typeof role !== 'string') {
      send({ type: 'protocol-error', error: 'invalid-barrier-request' })
      return
    }
    send({ type: 'barrier-reached', barrier, caseId, role, pid: process.pid })
    awaitRelease(barrier).then(() => send({ type: 'barrier-released', barrier, caseId, role }))
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
