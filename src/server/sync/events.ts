// Typed in-process emitter + ring buffer for sync orchestrator events.
//
// See `docs/adr/007-sse-with-ring-buffer.md` for the why. Single-process,
// single-job semantics — there's exactly one orchestrator running at a time
// (Slice 006's mutex), so a module-scoped singleton is the right shape.

export const RING_CAPACITY = 200

export type SyncEvent = {
  event: string
  payload: unknown
}

type Subscriber = (ev: SyncEvent) => void

const ring: SyncEvent[] = []
const subscribers = new Set<Subscriber>()

function emit(event: string, payload: unknown): void {
  const ev: SyncEvent = { event, payload }
  ring.push(ev)
  if (ring.length > RING_CAPACITY) {
    ring.shift()
  }
  for (const sub of subscribers) {
    sub(ev)
  }
}

function recent(): SyncEvent[] {
  // Snapshot — subsequent emits should not mutate what the caller observes.
  return ring.slice()
}

function subscribe(): AsyncIterable<SyncEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SyncEvent> {
      // Each subscriber starts with a snapshot of the ring buffer so late
      // subscribers replay recent activity. After draining, they wait on
      // live emits via the resolver/queue dance below.
      const queued: SyncEvent[] = ring.slice()
      let resolver: ((result: IteratorResult<SyncEvent>) => void) | null = null
      let cancelled = false

      const handler: Subscriber = (ev) => {
        if (cancelled) return
        if (resolver !== null) {
          const r = resolver
          resolver = null
          r({ value: ev, done: false })
        } else {
          queued.push(ev)
        }
      }
      subscribers.add(handler)

      return {
        async next(): Promise<IteratorResult<SyncEvent>> {
          if (cancelled) {
            return { value: undefined, done: true }
          }
          if (queued.length > 0) {
            const ev = queued.shift() as SyncEvent
            return { value: ev, done: false }
          }
          return new Promise<IteratorResult<SyncEvent>>((resolve) => {
            resolver = resolve
          })
        },
        async return(): Promise<IteratorResult<SyncEvent>> {
          cancelled = true
          subscribers.delete(handler)
          if (resolver !== null) {
            const r = resolver
            resolver = null
            r({ value: undefined, done: true })
          }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

export const syncEvents = {
  emit,
  subscribe,
  recent,
}

// Test-only: clears the ring buffer and active subscribers between tests so
// module-scoped state doesn't leak.
export function __resetForTest(): void {
  ring.length = 0
  subscribers.clear()
}
