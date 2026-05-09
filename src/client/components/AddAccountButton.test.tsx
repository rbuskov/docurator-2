import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddAccountButton } from './AddAccountButton.js'

const baseAccount = {
  id: 1,
  email: 'alice@example.com',
  display_name: null,
  slug: 'alice-at-example-com',
  status: 'connected' as const,
  connected_at: '2026-05-09T10:00:00Z',
  last_seen_at: null,
}

const newAccount = {
  id: 2,
  email: 'bob@example.com',
  display_name: null,
  slug: 'bob-at-example-com',
  status: 'connected' as const,
  connected_at: '2026-05-09T11:00:00Z',
  last_seen_at: null,
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AddAccountButton', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clicking calls POST /api/oauth/start, opens consent_url, and starts polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ consent_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 's1' }),
    )
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [baseAccount] }))

    const user = userEvent.setup()
    render(
      <AddAccountButton
        baselineIds={[baseAccount.id]}
        onAdded={() => {}}
        pollIntervalMs={20}
        pollTimeoutMs={5000}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add gmail account/i }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/oauth/start',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      '_blank',
      expect.any(String),
    )

    await waitFor(
      () => {
        expect(
          fetchMock.mock.calls.some(([url]) => url === '/api/accounts'),
        ).toBe(true)
      },
      { timeout: 500 },
    )
  })

  it('fires onAdded with the newly-appearing account and stops polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ consent_url: 'https://accounts.google.com/o/oauth2/v2/auth', state: 's1' }),
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [baseAccount] }))
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [baseAccount, newAccount] }))

    const onAdded = vi.fn()
    const user = userEvent.setup()
    render(
      <AddAccountButton
        baselineIds={[baseAccount.id]}
        onAdded={onAdded}
        pollIntervalMs={20}
        pollTimeoutMs={5000}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add gmail account/i }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(newAccount), { timeout: 1000 })

    const callsAfterMatch = fetchMock.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fetchMock.mock.calls.length).toBe(callsAfterMatch)
  })

  it('shows an error and stops polling after the timeout', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ consent_url: 'https://accounts.google.com/o/oauth2/v2/auth', state: 's1' }),
    )
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [baseAccount] }))

    const user = userEvent.setup()
    render(
      <AddAccountButton
        baselineIds={[baseAccount.id]}
        onAdded={() => {}}
        pollIntervalMs={10}
        pollTimeoutMs={50}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add gmail account/i }))

    await waitFor(
      () => {
        expect(screen.getByRole('alert').textContent).toMatch(/took too long|try again/i)
      },
      { timeout: 1000 },
    )

    const callsAfterTimeout = fetchMock.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fetchMock.mock.calls.length).toBe(callsAfterTimeout)
  })

  it('surfaces an error if POST /api/oauth/start fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))

    const user = userEvent.setup()
    render(<AddAccountButton baselineIds={[]} onAdded={() => {}} />)

    await user.click(screen.getByRole('button', { name: /add gmail account/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined(), { timeout: 500 })
    expect(window.open).not.toHaveBeenCalled()
  })
})
