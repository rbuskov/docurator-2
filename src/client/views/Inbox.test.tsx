import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Message } from '../types.js'
import { Inbox, LAST_INBOX_ACCOUNT_KEY } from './Inbox.js'

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

const msgM1: Message = {
  id: 'm1',
  thread_id: 't1',
  subject: 'Stripe payout',
  from: 'Stripe <noreply@stripe.com>',
  date: 'Wed, 1 Jan 2025 00:00:00 +0000',
  internal_date: '1735689600000',
}

const msgM2: Message = {
  id: 'm2',
  thread_id: 't2',
  subject: 'AWS invoice',
  from: 'AWS <billing@aws.com>',
  date: 'Thu, 2 Jan 2025 00:00:00 +0000',
  internal_date: '1735776000000',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Inbox />
    </MemoryRouter>,
  )
}

describe('<Inbox />', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.localStorage.clear()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preselects the first connected account and renders its messages', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ messages: [msgM1, msgM2] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe payout'))
    expect(screen.getByText('Stripe payout')).toBeDefined()
    expect(screen.getByText('AWS invoice')).toBeDefined()
    expect(screen.getByText('Stripe <noreply@stripe.com>')).toBeDefined()
    expect(
      screen.getByText('Wed, 1 Jan 2025 00:00:00 +0000'),
    ).toBeDefined()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('initializes the picker from localStorage when the stored id is connected', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '2')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/2/messages'))
        return jsonResponse({ messages: [msgM2] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('AWS invoice'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('2')
  })

  it('falls back to the first connected account when localStorage points at a missing id', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '999')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ messages: [msgM1] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe payout'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('falls back to the first connected account when localStorage points at a needs_reauth row', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '3')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts')
        return jsonResponse({ accounts: [alice, bob, carol] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ messages: [msgM1] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe payout'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('changing the picker fetches the new accounts messages and persists the selection', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ messages: [msgM1] })
      if (url.startsWith('/api/accounts/2/messages'))
        return jsonResponse({ messages: [msgM2] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe payout'))
    await userEvent.selectOptions(screen.getByRole('combobox'), '2')

    await waitFor(() => screen.getByText('AWS invoice'))
    expect(screen.queryByText('Stripe payout')).toBeNull()
    expect(window.localStorage.getItem(LAST_INBOX_ACCOUNT_KEY)).toBe('2')
  })

  it('renders the needs_reauth error when the messages call returns 401', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ error: 'needs_reauth', account_id: 1 }, 401)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() =>
      screen.getByText(/this account needs to be reconnected/i),
    )
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeDefined()
  })

  it('renders the gmail_error message when the messages call returns 502', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/messages'))
        return jsonResponse({ error: 'gmail_error', message: 'quota exceeded' }, 502)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText(/quota exceeded/i))
    expect(screen.getByText(/gmail returned an error/i)).toBeDefined()
  })

  it('renders the empty state when no accounts are connected at all', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText(/no accounts connected/i))
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeDefined()
  })

  it('renders the AccountPicker empty state when only needs_reauth accounts exist', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [carol] })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() =>
      screen.getByText(/no connected accounts.*connect one on the dashboard/i),
    )
  })
})
