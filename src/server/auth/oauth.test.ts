import { beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
  'APP_PORT',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_REDIRECT_PORT',
] as const

beforeEach(() => {
  vi.resetModules()
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  process.env.GOOGLE_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.APP_PORT = '3737'
})

function makeIdToken(payload: object): string {
  const headerSegment = Buffer.from(JSON.stringify({ alg: 'RS256' }), 'utf8').toString('base64url')
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${headerSegment}.${payloadSegment}.fake-signature`
}

describe('buildConsentUrl', () => {
  it('builds the Google consent URL with the required scopes and params', async () => {
    const { buildConsentUrl, SCOPES } = await import('./oauth.js')
    const url = new URL(buildConsentUrl({ state: 'random-state-123' }))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3737/oauth/callback')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('random-state-123')

    const scopes = url.searchParams.get('scope')?.split(' ').sort()
    expect(scopes).toEqual([...SCOPES].sort())
  })

  it('uses oauthRedirectPort when OAUTH_REDIRECT_PORT is set', async () => {
    process.env.OAUTH_REDIRECT_PORT = '8080'
    const { buildConsentUrl } = await import('./oauth.js')
    const url = new URL(buildConsentUrl({ state: 's' }))
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/oauth/callback')
  })

  it('exposes SCOPES with the three required entries and nothing more', async () => {
    const { SCOPES } = await import('./oauth.js')
    expect([...SCOPES].sort()).toEqual(
      [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
        'openid',
      ].sort(),
    )
  })
})

describe('exchangeCode', () => {
  it('returns tokens and the email decoded from the id_token payload', async () => {
    const { exchangeCode } = await import('./oauth.js')
    const idToken = makeIdToken({ email: 'alice@example.com' })

    const factory = () => ({
      generateAuthUrl: () => 'unused',
      getToken: vi.fn().mockResolvedValue({
        tokens: {
          access_token: 'AT',
          refresh_token: 'RT',
          id_token: idToken,
          expiry_date: 1717000000000,
        },
      }),
    })

    const result = await exchangeCode('the-code', factory)

    expect(result.email).toBe('alice@example.com')
    expect(result.tokens).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      id_token: idToken,
      expiry_date: 1717000000000,
    })
  })

  it('throws when getToken returns an incomplete token set', async () => {
    const { exchangeCode } = await import('./oauth.js')
    const factory = () => ({
      generateAuthUrl: () => 'unused',
      getToken: vi.fn().mockResolvedValue({
        tokens: { access_token: 'AT' },
      }),
    })
    await expect(exchangeCode('the-code', factory)).rejects.toThrow(/incomplete/i)
  })

  it('throws when the id_token payload has no email claim', async () => {
    const { exchangeCode } = await import('./oauth.js')
    const idToken = makeIdToken({ sub: 'no-email-here' })
    const factory = () => ({
      generateAuthUrl: () => 'unused',
      getToken: vi.fn().mockResolvedValue({
        tokens: {
          access_token: 'AT',
          refresh_token: 'RT',
          id_token: idToken,
          expiry_date: 1717000000000,
        },
      }),
    })
    await expect(exchangeCode('the-code', factory)).rejects.toThrow(/email/i)
  })

  it('throws when the id_token has the wrong number of segments', async () => {
    const { exchangeCode } = await import('./oauth.js')
    const factory = () => ({
      generateAuthUrl: () => 'unused',
      getToken: vi.fn().mockResolvedValue({
        tokens: {
          access_token: 'AT',
          refresh_token: 'RT',
          id_token: 'not-a-jwt',
          expiry_date: 1717000000000,
        },
      }),
    })
    await expect(exchangeCode('the-code', factory)).rejects.toThrow(/malformed/i)
  })
})
