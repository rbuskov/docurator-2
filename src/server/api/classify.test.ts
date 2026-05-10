import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClassifyResponse } from '../classify/index.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

type ClassifyFn = (args: unknown, deps: unknown) => Promise<ClassifyResponse>

describe('POST /api/accounts/:id/messages/:message_id/classify', () => {
  let tempDir: string
  let app: Hono
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let session: typeof import('../auth/session.js')
  let processedMessages: typeof import('../db/repositories/processed_messages.js')
  let ollamaErrors: typeof import('../classify/ollama.js')

  async function buildApp(deps: { classifyMessage: ClassifyFn }) {
    const { registerClassifyRoutes } = await import('./classify.js')
    const a = new Hono()
    registerClassifyRoutes(a, deps)
    return a
  }

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-api-classify-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
    accounts = await import('../auth/accounts.js')
    session = await import('../auth/session.js')
    processedMessages = await import('../db/repositories/processed_messages.js')
    // Re-import the error classes after vi.resetModules() so the test's
    // `throw new OllamaUnreachableError(...)` and the handler's
    // `err instanceof OllamaUnreachableError` resolve to the same module
    // instance — `instanceof` is identity-based across ESM module reloads.
    ollamaErrors = await import('../classify/ollama.js')
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

  function happyPathResponse(): ClassifyResponse {
    return {
      classification: 'receipt',
      confidence: 'high',
      reason: 'Stripe receipt',
      vendor: 'Stripe',
      amount: 9.99,
      currency: 'USD',
      transaction_date: '2026-05-01',
      model_used: 'qwen2.5vl:7b',
      artifacts: [{ kind: 'body', mime_type: 'text/plain' }],
    }
  }

  it('returns 400 on a non-numeric :id', async () => {
    app = await buildApp({ classifyMessage: vi.fn() })
    const res = await app.fetch(
      new Request('http://x/api/accounts/abc/messages/m1/classify', { method: 'POST' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on an empty :message_id (Hono routes the missing segment to a 404 anyway)', async () => {
    app = await buildApp({ classifyMessage: vi.fn() })
    // Trailing slash: there is no Hono pattern for empty path-param values, so
    // this exercises the URL-shape boundary; expect 404 since Hono routing
    // doesn't match the route at all.
    const res = await app.fetch(
      new Request('http://x/api/accounts/1/messages//classify', { method: 'POST' }),
    )
    expect([400, 404]).toContain(res.status)
  })

  it('returns 400 on a :message_id with forbidden characters', async () => {
    app = await buildApp({ classifyMessage: vi.fn() })
    const res = await app.fetch(
      new Request('http://x/api/accounts/1/messages/has%20space/classify', { method: 'POST' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the account does not exist', async () => {
    app = await buildApp({ classifyMessage: vi.fn() })
    const res = await app.fetch(
      new Request('http://x/api/accounts/9999/messages/m1/classify', { method: 'POST' }),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'account_not_found' })
  })

  it('returns 409 when the account is needs_reauth', async () => {
    const id = seedConnectedWithSession()
    accounts.updateStatus(id, 'needs_reauth')
    app = await buildApp({ classifyMessage: vi.fn() })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'account_not_connected',
      status: 'needs_reauth',
    })
  })

  it('returns 200 with the verdict on the happy path', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn<ClassifyFn>(async () => happyPathResponse())
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(happyPathResponse())
    expect(classifyMessage).toHaveBeenCalledTimes(1)
    const args = classifyMessage.mock.calls[0]?.[0] as { account_id: number; message_id: string }
    expect(args.account_id).toBe(id)
    expect(args.message_id).toBe('m1')
  })

  it('does not write to processed_messages even on the happy path (no-DB-write contract)', async () => {
    const id = seedConnectedWithSession()
    const before = processedMessages.countForAccount({ account_id: id })
    const classifyMessage = vi.fn(async () => happyPathResponse())
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    const after = processedMessages.countForAccount({ account_id: id })
    expect(after).toBe(before)
  })

  it('returns 503 ollama_unreachable when the orchestrator throws OllamaUnreachableError', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn(async () => {
      throw new ollamaErrors.OllamaUnreachableError('down')
    })
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'ollama_unreachable' })
  })

  it('returns 502 ollama_parse_error with raw_response when orchestrator throws OllamaParseError', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn(async () => {
      throw new ollamaErrors.OllamaParseError('bad json', '{ "classification":"spam"')
    })
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'ollama_parse_error',
      raw_response: '{ "classification":"spam"',
    })
  })

  it('returns 502 ollama_http_error with status and body when orchestrator throws OllamaHttpError', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn(async () => {
      throw new ollamaErrors.OllamaHttpError(500, 'boom')
    })
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'ollama_http_error',
      status: 500,
      body: 'boom',
    })
  })

  it('returns 401 needs_reauth when orchestrator surfaces invalid_grant', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn(async () => {
      throw new Error('invalid_grant: refresh failed')
    })
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'needs_reauth', account_id: id })
  })

  it('returns 502 gmail_error for any other Gmail error', async () => {
    const id = seedConnectedWithSession()
    const classifyMessage = vi.fn(async () => {
      throw new Error('Gmail 500: rate limit')
    })
    app = await buildApp({ classifyMessage })
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/messages/m1/classify`, { method: 'POST' }),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'gmail_error',
      message: 'Gmail 500: rate limit',
    })
  })
})
