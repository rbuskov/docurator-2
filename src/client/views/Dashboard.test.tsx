import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dashboard } from './Dashboard.js'

const aliceConnected = {
  id: 1,
  email: 'alice@example.com',
  display_name: null,
  slug: 'alice-at-example-com',
  status: 'connected' as const,
  connected_at: '2026-05-09T10:00:00Z',
  last_seen_at: null,
}

const aliceNeedsReauth = {
  ...aliceConnected,
  status: 'needs_reauth' as const,
}

const bob = {
  id: 2,
  email: 'bob@example.com',
  display_name: null,
  slug: 'bob-at-example-com',
  status: 'connected' as const,
  connected_at: '2026-05-09T11:00:00Z',
  last_seen_at: null,
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Dashboard', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    // The Dashboard renders <DevSeedPanel /> once accounts have loaded.
    // The panel probes /api/dev/enabled on mount; most existing tests don't
    // care about the panel and want it invisible. Set the default
    // implementation to URL-route /api/dev/enabled → 404, so any call to
    // that path falls through to a 404 after the test's own
    // mockResolvedValueOnce chain (for /api/accounts etc.) is consumed.
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url === '/api/dev/enabled') {
        return jsonResponse({ error: 'not_found' }, 404)
      }
      throw new Error(`Unexpected fetch (no mock): ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading state on mount, then renders the accounts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [aliceConnected] }))

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    expect(screen.getByText(/loading/i)).toBeDefined()

    await waitFor(() => screen.getByText('alice@example.com'))
    expect(screen.getByRole('button', { name: /add gmail account/i })).toBeDefined()
  })

  it('renders the AccountList empty state when no accounts are connected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [] }))

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByText(/no accounts connected/i))
    expect(screen.getByRole('button', { name: /add gmail account/i })).toBeDefined()
  })

  it('clicking Reconnect calls POST /api/accounts/:id/reconnect and opens consent_url', async () => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled')
        return jsonResponse({ error: 'not_found' }, 404)
      if (url === '/api/accounts')
        return jsonResponse({ accounts: [aliceNeedsReauth] })
      if (url === '/api/accounts/1/reconnect' && init?.method === 'POST') {
        return jsonResponse({
          consent_url: 'https://accounts.google.com/oauth/v2/x',
          state: 's-rc',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByRole('button', { name: /reconnect/i }))
    await user.click(screen.getByRole('button', { name: /reconnect/i }))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/accounts/1/reconnect' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })

    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/oauth/v2/x',
      '_blank',
      expect.any(String),
    )
  })

  it('reconnect polling refreshes the list when the row flips back to connected', async () => {
    fetchMock.mockReset()
    let accountsCallCount = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled')
        return jsonResponse({ error: 'not_found' }, 404)
      if (url === '/api/accounts') {
        accountsCallCount += 1
        // Initial fetch + first poll: still needs_reauth.
        // Subsequent polls: now connected.
        if (accountsCallCount <= 2)
          return jsonResponse({ accounts: [aliceNeedsReauth] })
        return jsonResponse({ accounts: [aliceConnected] })
      }
      if (url === '/api/accounts/1/reconnect' && init?.method === 'POST') {
        return jsonResponse({
          consent_url: 'https://accounts.google.com/oauth/v2/x',
          state: 's-rc',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByRole('button', { name: /reconnect/i }))
    await user.click(screen.getByRole('button', { name: /reconnect/i }))

    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull()
      },
      { timeout: 1500 },
    )
  })

  it('appends a new account to the list when AddAccountButton.onAdded fires', async () => {
    fetchMock.mockReset()
    let accountsCallCount = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/dev/enabled')
        return jsonResponse({ error: 'not_found' }, 404)
      if (url === '/api/accounts') {
        accountsCallCount += 1
        // Initial fetch: just alice. After the OAuth start, polling sees both.
        if (accountsCallCount === 1) return jsonResponse({ accounts: [aliceConnected] })
        return jsonResponse({ accounts: [aliceConnected, bob] })
      }
      if (url === '/api/oauth/start' && init?.method === 'POST') {
        return jsonResponse({
          consent_url: 'https://accounts.google.com/oauth/v2/x',
          state: 's-add',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByText('alice@example.com'))
    await user.click(screen.getByRole('button', { name: /add gmail account/i }))

    await waitFor(
      () => {
        expect(screen.getByText('bob@example.com')).toBeDefined()
      },
      { timeout: 1500 },
    )
    expect(screen.getByText('alice@example.com')).toBeDefined()
  })

  it('shows an error if the initial fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
  })

  it('renders the Dev tools panel when /api/dev/enabled returns 200', async () => {
    // Override the beforeEach's queued 404 — this test wants the panel visible.
    // The /api/dev/enabled stub queued in beforeEach is consumed first (404),
    // then the dashboard's /api/accounts fetch consumes the next, then the
    // panel's /api/accounts (re-fetched after /api/dev/enabled resolves —
    // but actually the panel fetches /api/accounts independently). We use
    // mockImplementation here to URL-route everything so the order doesn't
    // matter.
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/dev/enabled') return jsonResponse({ enabled: true })
      if (url === '/api/accounts')
        return jsonResponse({ accounts: [aliceConnected] })
      if (url.startsWith('/api/accounts/1/processed-messages'))
        return jsonResponse({ rows: [] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByText('alice@example.com'))
    await waitFor(() =>
      screen.getByRole('heading', { name: /dev tools/i }),
    )
    expect(
      screen.getByRole('button', { name: /Mark first 10 messages as processed/i }),
    ).toBeDefined()
  })
})
