import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

type Tokens = {
  access_token?: string | null
  refresh_token?: string | null
  id_token?: string | null
  expiry_date?: number | null
}

function makeStubClient() {
  let creds: Tokens | undefined
  let tokensListener: ((t: Tokens) => void) | undefined
  return {
    setCredentials(t: Tokens) {
      creds = t
    },
    on(event: string, listener: (t: Tokens) => void) {
      if (event === 'tokens') tokensListener = listener
    },
    getAccessToken: vi.fn().mockResolvedValue({ token: 'fresh-AT' }),
    _fireTokens(t: Tokens) {
      tokensListener?.(t)
    },
    _getCreds() {
      return creds
    },
    _hasListener() {
      return tokensListener !== undefined
    },
  }
}

describe('session module', () => {
  let tempDir: string
  let session: typeof import('./session.js')
  let accounts: typeof import('./accounts.js')
  let dbModule: typeof import('../db/index.js')

  beforeEach(async () => {
    vi.resetModules()
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    process.env.APP_PORT = '3737'
    delete process.env.OAUTH_REDIRECT_PORT

    tempDir = mkdtempSync(join(tmpdir(), 'docurator-session-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('./accounts.js')
    session = await import('./session.js')
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('set stores an entry, registers a tokens listener, and is retrievable via get', () => {
    const stub = makeStubClient()
    session.setSessionClientFactoryForTest(() => stub)

    session.set(1, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    const entry = session.get(1)
    expect(entry?.client).toBe(stub)
    expect(entry?.refreshToken).toBe('RT')
    expect(stub._hasListener()).toBe(true)
    expect(stub._getCreds()).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      id_token: 'IT',
      expiry_date: 1,
    })
  })

  it('the tokens listener updates refreshToken when the refresh response includes one', () => {
    const stub = makeStubClient()
    session.setSessionClientFactoryForTest(() => stub)
    session.set(1, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    stub._fireTokens({ access_token: 'AT2', refresh_token: 'NEW_RT' })

    expect(session.get(1)?.refreshToken).toBe('NEW_RT')
  })

  it('the tokens listener preserves the existing refreshToken when the refresh response omits one', () => {
    const stub = makeStubClient()
    session.setSessionClientFactoryForTest(() => stub)
    session.set(1, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    stub._fireTokens({ access_token: 'AT2' })

    expect(session.get(1)?.refreshToken).toBe('RT')
  })

  it('clear removes the entry', () => {
    const stub = makeStubClient()
    session.setSessionClientFactoryForTest(() => stub)
    session.set(1, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    session.clear(1)
    expect(session.get(1)).toBeUndefined()
  })

  it('withFreshTokens calls getAccessToken and invokes the callback with the client', async () => {
    const stub = makeStubClient()
    session.setSessionClientFactoryForTest(() => stub)
    session.set(1, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    const callback = vi.fn().mockResolvedValue('done')
    const result = await session.withFreshTokens(1, callback)

    expect(stub.getAccessToken).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith(stub)
    expect(result).toBe('done')
  })

  it('withFreshTokens flips status to needs_reauth and clears the session on invalid_grant', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    const stub = makeStubClient()
    stub.getAccessToken.mockRejectedValue(
      new Error('invalid_grant: Token has been expired or revoked'),
    )
    session.setSessionClientFactoryForTest(() => stub)
    session.set(id, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    await expect(session.withFreshTokens(id, async () => 'unused')).rejects.toThrow(/invalid_grant/)

    expect(session.get(id)).toBeUndefined()
    expect(accounts.findById(id)?.status).toBe('needs_reauth')
  })

  it('withFreshTokens rethrows non-invalid_grant errors without flipping status', async () => {
    const { id } = accounts.insert({
      email: 'bob@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })

    const stub = makeStubClient()
    stub.getAccessToken.mockRejectedValue(new Error('network down'))
    session.setSessionClientFactoryForTest(() => stub)
    session.set(id, {
      tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'IT', expiry_date: 1 },
    })

    await expect(session.withFreshTokens(id, async () => 'unused')).rejects.toThrow(/network down/)

    expect(accounts.findById(id)?.status).toBe('connected')
    expect(session.get(id)).toBeDefined()
  })

  it('withFreshTokens throws when no session exists for the accountId', async () => {
    await expect(session.withFreshTokens(999, async () => 'unused')).rejects.toThrow(/No session/)
  })
})
