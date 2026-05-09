import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('GET /api/accounts', () => {
  let tempDir: string
  let app: Hono
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-api-accounts-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')
    const { registerAccountsRoutes } = await import('./accounts.js')
    app = new Hono()
    registerAccountsRoutes(app)
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns an empty list when no accounts are connected', async () => {
    const res = await app.fetch(new Request('http://x/api/accounts'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ accounts: [] })
  })

  it('returns rows in id-asc order with the documented shape', async () => {
    const a = accounts.insert({
      email: 'alice@example.com',
      display_name: 'Alice',
      connected_at: '2026-05-09T10:00:00Z',
    })
    const b = accounts.insert({
      email: 'bob@example.com',
      display_name: null,
      connected_at: '2026-05-09T11:00:00Z',
    })
    accounts.touchLastSeen(a.id, '2026-05-09T12:00:00Z')

    const res = await app.fetch(new Request('http://x/api/accounts'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accounts: unknown[] }
    expect(body.accounts).toEqual([
      {
        id: a.id,
        email: 'alice@example.com',
        display_name: 'Alice',
        slug: 'alice-at-example-com',
        status: 'connected',
        connected_at: '2026-05-09T10:00:00Z',
        last_seen_at: '2026-05-09T12:00:00Z',
      },
      {
        id: b.id,
        email: 'bob@example.com',
        display_name: null,
        slug: 'bob-at-example-com',
        status: 'connected',
        connected_at: '2026-05-09T11:00:00Z',
        last_seen_at: null,
      },
    ])
  })
})
