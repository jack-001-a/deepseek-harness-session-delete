/** Parent-side barrier coordination and one-shot deterministic fault scheduling. */
export class BarrierController {
  #workers
  #sequence = 0
  #events = []

  constructor(workers) {
    this.#workers = new Map(workers.map((worker) => [worker.role, worker]))
    if (this.#workers.size !== workers.length) throw new Error('worker roles must be unique')
  }

  async waitFor(role, type, barrier, options) {
    const worker = this.#workers.get(role)
    if (!worker) throw new Error(`unknown worker role: ${role}`)
    const event = await worker.waitFor((item) => item.type === type && item.barrier === barrier, options)
    const ordered = { ...event, controllerSequence: ++this.#sequence }
    this.#events.push(ordered)
    return ordered
  }

  release(role, barrier) {
    const worker = this.#workers.get(role)
    if (!worker) throw new Error(`unknown worker role: ${role}`)
    worker.release(barrier)
  }

  get events() {
    return this.#events.map((event) => ({ ...event }))
  }
}

/** A deterministic, one-shot fault plan; it does not alter Provider behavior itself. */
export class FaultPlan {
  #points

  constructor(points = []) {
    const allowed = new Set(['pause', 'error', 'kill'])
    this.#points = new Map()
    for (const point of points) {
      if (!point || typeof point.point !== 'string' || !point.point || !allowed.has(point.action)) {
        throw new TypeError('fault requires a named point and pause, error, or kill action')
      }
      if (this.#points.has(point.point)) throw new Error(`duplicate fault point: ${point.point}`)
      this.#points.set(point.point, { ...point })
    }
  }

  take(point) {
    const fault = this.#points.get(point)
    if (!fault) return null
    this.#points.delete(point)
    if (fault.action === 'error') throw new Error(fault.code || `injected fault at ${point}`)
    return fault
  }

  get remaining() {
    return [...this.#points.keys()]
  }
}
