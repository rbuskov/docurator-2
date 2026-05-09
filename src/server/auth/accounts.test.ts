import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('accounts repository', () => {
  let tempDir: string
  let accounts: typeof import('./accounts.js')
  let dbModule: typeof import('../db/index.js')

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-accounts-'))

    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('./accounts.js')
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed; nothing to do
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('insert returns { id, slug } and stores the row with status="connected"', () => {
    const { id, slug } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    expect(id).toBeGreaterThan(0)
    expect(slug).toBe('alice-at-example-com')

    const row = accounts.findById(id)
    expect(row).toMatchObject({
      id,
      email: 'alice@example.com',
      display_name: null,
      slug: 'alice-at-example-com',
      status: 'connected',
      connected_at: '2026-05-09T00:00:00Z',
      last_seen_at: null,
    })
  })

  it('insert appends -2/-3 when the derived slug collides', () => {
    const a = accounts.insert({
      email: 'bob+work@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    const b = accounts.insert({
      email: 'bob.work@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    const c = accounts.insert({
      email: 'bob_work@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    expect(a.slug).toBe('bob-work-at-example-com')
    expect(b.slug).toBe('bob-work-at-example-com-2')
    expect(c.slug).toBe('bob-work-at-example-com-3')
  })

  it('findByEmail and findById round-trip a row', () => {
    const { id } = accounts.insert({
      email: 'carol@example.com',
      display_name: 'Carol',
      connected_at: '2026-05-09T00:00:00Z',
    })

    const byEmail = accounts.findByEmail('carol@example.com')
    const byId = accounts.findById(id)

    expect(byEmail).toEqual(byId)
    expect(byEmail?.display_name).toBe('Carol')
  })

  it('findByEmail returns undefined for an unknown email', () => {
    expect(accounts.findByEmail('nobody@example.com')).toBeUndefined()
  })

  it('findById returns undefined for an unknown id', () => {
    expect(accounts.findById(9999)).toBeUndefined()
  })

  it('updateStatus flips the column and is reversible', () => {
    const { id } = accounts.insert({
      email: 'dave@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    accounts.updateStatus(id, 'needs_reauth')
    expect(accounts.findById(id)?.status).toBe('needs_reauth')

    accounts.updateStatus(id, 'connected')
    expect(accounts.findById(id)?.status).toBe('connected')
  })

  it('touchLastSeen writes the timestamp into last_seen_at', () => {
    const { id } = accounts.insert({
      email: 'eve@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    expect(accounts.findById(id)?.last_seen_at).toBeNull()
    accounts.touchLastSeen(id, '2026-05-09T12:34:56Z')
    expect(accounts.findById(id)?.last_seen_at).toBe('2026-05-09T12:34:56Z')
  })

  it('list returns rows ordered by id ASC', () => {
    accounts.insert({
      email: 'first@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    accounts.insert({
      email: 'second@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    accounts.insert({
      email: 'third@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    const rows = accounts.list()
    expect(rows.map((r) => r.email)).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ])
  })
})
