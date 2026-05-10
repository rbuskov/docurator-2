import { afterEach, describe, expect, it } from 'vitest'
import { __resetForTest, RING_CAPACITY, syncEvents } from './events.js'

describe('syncEvents', () => {
  afterEach(() => {
    __resetForTest()
  })

  it('exports RING_CAPACITY = 200', () => {
    expect(RING_CAPACITY).toBe(200)
  })

  it('emit-then-subscribe round-trip: new subscribers receive subsequent events', async () => {
    const received: Array<{ event: string; payload: unknown }> = []

    // Start the subscriber first; collect a few events; then close.
    const it = syncEvents.subscribe()[Symbol.asyncIterator]()
    const collect = (async () => {
      for (let i = 0; i < 2; i++) {
        const r = await it.next()
        if (r.done) return
        received.push(r.value)
      }
    })()

    syncEvents.emit('sync.start', { job_id: 'j1' })
    syncEvents.emit('sync.account.start', { account_id: 1 })

    await collect
    await it.return?.()

    expect(received).toEqual([
      { event: 'sync.start', payload: { job_id: 'j1' } },
      { event: 'sync.account.start', payload: { account_id: 1 } },
    ])
  })

  it('late subscribers replay the ring buffer on first iteration', async () => {
    syncEvents.emit('sync.start', { job_id: 'j2' })
    syncEvents.emit('sync.account.start', { account_id: 1 })
    syncEvents.emit('sync.message', { account_id: 1, message_id: 'm1' })

    const it = syncEvents.subscribe()[Symbol.asyncIterator]()
    const a = await it.next()
    const b = await it.next()
    const c = await it.next()
    await it.return?.()

    expect([a.value, b.value, c.value]).toEqual([
      { event: 'sync.start', payload: { job_id: 'j2' } },
      { event: 'sync.account.start', payload: { account_id: 1 } },
      { event: 'sync.message', payload: { account_id: 1, message_id: 'm1' } },
    ])
  })

  it('ring drops the oldest after RING_CAPACITY emits', () => {
    for (let i = 0; i < RING_CAPACITY + 5; i++) {
      syncEvents.emit('tick', { i })
    }
    const recent = syncEvents.recent()
    expect(recent.length).toBe(RING_CAPACITY)
    expect((recent[0]?.payload as { i: number }).i).toBe(5)
    expect((recent[recent.length - 1]?.payload as { i: number }).i).toBe(RING_CAPACITY + 4)
  })

  it('recent() returns a snapshot — subsequent emits do not mutate the returned array', () => {
    syncEvents.emit('a', { n: 1 })
    syncEvents.emit('b', { n: 2 })
    const snap = syncEvents.recent()
    syncEvents.emit('c', { n: 3 })
    expect(snap.map((e) => e.event)).toEqual(['a', 'b'])
  })

  it('two subscribers each receive each event', async () => {
    const it1 = syncEvents.subscribe()[Symbol.asyncIterator]()
    const it2 = syncEvents.subscribe()[Symbol.asyncIterator]()

    const got1: string[] = []
    const got2: string[] = []
    const drain = async (
      iter: typeof it1,
      out: string[],
      n: number,
    ): Promise<void> => {
      for (let i = 0; i < n; i++) {
        const r = await iter.next()
        if (r.done) return
        out.push(r.value.event)
      }
    }
    const p = Promise.all([drain(it1, got1, 2), drain(it2, got2, 2)])

    syncEvents.emit('e1', {})
    syncEvents.emit('e2', {})

    await p
    await it1.return?.()
    await it2.return?.()

    expect(got1).toEqual(['e1', 'e2'])
    expect(got2).toEqual(['e1', 'e2'])
  })

  it('unsubscribing (calling return on the iterator) does not block subsequent emits', async () => {
    const it = syncEvents.subscribe()[Symbol.asyncIterator]()
    await it.return?.()

    // Emit lots of events after the iterator is closed; emit() should not
    // hang or throw because the closed subscriber's queue is no longer
    // consumed.
    expect(() => {
      for (let i = 0; i < 50; i++) {
        syncEvents.emit('tick', { i })
      }
    }).not.toThrow()
  })

  it('unsubscribing removes the subscriber from the active list', async () => {
    const it1 = syncEvents.subscribe()[Symbol.asyncIterator]()
    const it2 = syncEvents.subscribe()[Symbol.asyncIterator]()

    await it1.return?.()

    const got2: string[] = []
    const drain = (async () => {
      const r = await it2.next()
      if (!r.done) got2.push(r.value.event)
    })()

    syncEvents.emit('after-unsub', {})
    await drain
    await it2.return?.()

    expect(got2).toEqual(['after-unsub'])
  })
})
