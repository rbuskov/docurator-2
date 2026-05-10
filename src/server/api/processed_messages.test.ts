import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('GET /api/accounts/:id/processed-messages', () => {
  let tempDir: string
  let app: Hono
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let processedMessages: typeof import('../db/repositories/processed_messages.js')

  async function buildApp() {
    const { registerProcessedMessagesRoutes } = await import('./processed_messages.js')
    const a = new Hono()
    registerProcessedMessagesRoutes(a)
    return a
  }

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-api-processed-messages-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')
    processedMessages = await import('../db/repositories/processed_messages.js')
    app = await buildApp()
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function insertAccount(email = 'alice@example.com'): number {
    const { id } = accounts.insert({
      email,
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    return id
  }

  function seedRow(
    accountId: number,
    overrides: Partial<
      import('../db/repositories/processed_messages.js').ProcessedMessageInput
    > = {},
  ): void {
    processedMessages.insert({
      account_id: accountId,
      message_id: 'm1',
      thread_id: 't1',
      internal_date: '1715000000000',
      processed_at: '2026-05-09T10:00:00Z',
      model_used: 'dev-seed',
      status: 'success',
      error_message: null,
      classification: 'other',
      confidence: 'low',
      reason: null,
      sender_domain: 'example.com',
      subject: 'hello',
      ...overrides,
    })
  }

  it('returns 400 for a non-integer id', async () => {
    const res = await app.fetch(
      new Request('http://x/api/accounts/abc/processed-messages'),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for id <= 0', async () => {
    const res = await app.fetch(
      new Request('http://x/api/accounts/0/processed-messages'),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the account does not exist', async () => {
    const res = await app.fetch(
      new Request('http://x/api/accounts/99999/processed-messages'),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'account_not_found' })
  })

  it('returns 200 { rows: [] } when the account has no processed_messages', async () => {
    const id = insertAccount()
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages`),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [] })
  })

  it('returns the 10 spec-named fields per row', async () => {
    const id = insertAccount()
    seedRow(id, {
      message_id: 'msg-1',
      subject: 'Receipt',
      sender_domain: 'stripe.com',
      classification: 'receipt',
      confidence: 'high',
      model_used: 'qwen2.5vl:7b',
    })

    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> }
    expect(body.rows).toHaveLength(1)
    expect(Object.keys(body.rows[0]!).sort()).toEqual([
      'classification',
      'confidence',
      'internal_date',
      'message_id',
      'model_used',
      'processed_at',
      'sender_domain',
      'status',
      'subject',
      'thread_id',
    ])
    expect(body.rows[0]).toMatchObject({
      message_id: 'msg-1',
      subject: 'Receipt',
      sender_domain: 'stripe.com',
      classification: 'receipt',
      confidence: 'high',
      model_used: 'qwen2.5vl:7b',
      status: 'success',
    })
  })

  it('returns rows ordered by processed_at DESC', async () => {
    const id = insertAccount()
    seedRow(id, { message_id: 'oldest', processed_at: '2026-05-09T08:00:00Z' })
    seedRow(id, { message_id: 'newest', processed_at: '2026-05-09T12:00:00Z' })
    seedRow(id, { message_id: 'middle', processed_at: '2026-05-09T10:00:00Z' })

    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages`),
    )
    const body = (await res.json()) as {
      rows: Array<{ message_id: string }>
    }
    expect(body.rows.map((r) => r.message_id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
  })

  it('returns 400 when ?limit is above 50', async () => {
    const id = insertAccount()
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages?limit=200`),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when ?limit is 0', async () => {
    const id = insertAccount()
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages?limit=0`),
    )
    expect(res.status).toBe(400)
  })

  it('respects ?limit when smaller than the row count', async () => {
    const id = insertAccount()
    for (let i = 0; i < 5; i++) {
      seedRow(id, {
        message_id: `m-${i}`,
        processed_at: `2026-05-09T1${i}:00:00Z`,
      })
    }
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages?limit=2`),
    )
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toHaveLength(2)
  })

  it('caps results at 50 by default', async () => {
    const id = insertAccount()
    for (let i = 0; i < 60; i++) {
      seedRow(id, {
        message_id: `m-${i}`,
        // Distinct processed_at values so ordering is deterministic.
        processed_at: `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`,
      })
    }
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages`),
    )
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toHaveLength(50)
  })

  it('is account-scoped — rows under another account are not returned', async () => {
    const aliceId = insertAccount('alice@example.com')
    const bobId = insertAccount('bob@example.com')
    seedRow(aliceId, { message_id: 'mine' })
    seedRow(bobId, { message_id: 'theirs' })

    const res = await app.fetch(
      new Request(`http://x/api/accounts/${aliceId}/processed-messages`),
    )
    const body = (await res.json()) as { rows: Array<{ message_id: string }> }
    expect(body.rows.map((r) => r.message_id)).toEqual(['mine'])
  })

  it('returns rows even for an account in needs_reauth state', async () => {
    const id = insertAccount()
    seedRow(id, { message_id: 'msg-1' })
    accounts.updateStatus(id, 'needs_reauth')

    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/processed-messages`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: Array<{ message_id: string }> }
    expect(body.rows.map((r) => r.message_id)).toEqual(['msg-1'])
  })
})
