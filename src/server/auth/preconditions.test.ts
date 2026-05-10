import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('requireConnectedAccount', () => {
  let tempDir: string
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('./accounts.js')
  let session: typeof import('./session.js')
  let preconditions: typeof import('./preconditions.js')

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-pre-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
    accounts = await import('./accounts.js')
    session = await import('./session.js')
    preconditions = await import('./preconditions.js')
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

  function seedAccount(): number {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    return id
  }

  function attachSession(id: number): void {
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
  }

  it('returns 404 with account_not_found when no row exists', () => {
    const result = preconditions.requireConnectedAccount(99999)
    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'account_not_found' },
    })
  })

  it('returns 409 with the existing status when the account is needs_reauth', () => {
    const id = seedAccount()
    accounts.updateStatus(id, 'needs_reauth')
    const result = preconditions.requireConnectedAccount(id)
    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'account_not_connected', status: 'needs_reauth' },
    })
  })

  it('flips a connected account with no in-memory session to needs_reauth and returns 409', () => {
    const id = seedAccount()
    // No session attached.
    const result = preconditions.requireConnectedAccount(id)
    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'account_not_connected', status: 'needs_reauth' },
    })
    // Side effect: DB row was flipped.
    const after = accounts.findById(id)
    expect(after?.status).toBe('needs_reauth')
  })

  it('returns ok with the account row when connected and session is present', () => {
    const id = seedAccount()
    attachSession(id)
    const result = preconditions.requireConnectedAccount(id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.account.id).toBe(id)
    expect(result.account.status).toBe('connected')
    expect(result.account.email).toBe('alice@example.com')
  })

  describe('requireKnownAccount', () => {
    it('returns 404 account_not_found when no row exists', () => {
      const result = preconditions.requireKnownAccount(99999)
      expect(result).toEqual({
        ok: false,
        status: 404,
        body: { error: 'account_not_found' },
      })
    })

    it('returns ok for a connected account regardless of session presence', () => {
      const id = seedAccount()
      // No session attached on purpose — requireKnownAccount must NOT require it.
      const result = preconditions.requireKnownAccount(id)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.account.id).toBe(id)
      // The relaxed check must NOT have flipped the row to needs_reauth.
      expect(accounts.findById(id)?.status).toBe('connected')
    })

    it('returns ok for a needs_reauth account too (DB existence is the only gate)', () => {
      const id = seedAccount()
      accounts.updateStatus(id, 'needs_reauth')
      const result = preconditions.requireKnownAccount(id)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.account.status).toBe('needs_reauth')
    })
  })
})
