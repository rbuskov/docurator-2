import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, ProcessedMessage } from '../types.js'
import { DevSeedPanel } from './DevSeedPanel.js'

const alice: Account = {
  id: 1,
  email: 'alice@example.com',
  display_name: null,
  slug: 'alice-at-example-com',
  connected_at: '2026-05-09T10:00:00Z',
  last_seen_at: null,
  status: 'connected',
}

const bob: Account = {
  id: 2,
  email: 'bob@example.com',
  display_name: null,
  slug: 'bob-at-example-com',
  connected_at: '2026-05-09T11:00:00Z',
  last_seen_at: null,
  status: 'connected',
}

const carol: Account = {
  id: 3,
  email: 'carol@example.com',
  display_name: null,
  slug: 'carol-at-example-com',
  connected_at: '2026-05-09T12:00:00Z',
  last_seen_at: null,
  status: 'needs_reauth',
}

const row1: ProcessedMessage = {
  message_id: 'msg-1',
  thread_id: 't1',
  internal_date: '1715000000000',
  processed_at: '2026-05-09T10:00:00Z',
  model_used: 'dev-seed',
  status: 'success',
  classification: 'other',
  confidence: 'low',
  sender_domain: 'stripe.com',
  subject: 'Receipt 1',
}

const row2: ProcessedMessage = {
  message_id: 'msg-2',
  thread_id: 't2',
  internal_date: '1715000001000',
  processed_at: '2026-05-09T10:00:01Z',
  model_used: 'dev-seed',
  status: 'success',
  classification: 'other',
  confidence: 'low',
  sender_domain: 'aws.com',
  subject: 'AWS receipt',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('<DevSeedPanel />', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing when /api/dev/enabled returns 404', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/dev/enabled') return jsonResponse({ error: 'not_found' }, 404)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const { container } = render(<DevSeedPanel />)
    // Wait one tick so the dev-enabled probe completes.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/dev/enabled'))
    expect(container.firstChild).toBeNull()
  })

  it('renders the picker, button, and table when enabled', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)

    await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    expect(screen.getByRole('combobox', { name: /account/i })).toBeDefined()
    await waitFor(() =>
      screen.getByText(/No rows yet for this account\./i),
    )
  })

  it('renders rows from /api/accounts/:id/processed-messages', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [row1, row2] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)

    await waitFor(() => screen.getByText('Receipt 1'))
    expect(screen.getByText('AWS receipt')).toBeDefined()
    expect(screen.getByText('stripe.com')).toBeDefined()
    expect(screen.getByText('aws.com')).toBeDefined()
  })

  it('seeds and renders inserted/skipped status, then refetches the table', async () => {
    let secondFetch = false
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages')) {
        if (!secondFetch) return jsonResponse({ rows: [] })
        return jsonResponse({ rows: [row1, row2] })
      }
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        secondFetch = true
        return jsonResponse({ inserted: 10, skipped: 0 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)

    const button = await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    await userEvent.click(button)

    await waitFor(() => screen.getByText(/inserted 10, skipped 0/i))
    await waitFor(() => screen.getByText('Receipt 1'))
  })

  it('shows the inserted: 0, skipped: 10 status on a no-op call', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [row1, row2] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        return jsonResponse({ inserted: 0, skipped: 10 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    const button = await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    await userEvent.click(button)
    await waitFor(() => screen.getByText(/inserted 0, skipped 10/i))
  })

  it('shows the needs_reauth message on a 401', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        return jsonResponse({ error: 'needs_reauth', account_id: 1 }, 401)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    const button = await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    await userEvent.click(button)
    await waitFor(() => screen.getByText(/needs to be reconnected/i))
  })

  it('shows the gmail_error message on a 502', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        return jsonResponse({ error: 'gmail_error', message: 'rate limit' }, 502)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    const button = await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    await userEvent.click(button)
    await waitFor(() => screen.getByText(/Gmail returned an error: rate limit/i))
  })

  it('shows the not_connected message on a 409', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        return jsonResponse(
          { error: 'account_not_connected', status: 'needs_reauth' },
          409,
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    const button = await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )
    await userEvent.click(button)
    await waitFor(() => screen.getByText(/Account is not currently connected/i))
  })

  it('refetches the table when the picker changes and clears the prior status', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts')
        return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [row1] })
      if (url.startsWith('/api/accounts/2/processed-messages'))
        return jsonResponse({ rows: [row2] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        return jsonResponse({ inserted: 1, skipped: 0 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    await waitFor(() => screen.getByText('Receipt 1'))

    const button = screen.getByRole('button', {
      name: /Mark first 10 messages as processed/i,
    })
    await userEvent.click(button)
    await waitFor(() => screen.getByText(/inserted 1, skipped 0/i))

    const select = screen.getByRole('combobox', { name: /account/i }) as HTMLSelectElement
    await userEvent.selectOptions(select, '2')

    await waitFor(() => screen.getByText('AWS receipt'))
    expect(screen.queryByText(/inserted 1, skipped 0/i)).toBeNull()
  })

  it('disables the seed button while a seed request is in flight', async () => {
    let release!: (value: unknown) => void
    const inFlight = new Promise((resolve) => {
      release = resolve
    })
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      if (url === '/api/dev/processed-messages/seed' && init?.method === 'POST') {
        await inFlight
        return jsonResponse({ inserted: 10, skipped: 0 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    const button = (await waitFor(() =>
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    )) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await userEvent.click(button)
    await waitFor(() => expect(button.disabled).toBe(true))

    release(undefined)

    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('renders the AccountPicker empty state when only needs_reauth accounts exist', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts') return jsonResponse({ accounts: [carol] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<DevSeedPanel />)
    await waitFor(() =>
      screen.getByText(/No connected accounts\. Connect one on the Dashboard\./i),
    )
    expect(
      screen.queryByRole('button', { name: /Mark first 10 messages as processed/i }),
    ).toBeNull()
  })
})
