import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

type StubTokens = {
  access_token?: string | null
  refresh_token?: string | null
  id_token?: string | null
  expiry_date?: number | null
}

function makeStubSessionClient() {
  let creds: StubTokens | undefined
  let listener: ((t: StubTokens) => void) | undefined
  return {
    setCredentials(t: StubTokens) {
      creds = t
    },
    on(event: string, l: (t: StubTokens) => void) {
      if (event === 'tokens') listener = l
    },
    getAccessToken: vi.fn().mockResolvedValue({ token: 'fresh-AT' }),
    _getCreds: () => creds,
    _hasListener: () => listener !== undefined,
  }
}

describe('POST /api/oauth/start', () => {
  let app: Hono
  let oauthApi: typeof import('./oauth.js')

  beforeEach(async () => {
    vi.resetModules()
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    process.env.APP_PORT = '3737'
    delete process.env.OAUTH_REDIRECT_PORT

    oauthApi = await import('./oauth.js')
    oauthApi.__resetStateMapForTest()
    app = new Hono()
    oauthApi.registerOauthRoutes(app)
  })

  it('returns { consent_url, state } and records the state with kind="add"', async () => {
    const before = Date.now()
    const res = await app.fetch(new Request('http://x/api/oauth/start', { method: 'POST' }))
    const after = Date.now()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)

    const body = (await res.json()) as { consent_url: string; state: string }
    expect(body.state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(body.consent_url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/)

    const entry = oauthApi.__getStateMapForTest().get(body.state)
    expect(entry?.kind).toBe('add')
    expect(entry?.accountId).toBeUndefined()
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000)
    expect(entry?.expiresAt).toBeLessThanOrEqual(after + 10 * 60_000 + 1000)
  })

  it('encodes the returned state into the consent URL', async () => {
    const res = await app.fetch(new Request('http://x/api/oauth/start', { method: 'POST' }))
    const body = (await res.json()) as { consent_url: string; state: string }
    const url = new URL(body.consent_url)
    expect(url.searchParams.get('state')).toBe(body.state)
  })

  it('issues a fresh state on every call', async () => {
    const res1 = await app.fetch(new Request('http://x/api/oauth/start', { method: 'POST' }))
    const res2 = await app.fetch(new Request('http://x/api/oauth/start', { method: 'POST' }))
    const body1 = (await res1.json()) as { state: string }
    const body2 = (await res2.json()) as { state: string }
    expect(body1.state).not.toBe(body2.state)
    expect(oauthApi.__getStateMapForTest().size).toBe(2)
  })
})

describe('GET /oauth/callback', () => {
  let tempDir: string
  let app: Hono
  let oauthApi: typeof import('./oauth.js')
  let session: typeof import('../auth/session.js')
  let accounts: typeof import('../auth/accounts.js')
  let dbModule: typeof import('../db/index.js')
  let fakeExchange: ReturnType<typeof vi.fn>
  let stubSessionClient: ReturnType<typeof makeStubSessionClient>

  beforeEach(async () => {
    vi.resetModules()
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    process.env.APP_PORT = '3737'
    delete process.env.OAUTH_REDIRECT_PORT

    tempDir = mkdtempSync(join(tmpdir(), 'docurator-callback-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')
    session = await import('../auth/session.js')

    stubSessionClient = makeStubSessionClient()
    session.setSessionClientFactoryForTest(() => stubSessionClient)

    fakeExchange = vi.fn().mockResolvedValue({
      tokens: {
        access_token: 'AT',
        refresh_token: 'RT',
        id_token: 'IT',
        expiry_date: 1717000000000,
      },
      email: 'alice@example.com',
    })

    oauthApi = await import('./oauth.js')
    oauthApi.__resetStateMapForTest()
    app = new Hono()
    oauthApi.registerOauthRoutes(app, { exchangeCode: fakeExchange })
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedAddState(state = 'state-add-1', expiresAt = Date.now() + 60_000): string {
    oauthApi.__getStateMapForTest().set(state, { kind: 'add', expiresAt })
    return state
  }

  it('on success: inserts the account, stores the session, redirects to /', async () => {
    const state = seedAddState()
    const res = await app.fetch(
      new Request(`http://x/oauth/callback?code=abc&state=${state}`, { redirect: 'manual' }),
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(fakeExchange).toHaveBeenCalledWith('abc')

    const row = accounts.findByEmail('alice@example.com')
    expect(row).toBeDefined()
    expect(row?.status).toBe('connected')
    expect(row?.slug).toBe('alice-at-example-com')

    expect(session.get(row!.id)).toBeDefined()
    expect(oauthApi.__getStateMapForTest().has(state)).toBe(false)
  })

  it('existing email + add-kind state: updates status/last_seen_at without duplicating the row', async () => {
    const state1 = seedAddState('state-1')
    await app.fetch(new Request(`http://x/oauth/callback?code=c1&state=${state1}`))

    const after1 = accounts.list()
    expect(after1).toHaveLength(1)
    accounts.updateStatus(after1[0]!.id, 'needs_reauth')

    const state2 = seedAddState('state-2')
    await app.fetch(new Request(`http://x/oauth/callback?code=c2&state=${state2}`))

    const after2 = accounts.list()
    expect(after2).toHaveLength(1)
    expect(after2[0]!.status).toBe('connected')
    expect(after2[0]!.last_seen_at).not.toBeNull()
    expect(after2[0]!.id).toBe(after1[0]!.id)
  })

  it('bad state: 400 HTML body containing "Couldn\'t connect"', async () => {
    const res = await app.fetch(
      new Request('http://x/oauth/callback?code=abc&state=does-not-exist'),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/html/)
    expect(await res.text()).toContain("Couldn't connect")
  })

  it('expired state: 400 HTML', async () => {
    const state = seedAddState('expired', Date.now() - 1000)
    const res = await app.fetch(new Request(`http://x/oauth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Couldn't connect")
    expect(oauthApi.__getStateMapForTest().has(state)).toBe(false)
  })

  it('code-exchange error: 400 HTML containing the error message', async () => {
    fakeExchange.mockRejectedValueOnce(new Error('exchange-broke'))
    const state = seedAddState('state-err')
    const res = await app.fetch(new Request(`http://x/oauth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain("Couldn't connect")
    expect(body).toContain('exchange-broke')
  })

  it('missing code or state: 400 HTML', async () => {
    const res = await app.fetch(new Request('http://x/oauth/callback'))
    expect(res.status).toBe(400)
  })

  it('escapes HTML in the error message echo', async () => {
    fakeExchange.mockRejectedValueOnce(new Error('<script>bad</script>'))
    const state = seedAddState('state-xss')
    const res = await app.fetch(new Request(`http://x/oauth/callback?code=abc&state=${state}`))
    const body = await res.text()
    expect(body).not.toContain('<script>bad</script>')
    expect(body).toContain('&lt;script&gt;')
  })

  function seedReconnectState(
    accountId: number,
    state = `state-rc-${accountId}`,
    expiresAt = Date.now() + 60_000,
  ): string {
    oauthApi.__getStateMapForTest().set(state, { kind: 'reconnect', accountId, expiresAt })
    return state
  }

  it('reconnect-kind state: updates status, no duplicate, stores session', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    accounts.updateStatus(id, 'needs_reauth')

    const state = seedReconnectState(id)
    const res = await app.fetch(
      new Request(`http://x/oauth/callback?code=abc&state=${state}`, { redirect: 'manual' }),
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')

    const after = accounts.list()
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(id)
    expect(after[0]!.status).toBe('connected')
    expect(after[0]!.last_seen_at).not.toBeNull()
    expect(session.get(id)).toBeDefined()
  })

  it('reconnect with mismatched email: 400 HTML, row left unchanged', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    accounts.updateStatus(id, 'needs_reauth')

    fakeExchange.mockResolvedValueOnce({
      tokens: {
        access_token: 'AT',
        refresh_token: 'RT',
        id_token: 'IT',
        expiry_date: 1717000000000,
      },
      email: 'someone-else@example.com',
    })

    const state = seedReconnectState(id, 'state-mismatch')
    const res = await app.fetch(new Request(`http://x/oauth/callback?code=abc&state=${state}`))

    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain("Couldn't connect")
    expect(body).toContain('alice@example.com')
    expect(body).toContain('someone-else@example.com')

    const row = accounts.findById(id)
    expect(row?.email).toBe('alice@example.com')
    expect(row?.status).toBe('needs_reauth')
    expect(session.get(id)).toBeUndefined()
  })

  it('reconnect with vanished account: 400 HTML', async () => {
    const state = seedReconnectState(9999, 'state-gone')
    const res = await app.fetch(new Request(`http://x/oauth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Couldn't connect")
  })
})

describe('POST /api/accounts/:id/reconnect', () => {
  let tempDir: string
  let app: Hono
  let oauthApi: typeof import('./oauth.js')
  let accounts: typeof import('../auth/accounts.js')
  let dbModule: typeof import('../db/index.js')

  beforeEach(async () => {
    vi.resetModules()
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    process.env.APP_PORT = '3737'
    delete process.env.OAUTH_REDIRECT_PORT

    tempDir = mkdtempSync(join(tmpdir(), 'docurator-rc-'))
    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../auth/accounts.js')

    oauthApi = await import('./oauth.js')
    oauthApi.__resetStateMapForTest()
    app = new Hono()
    oauthApi.registerOauthRoutes(app)
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns { consent_url, state } and records the state with kind="reconnect"', async () => {
    const { id } = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T00:00:00Z',
    })
    accounts.updateStatus(id, 'needs_reauth')

    const before = Date.now()
    const res = await app.fetch(
      new Request(`http://x/api/accounts/${id}/reconnect`, { method: 'POST' }),
    )
    const after = Date.now()

    expect(res.status).toBe(200)
    const body = (await res.json()) as { consent_url: string; state: string }
    expect(body.state).toMatch(/^[0-9a-f]{8}-/)
    expect(body.consent_url).toMatch(/^https:\/\/accounts\.google\.com/)

    const entry = oauthApi.__getStateMapForTest().get(body.state)
    expect(entry?.kind).toBe('reconnect')
    expect(entry?.accountId).toBe(id)
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000)
    expect(entry?.expiresAt).toBeLessThanOrEqual(after + 10 * 60_000 + 1000)
  })

  it('returns 404 JSON when the account id does not exist', async () => {
    const res = await app.fetch(
      new Request('http://x/api/accounts/999/reconnect', { method: 'POST' }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeDefined()
  })

  it('returns 400 JSON when the id parameter is not an integer', async () => {
    const res = await app.fetch(
      new Request('http://x/api/accounts/not-a-number/reconnect', { method: 'POST' }),
    )
    expect(res.status).toBe(400)
  })
})
