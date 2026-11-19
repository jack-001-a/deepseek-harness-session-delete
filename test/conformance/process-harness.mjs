import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const MAX_LINE_BYTES = 64 * 1024

/** Owns one isolated worker process and its line-delimited control protocol. */
export class ProcessWorker {
  #child
  #events = []
  #waiters = new Set()
  #closed = false

  constructor({ script = new URL('./worker.mjs', import.meta.url), role, caseId, env = {} }) {
    if (!role || !caseId) throw new TypeError('role and caseId are required')
    this.role = role
    this.caseId = caseId
    this.#child = spawn(process.execPath, [script instanceof URL ? script.pathname : script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, CONFORMANCE_ROLE: role, CONFORMANCE_CASE_ID: caseId },
      windowsHide: true,
    })
    this.stderr = ''
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-MAX_LINE_BYTES) })
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.#fail(new Error('worker protocol line exceeds limit'))
        this.kill()
        return
      }
      let event
      try { event = JSON.parse(line) } catch {
        this.#fail(new Error('worker emitted invalid JSON'))
        return
      }
      this.#events.push(event)
      for (const waiter of [...this.#waiters]) waiter()
    })
    this.exit = new Promise((resolve, reject) => {
      this.#child.once('error', reject)
      this.#child.once('exit', (code, signal) => {
        this.#closed = true
        resolve({ code, signal, stderr: this.stderr })
        for (const waiter of [...this.#waiters]) waiter()
      })
    })
  }

  #fail(error) {
    this.#protocolError = error
    for (const waiter of [...this.#waiters]) waiter()
  }

  send(message) {
    if (this.#closed || !this.#child.stdin.writable) throw new Error('worker is not writable')
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new RangeError('worker command exceeds protocol limit')
    this.#child.stdin.write(line + '\n')
  }

  barrier(barrier) {
    this.send({ type: 'run', action: 'barrier', barrier, caseId: this.caseId, role: this.role })
  }

  release(barrier) {
    this.send({ type: 'release', barrier })
  }

  async waitFor(predicate, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.#protocolError) throw this.#protocolError
      const found = this.#events.find(predicate)
      if (found) return found
      if (this.#closed) throw new Error(`worker exited before expected event; stderr: ${this.stderr}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for worker event; stderr: ${this.stderr}`)
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve() }
        const timer = setTimeout(done, remaining)
        this.#waiters.add(done)
      })
    }
  }

  async shutdown({ timeoutMs = 3_000 } = {}) {
    if (this.#closed) return this.exit
    this.send({ type: 'shutdown' })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('worker shutdown timed out')), timeoutMs))
    return Promise.race([this.exit, timeout])
  }

  kill(signal = 'SIGKILL') {
    if (!this.#closed) this.#child.kill(signal)
  }
}

/** Start and always reap workers created by a test. */
export async function withWorkers(options, callback) {
  const workers = options.map((option) => new ProcessWorker(option))
  try {
    return await callback(workers)
  } finally {
    for (const worker of workers) worker.kill()
    await Promise.allSettled(workers.map((worker) => worker.exit))
  }
}
