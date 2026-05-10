import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSyncEvents } from './useSyncEvents.js'

// jsdom doesn't ship `EventSource`. Stub a minimal fake that records the URL,
// supports `addEventListener` / `removeEventListener` / `close`, and exposes a
// test-only `emit(name, payload)` helper that fires the named SSE event with a
// JSON-serialized payload — same shape `EventSource` delivers (`MessageEvent`
// with a `.data` string).
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(name)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(fn)
  }

  removeEventListener(name: string, fn: (ev: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.closed = true
  }

  emit(name: string, payload: unknown): void {
    const me = { data: JSON.stringify(payload) } as MessageEvent
    this.listeners.get(name)?.forEach((fn) => fn(me))
  }
}

const ORIGINAL_EVENT_SOURCE = (
  globalThis as { EventSource?: unknown }
).EventSource

beforeEach(() => {
  FakeEventSource.instances = []
  ;(globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource
})

afterEach(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = ORIGINAL_EVENT_SOURCE
})

function getInstance(): FakeEventSource {
  const inst = FakeEventSource.instances[0]
  if (inst === undefined) throw new Error('no EventSource was opened')
  return inst
}

describe('useSyncEvents', () => {
  it('opens an EventSource against /api/sync/events on mount', () => {
    const { result } = renderHook(() => useSyncEvents())
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(getInstance().url).toBe('/api/sync/events')
    expect(result.current).toEqual({ active: false, accounts: [] })
  })

  it('flips to active and seeds accounts on sync.start + sync.account.start', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1, 2],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
    })
    expect(result.current.active).toBe(true)
    expect(result.current.job_id).toBe('job-A')
    expect(result.current.accounts).toEqual([
      { account_id: 1, processed: 0, receipts: 0, failed: 0, in_progress: true },
    ])
  })

  it('increments processed + receipts on a successful sync.message with document_ids', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
        document_ids: [10],
      })
    })
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 1,
      receipts: 1,
      failed: 0,
      in_progress: true,
    })
  })

  it('increments processed but NOT receipts on a successful sync.message with no document_ids', () => {
    // Successful classify of a non-receipt email: orchestrator emits
    // status='success' but document_ids is empty.
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
        document_ids: [],
      })
    })
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 1,
      receipts: 0,
      failed: 0,
      in_progress: true,
    })
  })

  it('increments processed + failed on a failed sync.message', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'failed',
        document_ids: [],
        error_message: 'boom',
      })
    })
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 1,
      receipts: 0,
      failed: 1,
      in_progress: true,
    })
  })

  it('skipped messages do not bump any counter', () => {
    // Idempotency-skip emits sync.message status='skipped'; the per-job UI
    // counters reflect *new* work, so skipped doesn't count.
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'skipped',
        document_ids: [],
      })
    })
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 0,
      receipts: 0,
      failed: 0,
      in_progress: true,
    })
  })

  it('overrides counters with the orchestrator final values on sync.account.done', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
        document_ids: [10],
      })
      getInstance().emit('sync.account.done', {
        account_id: 1,
        processed: 12,
        receipts: 7,
        failed: 1,
      })
    })
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 12,
      receipts: 7,
      failed: 1,
      in_progress: false,
    })
  })

  it('flips active to false on sync.done', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.account.done', {
        account_id: 1,
        processed: 1,
        receipts: 1,
        failed: 0,
      })
      getInstance().emit('sync.done', { job_id: 'job-A' })
    })
    expect(result.current.active).toBe(false)
    // Final counters are preserved so the UI can keep showing the last run.
    expect(result.current.accounts[0]).toEqual({
      account_id: 1,
      processed: 1,
      receipts: 1,
      failed: 0,
      in_progress: false,
    })
  })

  it('tracks two accounts independently', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1, 2],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.account.start', { account_id: 2 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
        document_ids: [10],
      })
      getInstance().emit('sync.message', {
        account_id: 2,
        message_id: 'm9',
        status: 'failed',
        document_ids: [],
      })
    })
    const byId = new Map(result.current.accounts.map((a) => [a.account_id, a]))
    expect(byId.get(1)).toEqual({
      account_id: 1,
      processed: 1,
      receipts: 1,
      failed: 0,
      in_progress: true,
    })
    expect(byId.get(2)).toEqual({
      account_id: 2,
      processed: 1,
      receipts: 0,
      failed: 1,
      in_progress: true,
    })
  })

  it('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSyncEvents())
    const inst = getInstance()
    expect(inst.closed).toBe(false)
    unmount()
    expect(inst.closed).toBe(true)
  })

  it('starting a new run resets accounts but keeps active flag true', () => {
    const { result } = renderHook(() => useSyncEvents())
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.account.done', {
        account_id: 1,
        processed: 5,
        receipts: 5,
        failed: 0,
      })
      getInstance().emit('sync.done', { job_id: 'job-A' })
    })
    expect(result.current.active).toBe(false)
    act(() => {
      // A new run starts — the hook should reset its account snapshots so
      // counters from the previous run don't bleed into the new one.
      getInstance().emit('sync.start', {
        job_id: 'job-B',
        account_ids: [1],
        started_at: '2026-05-09T13:00:00.000Z',
      })
    })
    expect(result.current.active).toBe(true)
    expect(result.current.job_id).toBe('job-B')
    expect(result.current.accounts).toEqual([])
  })
})
