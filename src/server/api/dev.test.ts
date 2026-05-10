import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { gmail_v1 } from 'googleapis'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailClient } from '../gmail/client.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

type ListResult = Awaited<ReturnType<GmailClient['listMessages']>>
type GetResult = Awaited<ReturnType<GmailClient['getMessage']>>

function makeGmailFixture(opts: {
  count: number
  subjectPrefix?: string
  fromValue?: string
  internalDateBase?: number
}): GmailClient {
  const messages: ListResult['messages'] = []
  const messageMap = new Map<string, GetResult>()
  const base = opts.internalDateBase ?? 1715000000000
  for (let i = 0; i < opts.count; i++) {
    const id = `msg-${i}`
    messages.push({ id, threadId: `thread-${i}` })
    messageMap.set(id, {
      id,
      threadId: `thread-${i}`,
      internalDate: `${base + i * 1000}`,
      payload: {
        headers: [
          { name: 'Subject', value: `${opts.subjectPrefix ?? 'Receipt'} ${i}` },
          { name: 'From', value: opts.fromValue ?? 'Stripe <noreply@stripe.com>' },
        ],
      },
    } as GetResult)
  }
  return {
    listMessages: async () => ({ messages }),
    getMessage: async (id) => messageMap.get(id) ?? ({} as GetResult),
    // Stub — dev-seed flow does not exercise attachments.
    getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
  }
}

function makeFailingClient(opts: {
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
      return {} as GetResult
    },
    getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
  }
}

async function buildTestApp(deps: {
  createGmailClient: (accountId: number) => GmailClient
}) {
  const { registerDevRoutes } = await import('./dev.js')
  const a = new Hono()
  registerDevRoutes(a, deps)
  return a
}

describe('dev API — production gate', () => {
  const originalNodeEnv = process.env.NODE_ENV
  let tempDir: string
  let dbModule: typeof import('../db/index.js')

  beforeEach(async () => {
    process.env.NODE_ENV = 'production'
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-dev-prod-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('GET /api/dev/enabled returns 404 in production', async () => {
    const app = await buildTestApp({
      createGmailClient: () => makeFailingClient({}),
    })
    const res = await app.fetch(new Request('http://x/api/dev/enabled'))
    expect(res.status).toBe(404)
  })

  it('POST /api/dev/processed-messages/seed returns 404 in production', async () => {
    const app = await buildTestApp({
      createGmailClient: () => makeFailingClient({}),
    })
    const res = await app.fetch(
      new Request('http://x/api/dev/processed-messages/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: 1, count: 10 }),
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('dev API — development mode', () => {
  const originalNodeEnv = process.env.NODE_ENV
  let tempDir: string
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let session: typeof import('../auth/session.js')
  let processedMessages: typeof import('../db/repositories/processed_messages.js')

  beforeEach(async () => {
    process.env.NODE_ENV = 'development'
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-dev-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')
    session = await import('../auth/session.js')
    processedMessages = await import('../db/repositories/processed_messages.js')
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
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

  function seedConnectedWithSession(email = 'alice@example.com'): number {
    const { id } = accounts.insert({
      email,
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
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

  describe('GET /api/dev/enabled', () => {
    it('returns 200 { enabled: true } in development', async () => {
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(new Request('http://x/api/dev/enabled'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true })
    })
  })

  describe('POST /api/dev/processed-messages/seed — body validation', () => {
    it('returns 400 on missing JSON body', async () => {
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', { method: 'POST' }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when account_id is missing', async () => {
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 5 }),
        }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when account_id is not a positive integer', async () => {
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: 0, count: 5 }),
        }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when count is 0', async () => {
      const id = seedConnectedWithSession()
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 0 }),
        }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when count is 11 (above limit of 10)', async () => {
      const id = seedConnectedWithSession()
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 11 }),
        }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when count is non-integer', async () => {
      const id = seedConnectedWithSession()
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 1.5 }),
        }),
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/dev/processed-messages/seed — account discriminators', () => {
    it('returns 404 when the account does not exist', async () => {
      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: 99999, count: 5 }),
        }),
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'account_not_found' })
    })

    it('returns 409 when the account is needs_reauth', async () => {
      const { id } = accounts.insert({
        email: 'alice@example.com',
        display_name: null,
        connected_at: '2026-05-09T10:00:00Z',
      })
      accounts.updateStatus(id, 'needs_reauth')

      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 5 }),
        }),
      )
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

      const app = await buildTestApp({
        createGmailClient: () => makeFailingClient({}),
      })
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 5 }),
        }),
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'account_not_connected',
        status: 'needs_reauth',
      })
      expect(accounts.findById(id)?.status).toBe('needs_reauth')
    })
  })

  describe('POST /api/dev/processed-messages/seed — happy path + idempotency', () => {
    it('inserts 10 rows on first call with the dev-seed defaults', async () => {
      const id = seedConnectedWithSession()
      const fixture = makeGmailFixture({ count: 10 })
      const app = await buildTestApp({ createGmailClient: () => fixture })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 10 }),
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ inserted: 10, skipped: 0 })

      const rows = processedMessages.listForAccount({ account_id: id, limit: 50 })
      expect(rows).toHaveLength(10)
      const sample = rows.find((r) => r.subject === 'Receipt 0')!
      expect(sample).toMatchObject({
        model_used: 'dev-seed',
        classification: 'other',
        confidence: 'low',
        status: 'success',
        sender_domain: 'stripe.com',
      })
      expect(typeof sample.processed_at).toBe('string')
      expect(sample.processed_at.length).toBeGreaterThan(0)
    })

    it('returns inserted: 0, skipped: 10 on a second call against the same fixture', async () => {
      const id = seedConnectedWithSession()
      const fixture = makeGmailFixture({ count: 10 })
      const app = await buildTestApp({ createGmailClient: () => fixture })

      await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 10 }),
        }),
      )
      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 10 }),
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ inserted: 0, skipped: 10 })
      expect(processedMessages.countForAccount({ account_id: id })).toBe(10)
    })

    it('extracts sender_domain from a bare-address From header', async () => {
      const id = seedConnectedWithSession()
      const fixture = makeGmailFixture({
        count: 1,
        fromValue: 'bare@example.com',
      })
      const app = await buildTestApp({ createGmailClient: () => fixture })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 1 }),
        }),
      )
      expect(res.status).toBe(200)
      const rows = processedMessages.listForAccount({ account_id: id, limit: 50 })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.sender_domain).toBe('example.com')
    })

    it('inserts a null sender_domain when the From header is empty', async () => {
      const id = seedConnectedWithSession()
      const fixture = makeGmailFixture({
        count: 1,
        fromValue: '',
      })
      const app = await buildTestApp({ createGmailClient: () => fixture })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 1 }),
        }),
      )
      expect(res.status).toBe(200)
      const rows = processedMessages.listForAccount({ account_id: id, limit: 50 })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.sender_domain).toBeNull()
    })
  })

  describe('POST /api/dev/processed-messages/seed — error mapping', () => {
    it('returns 401 needs_reauth when listMessages rejects with invalid_grant', async () => {
      const id = seedConnectedWithSession()
      const failing = makeFailingClient({
        list: () => {
          throw new Error('invalid_grant')
        },
      })
      const app = await buildTestApp({ createGmailClient: () => failing })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 5 }),
        }),
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'needs_reauth', account_id: id })
    })

    it('returns 502 with the message when listMessages rejects with a generic error', async () => {
      const id = seedConnectedWithSession()
      const failing = makeFailingClient({
        list: () => {
          throw new Error('rate limit')
        },
      })
      const app = await buildTestApp({ createGmailClient: () => failing })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 5 }),
        }),
      )
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'gmail_error', message: 'rate limit' })
    })

    it('returns 502 and inserts no rows when a per-message getMessage fails partway through the loop', async () => {
      const id = seedConnectedWithSession()
      const messages: ListResult['messages'] = []
      for (let i = 0; i < 5; i++) {
        messages.push({ id: `msg-${i}`, threadId: `thread-${i}` })
      }
      const failing: GmailClient = {
        listMessages: async () => ({ messages }),
        getMessage: async (mid) => {
          if (mid === 'msg-3') throw new Error('boom')
          return {
            id: mid,
            internalDate: '1715000000000',
            payload: {
              headers: [
                { name: 'Subject', value: `S ${mid}` },
                { name: 'From', value: 'noreply@example.com' },
              ],
            },
          } as gmail_v1.Schema$Message
        },
        getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      }
      const app = await buildTestApp({ createGmailClient: () => failing })

      const res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: id, count: 5 }),
        }),
      )
      expect(res.status).toBe(502)
      expect(processedMessages.countForAccount({ account_id: id })).toBe(0)
    })
  })

  describe('POST /api/dev/processed-messages/seed — cross-account isolation', () => {
    it('seeding account B leaves account A rows unchanged', async () => {
      const aliceId = seedConnectedWithSession('alice@example.com')
      const bobId = seedConnectedWithSession('bob@example.com')

      const fixtureA = makeGmailFixture({
        count: 3,
        subjectPrefix: 'Alice',
        fromValue: 'a@stripe.com',
      })
      const fixtureB = makeGmailFixture({
        count: 4,
        subjectPrefix: 'Bob',
        fromValue: 'b@aws.amazon.com',
      })

      const app = await buildTestApp({
        createGmailClient: (accountId) => {
          if (accountId === aliceId) return fixtureA
          if (accountId === bobId) return fixtureB
          return makeFailingClient({})
        },
      })

      let res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: aliceId, count: 3 }),
        }),
      )
      expect(res.status).toBe(200)

      res = await app.fetch(
        new Request('http://x/api/dev/processed-messages/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: bobId, count: 4 }),
        }),
      )
      expect(res.status).toBe(200)

      const aliceRows = processedMessages.listForAccount({
        account_id: aliceId,
        limit: 50,
      })
      const bobRows = processedMessages.listForAccount({
        account_id: bobId,
        limit: 50,
      })

      expect(aliceRows).toHaveLength(3)
      expect(bobRows).toHaveLength(4)
      expect(aliceRows.every((r) => (r.subject ?? '').startsWith('Alice'))).toBe(true)
      expect(bobRows.every((r) => (r.subject ?? '').startsWith('Bob'))).toBe(true)
    })
  })
})
