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

// `test-setup.ts` installs a no-op EventSource shim globally — SyncControls
// (rendered inside Dashboard) constructs one on mount. This file doesn't
// drive events; the global no-op is sufficient.

describe('Dashboard', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url === '/api/ollama/health') {
        return jsonResponse({
          reachable: true,
          model: 'qwen2.5vl:7b',
          model_available: true,
        })
      }
      if (typeof url === 'string' && url === '/api/sync/status') {
        return jsonResponse({ active: false })
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

  it('renders the SyncControls "Sync now" button between the OllamaHealth pill and the AccountList', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [aliceConnected] }))

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByText('alice@example.com'))
    expect(screen.getByRole('button', { name: /sync now/i })).toBeDefined()
  })

  it('clicking Reconnect calls POST /api/accounts/:id/reconnect and opens consent_url', async () => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/ollama/health')
        return jsonResponse({ reachable: true, model: 'qwen2.5vl:7b', model_available: true })
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
      if (url === '/api/ollama/health')
        return jsonResponse({ reachable: true, model: 'qwen2.5vl:7b', model_available: true })
      if (url === '/api/accounts') {
        accountsCallCount += 1
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
      if (url === '/api/ollama/health')
        return jsonResponse({ reachable: true, model: 'qwen2.5vl:7b', model_available: true })
      if (url === '/api/accounts') {
        accountsCallCount += 1
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

  it('renders the Ollama health badge', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [aliceConnected] }))

    render(<Dashboard pollIntervalMs={20} pollTimeoutMs={5000} />)

    await waitFor(() => screen.getByText('alice@example.com'))
    await waitFor(() => {
      const pill = screen.getByTestId('ollama-health-pill')
      expect(pill.getAttribute('data-state')).toBe('ready')
    })
    expect(screen.getByText(/ollama: qwen2\.5vl:7b ready/i)).toBeDefined()
  })
})
