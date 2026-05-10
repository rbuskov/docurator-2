import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncControls } from './SyncControls.js'

// Same fake-EventSource shape as useSyncEvents.test.ts. Driving events through
// the real `useSyncEvents` hook gives the component an integration test
// rather than a mock of the hook layer.
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

const ORIGINAL_EVENT_SOURCE = (globalThis as { EventSource?: unknown }).EventSource

describe('SyncControls', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    FakeEventSource.instances = []
    ;(globalThis as { EventSource?: unknown }).EventSource =
      FakeEventSource as unknown as typeof EventSource
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    ;(globalThis as { EventSource?: unknown }).EventSource = ORIGINAL_EVENT_SOURCE
    vi.restoreAllMocks()
  })

  function getInstance(): FakeEventSource {
    const inst = FakeEventSource.instances[0]
    if (inst === undefined) throw new Error('no EventSource was opened')
    return inst
  }

  it('renders the "Sync now" button when no job is active', () => {
    render(<SyncControls />)
    const btn = screen.getByRole('button', { name: /sync now/i })
    expect(btn).toBeDefined()
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it('clicking POSTs /api/sync with an empty body and disables the button on 202', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 'job-1', started_at: '2026-05-09T12:00:00.000Z' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const user = userEvent.setup()
    render(<SyncControls />)
    const btn = screen.getByRole('button', { name: /sync now/i })
    await user.click(btn)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/sync')
    const initObj = init as RequestInit
    expect(initObj.method).toBe('POST')
    expect(initObj.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    )
    expect(initObj.body).toBe(JSON.stringify({}))

    // Button flips to disabled / "Syncing…" until the SSE confirms a sync.done.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /syncing/i })).toBeDefined()
    })
    expect((screen.getByRole('button', { name: /syncing/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('renders per-account counters from the SSE stream while a job is active', () => {
    render(<SyncControls />)

    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1, 2],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
        document_ids: [10],
      })
      getInstance().emit('sync.message', {
        account_id: 1,
        message_id: 'm2',
        status: 'failed',
        document_ids: [],
      })
      getInstance().emit('sync.account.start', { account_id: 2 })
    })

    // Disabled because a sync is active per the SSE stream.
    const btn = screen.getByRole('button', { name: /syncing/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    const counters = screen.getByTestId('sync-account-counters')
    const account1 = counters.querySelector('[data-account-id="1"]') as HTMLElement | null
    const account2 = counters.querySelector('[data-account-id="2"]') as HTMLElement | null
    expect(account1?.textContent ?? '').toMatch(/account 1.*2 processed.*1 receipts.*1 failed/i)
    expect(account2?.textContent ?? '').toMatch(/account 2.*0 processed.*0 receipts.*0 failed/i)
  })

  it('re-enables the button on sync.done', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 'job-A', started_at: '2026-05-09T12:00:00.000Z' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const user = userEvent.setup()
    render(<SyncControls />)
    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /syncing/i })).toBeDefined()
    })

    // Real SSE events arrive across separate ticks; split the run-then-finish
    // sequence into two act() blocks so React's effects observe the
    // intermediate `sync.active` true state and not just the final false one.
    act(() => {
      getInstance().emit('sync.start', {
        job_id: 'job-A',
        account_ids: [1],
        started_at: '2026-05-09T12:00:00.000Z',
      })
      getInstance().emit('sync.account.start', { account_id: 1 })
    })
    act(() => {
      getInstance().emit('sync.account.done', {
        account_id: 1,
        processed: 1,
        receipts: 1,
        failed: 0,
      })
      getInstance().emit('sync.done', { job_id: 'job-A' })
    })

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: /sync now/i }) as HTMLButtonElement).disabled,
      ).toBe(false)
    })
  })

  it('shows an error and re-enables the button when POST /api/sync fails with non-202/409', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    const user = userEvent.setup()
    render(<SyncControls />)
    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(
      (screen.getByRole('button', { name: /sync now/i }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('keeps the button disabled on 409 sync_in_progress (the in-flight job is reflected via SSE)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'sync_in_progress', job_id: 'other-job' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const user = userEvent.setup()
    render(<SyncControls />)
    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /syncing/i })).toBeDefined()
    })
    expect(
      (screen.getByRole('button', { name: /syncing/i }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
