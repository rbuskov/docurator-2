import { OAuth2Client } from 'google-auth-library'
import { config } from '../config.js'

export const SCOPES: string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
]

export type ExchangedTokens = {
  access_token: string
  refresh_token: string
  id_token: string
  expiry_date: number
}

export type OAuth2ClientLike = {
  generateAuthUrl(opts: {
    access_type: string
    prompt: string
    scope: string[]
    state: string
  }): string
  getToken(code: string): Promise<{
    tokens: {
      access_token?: string | null
      refresh_token?: string | null
      id_token?: string | null
      expiry_date?: number | null
    }
  }>
}

export type OAuth2ClientFactory = (
  clientId: string,
  clientSecret: string,
  redirectUri: string,
) => OAuth2ClientLike

const defaultFactory: OAuth2ClientFactory = (id, secret, uri) => new OAuth2Client(id, secret, uri)

export function redirectUri(): string {
  return `http://localhost:${config.oauthRedirectPort}/oauth/callback`
}

export function buildConsentUrl(
  args: { state: string },
  factory: OAuth2ClientFactory = defaultFactory,
): string {
  const client = factory(config.googleClientId, config.googleClientSecret, redirectUri())
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: args.state,
  })
}

export async function exchangeCode(
  code: string,
  factory: OAuth2ClientFactory = defaultFactory,
): Promise<{ tokens: ExchangedTokens; email: string }> {
  const client = factory(config.googleClientId, config.googleClientSecret, redirectUri())
  const { tokens } = await client.getToken(code)

  if (
    !tokens.access_token ||
    !tokens.refresh_token ||
    !tokens.id_token ||
    typeof tokens.expiry_date !== 'number'
  ) {
    throw new Error('OAuth token exchange returned an incomplete token set')
  }

  const email = decodeIdTokenEmail(tokens.id_token)
  return {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expiry_date: tokens.expiry_date,
    },
    email,
  }
}

function decodeIdTokenEmail(idToken: string): string {
  const segments = idToken.split('.')
  if (segments.length !== 3) {
    throw new Error('Malformed id_token: expected three dot-separated segments')
  }
  const payloadSegment = segments[1] ?? ''
  const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf8')
  const claims = JSON.parse(decoded) as { email?: unknown }
  if (typeof claims.email !== 'string' || claims.email.length === 0) {
    throw new Error('id_token payload did not contain an email claim')
  }
  return claims.email
}
