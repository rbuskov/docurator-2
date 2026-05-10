import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Document } from '../types.js'
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

const stripeDoc: Document = {
  id: 101,
  account_id: 1,
  message_id: 'm-stripe',
  kind: 'attachment',
  filename: 'stripe-payout.pdf',
  mime_type: 'application/pdf',
  size: 24_576,
  content_hash: 'a'.repeat(64),
  file_path: 'alice-at-example-com/2026/05/m-stripe-0-stripe-payout.pdf',
  vendor: 'Stripe',
  amount: 1234.56,
  currency: 'USD',
  transaction_date: '2026-05-08',
  review_status: 'pending',
  created_at: '2026-05-09T10:30:00.000Z',
  updated_at: '2026-05-09T10:30:00.000Z',
  classification: 'receipt',
  confidence: 'high',
  subject: 'Stripe payout 2026-05-08',
  sender_domain: 'stripe.com',
}

const awsDoc: Document = {
  id: 102,
  account_id: 1,
  message_id: 'm-aws',
  kind: 'attachment',
  filename: 'aws-invoice.pdf',
  mime_type: 'application/pdf',
  size: 92_240,
  content_hash: 'b'.repeat(64),
  file_path: 'alice-at-example-com/2026/05/m-aws-0-aws-invoice.pdf',
  vendor: 'AWS',
  amount: 9001,
  currency: 'USD',
  transaction_date: '2026-05-01',
  review_status: 'pending',
  created_at: '2026-05-09T10:31:00.000Z',
  updated_at: '2026-05-09T10:31:00.000Z',
  classification: 'invoice',
  confidence: 'medium',
  subject: 'AWS invoice — May 2026',
  sender_domain: 'aws.com',
}

const bobDoc: Document = {
  ...stripeDoc,
  id: 201,
  account_id: 2,
  message_id: 'm-bob',
  filename: 'bob-receipt.pdf',
  file_path: 'bob-at-example-com/2026/05/m-bob-0-bob-receipt.pdf',
  vendor: 'Patreon',
  amount: 5,
  currency: 'EUR',
  subject: 'Patreon membership — May 2026',
  sender_domain: 'patreon.com',
}

const partialDoc: Document = {
  ...stripeDoc,
  id: 103,
  message_id: 'm-partial',
  filename: 'unknown.pdf',
  file_path: 'alice-at-example-com/2026/05/m-partial-0-unknown.pdf',
  vendor: null,
  amount: null,
  currency: null,
  transaction_date: null,
  classification: null,
  confidence: null,
  subject: null,
  sender_domain: null,
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

  it('preselects the first connected account and renders its documents with all columns', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [stripeDoc, awsDoc], total: 2 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe'))
    // Vendor / Amount / Currency / Transaction Date / Subject / Sender Domain / Created At / Preview
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual([
      'Vendor',
      'Amount',
      'Currency',
      'Transaction Date',
      'Subject',
      'Sender Domain',
      'Created At',
      'Preview',
    ])

    expect(screen.getByText('Stripe')).toBeDefined()
    expect(screen.getByText('AWS')).toBeDefined()
    expect(screen.getByText('1234.56')).toBeDefined()
    expect(screen.getByText('9001')).toBeDefined()
    expect(screen.getAllByText('USD').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('2026-05-08')).toBeDefined()
    expect(screen.getByText('2026-05-01')).toBeDefined()
    expect(screen.getByText('Stripe payout 2026-05-08')).toBeDefined()
    expect(screen.getByText('AWS invoice — May 2026')).toBeDefined()
    expect(screen.getByText('stripe.com')).toBeDefined()
    expect(screen.getByText('aws.com')).toBeDefined()

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('renders a Preview link per row that points at /api/documents/:id/file', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [stripeDoc, awsDoc], total: 2 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe'))
    const links = screen.getAllByRole('link', { name: /preview/i })
    expect(links).toHaveLength(2)
    expect((links[0] as HTMLAnchorElement).getAttribute('href')).toBe('/api/documents/101/file')
    expect((links[1] as HTMLAnchorElement).getAttribute('href')).toBe('/api/documents/102/file')
    expect((links[0] as HTMLAnchorElement).getAttribute('target')).toBe('_blank')
    expect((links[0] as HTMLAnchorElement).getAttribute('rel')).toMatch(/noopener|noreferrer/)
  })

  it('renders em-dashes (—) for null vendor / amount / currency / transaction_date / subject / sender_domain', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [partialDoc], total: 1 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByRole('link', { name: /preview/i }))
    // 6 nullable fields × 1 row = 6 em-dashes (Created At always present).
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBe(6)
  })

  it('renders the empty state when the documents response is { rows: [], total: 0 }', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [], total: 0 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText(/no documents yet/i))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('initializes the picker from localStorage when the stored id is connected', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '2')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/2/documents'))
        return jsonResponse({ rows: [bobDoc], total: 1 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Patreon'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('2')
  })

  it('falls back to the first connected account when localStorage points at a missing id', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '999')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [stripeDoc], total: 1 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('falls back to the first connected account when localStorage points at a needs_reauth row', async () => {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, '3')
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob, carol] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [stripeDoc], total: 1 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe'))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('1')
  })

  it('changing the picker fetches the new accounts documents and persists the selection', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice, bob] })
      if (url.startsWith('/api/accounts/1/documents'))
        return jsonResponse({ rows: [stripeDoc], total: 1 })
      if (url.startsWith('/api/accounts/2/documents'))
        return jsonResponse({ rows: [bobDoc], total: 1 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByText('Stripe'))
    await userEvent.selectOptions(screen.getByRole('combobox'), '2')

    await waitFor(() => screen.getByText('Patreon'))
    expect(screen.queryByText('Stripe')).toBeNull()
    expect(window.localStorage.getItem(LAST_INBOX_ACCOUNT_KEY)).toBe('2')
  })

  it('renders an unexpected-error message when the documents call returns a non-2xx status', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/accounts') return jsonResponse({ accounts: [alice] })
      if (url.startsWith('/api/accounts/1/documents'))
        return new Response('boom', { status: 500 })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderInbox()

    await waitFor(() => screen.getByRole('alert'))
    expect(screen.getByRole('alert').textContent).toMatch(/unexpected error.*500/i)
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
