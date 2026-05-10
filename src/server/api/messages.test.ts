import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailClient } from '../gmail/client.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

type ListResult = Awaited<ReturnType<GmailClient['listMessages']>>
type GetResult = Awaited<ReturnType<GmailClient['getMessage']>>

function makeFakeClient(opts: {
  list?: () => Promise<ListResult> | ListResult
  get?: (id: string) => Promise<GetResult> | GetResult
}): GmailClient {
  return {
    listMessages: async () => {
      if (opts.list) return opts.list()
      return { messages: [] }
    },
    getMessage: async (id) => {
      if (opts.get) return opts.get(id)
      return {}
    },
    // Stubs — no test in this file exercises these.
    getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
    historyList: async () => ({ history: [] }),
    getProfile: async () => ({
      email_address: null,
      history_id: null,
      messages_total: null,
      threads_total: null,
    }),
  }
}

describe('GET /api/accounts/:id/messages', () => {
  let tempDir: string
  let app: Hono
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let session: typeof import('../auth/session.js')

  async function buildApp(deps: {
    createGmailClient: (accountId: number) => GmailClient
  }) {
    const { registerMessagesRoutes } = await import('./messages.js')
    const a = new Hono()
    registerMessagesRoutes(a, deps)
    return a
  }

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-api-messages-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')
    session = await import('../auth/session.js')
  })

  afterEach(() => {
    try {
      session.clearAllForTest()
    } catch {
      // ignore
    }
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedConnectedWithSession(): number {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    // Use the test factory to avoid touching real OAuth2Client.
    session.setSessionClientFactoryForTest(() => ({
      setCredentials: () => undefined,
      on: () => undefined,
      getAccessToken: async () => ({ token: 'fake' }),
    }))
    session.set(id, {
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: 't',
        expiry_date: Date.now() + 3600_000,
      },
    })
    return id
  }

  it('returns 404 when no row exists for the given integer id', async () => {
    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(new Request('http://x/api/accounts/12345/messages'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'account_not_found' })
  })

  it('returns 400 for a non-integer id', async () => {
    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(new Request('http://x/api/accounts/abc/messages'))
    expect(res.status).toBe(400)
  })

  it('returns 409 when the account exists but is needs_reauth', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    accounts.updateStatus(id, 'needs_reauth')

    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'account_not_connected',
      status: 'needs_reauth',
    })
  })

  it('flips a connected-but-no-session account to needs_reauth and returns 409', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    // Account is `connected` per DB but no session entry (e.g. after a container restart).

    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'account_not_connected',
      status: 'needs_reauth',
    })
    expect(accounts.findById(id)?.status).toBe('needs_reauth')
  })

  it('returns 200 with the documented message shape on the happy path', async () => {
    const id = seedConnectedWithSession()
    const fakeClient = makeFakeClient({
      list: () => ({
        messages: [
          { id: 'm1', threadId: 't1' },
          { id: 'm2', threadId: 't2' },
        ],
      }),
      get: (mid) => {
        if (mid === 'm1') {
          return {
            id: 'm1',
            threadId: 't1',
            internalDate: '1735689600000',
            payload: {
              headers: [
                { name: 'Subject', value: 'Stripe payout' },
                { name: 'From', value: 'Stripe <noreply@stripe.com>' },
                { name: 'Date', value: 'Wed, 1 Jan 2025 00:00:00 +0000' },
              ],
            },
          }
        }
        return {
          id: 'm2',
          threadId: 't2',
          internalDate: '1735776000000',
          payload: {
            headers: [
              { name: 'Subject', value: 'AWS invoice' },
              { name: 'From', value: 'AWS <billing@aws.com>' },
              { name: 'Date', value: 'Thu, 2 Jan 2025 00:00:00 +0000' },
            ],
          },
        }
      },
    })

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messages: [
        {
          id: 'm1',
          thread_id: 't1',
          subject: 'Stripe payout',
          from: 'Stripe <noreply@stripe.com>',
          date: 'Wed, 1 Jan 2025 00:00:00 +0000',
          internal_date: '1735689600000',
        },
        {
          id: 'm2',
          thread_id: 't2',
          subject: 'AWS invoice',
          from: 'AWS <billing@aws.com>',
          date: 'Thu, 2 Jan 2025 00:00:00 +0000',
          internal_date: '1735776000000',
        },
      ],
    })
  })

  it('treats missing headers as empty strings', async () => {
    const id = seedConnectedWithSession()
    const fakeClient = makeFakeClient({
      list: () => ({ messages: [{ id: 'm1', threadId: 't1' }] }),
      get: () => ({
        id: 'm1',
        threadId: 't1',
        internalDate: '1735689600000',
        payload: {
          headers: [{ name: 'From', value: 'a@b.com' }],
        },
      }),
    })

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    const body = (await res.json()) as { messages: Array<Record<string, string>> }
    expect(body.messages[0]).toEqual({
      id: 'm1',
      thread_id: 't1',
      subject: '',
      from: 'a@b.com',
      date: '',
      internal_date: '1735689600000',
    })
  })

  it('reads headers case-insensitively', async () => {
    const id = seedConnectedWithSession()
    const fakeClient = makeFakeClient({
      list: () => ({ messages: [{ id: 'm1', threadId: 't1' }] }),
      get: () => ({
        id: 'm1',
        threadId: 't1',
        internalDate: '1735689600000',
        payload: {
          headers: [
            { name: 'subject', value: 'lowercase subject' },
            { name: 'FROM', value: 'shout@example.com' },
            { name: 'date', value: 'whenever' },
          ],
        },
      }),
    })

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    const body = (await res.json()) as { messages: Array<Record<string, string>> }
    expect(body.messages[0]?.subject).toBe('lowercase subject')
    expect(body.messages[0]?.from).toBe('shout@example.com')
    expect(body.messages[0]?.date).toBe('whenever')
  })

  it('rejects ?limit=0 with 400', async () => {
    const id = seedConnectedWithSession()
    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages?limit=0`),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_limit' })
  })

  it('rejects ?limit=200 with 400', async () => {
    const id = seedConnectedWithSession()
    app = await buildApp({ createGmailClient: () => makeFakeClient({}) })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages?limit=200`),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_limit' })
  })

  it('passes ?limit=25 through to gmail.listMessages', async () => {
    const id = seedConnectedWithSession()
    let lastMaxResults: number | undefined
    const fakeClient: GmailClient = {
      listMessages: async (args) => {
        lastMaxResults = args.maxResults
        return { messages: [] }
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages?limit=25`),
    )
    expect(res.status).toBe(200)
    expect(lastMaxResults).toBe(25)
  })

  it('returns 401 needs_reauth when listMessages rejects with invalid_grant', async () => {
    const id = seedConnectedWithSession()
    const fakeClient: GmailClient = {
      listMessages: async () => {
        throw new Error('invalid_grant: token revoked')
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'needs_reauth', account_id: id })
  })

  it('returns 502 gmail_error for non-invalid_grant errors from listMessages', async () => {
    const id = seedConnectedWithSession()
    const fakeClient: GmailClient = {
      listMessages: async () => {
        throw new Error('quotaExceeded: rate limit')
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'gmail_error',
      message: 'quotaExceeded: rate limit',
    })
  })

  it('returns 502 gmail_error when a per-message getMessage call fails', async () => {
    const id = seedConnectedWithSession()
    const fakeClient: GmailClient = {
      listMessages: async () => ({
        messages: [
          { id: 'm1', threadId: 't1' },
          { id: 'm2', threadId: 't2' },
        ],
      }),
      getMessage: async (mid) => {
        if (mid === 'm1') {
          return {
            id: 'm1',
            threadId: 't1',
            payload: { headers: [] },
            internalDate: '1',
          }
        }
        throw new Error('Gmail 500: something broke')
      },
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'gmail_error',
      message: 'Gmail 500: something broke',
    })
  })

  it('defaults ?limit to 50 when omitted', async () => {
    const id = seedConnectedWithSession()
    let lastMaxResults: number | undefined
    const fakeClient: GmailClient = {
      listMessages: async (args) => {
        lastMaxResults = args.maxResults
        return { messages: [] }
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }

    app = await buildApp({ createGmailClient: () => fakeClient })
    const res = await app.fetch(new Request(`http://x/api/accounts/${id}/messages`))
    expect(res.status).toBe(200)
    expect(lastMaxResults).toBe(50)
  })
})
