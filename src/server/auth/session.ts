import { OAuth2Client } from 'google-auth-library'
import { config } from '../config.js'
import * as accounts from './accounts.js'
import { isInvalidGrantError } from './invalid-grant.js'
import { redirectUri } from './oauth.js'

export type Tokens = {
  access_token?: string | null
  refresh_token?: string | null
  id_token?: string | null
  expiry_date?: number | null
}

export type SessionClientLike = {
  setCredentials(tokens: Tokens): void
  on(event: 'tokens', listener: (tokens: Tokens) => void): void
  getAccessToken(): Promise<{ token?: string | null }>
}

export type SessionClientFactory = (
  clientId: string,
  clientSecret: string,
  redirectUri: string,
) => SessionClientLike

const defaultFactory: SessionClientFactory = (id, secret, uri) => new OAuth2Client(id, secret, uri)

let factory: SessionClientFactory = defaultFactory

export function setSessionClientFactoryForTest(f: SessionClientFactory): void {
  factory = f
}

export function resetSessionClientFactoryForTest(): void {
  factory = defaultFactory
}

type SessionEntry = {
  client: SessionClientLike
  refreshToken: string
}

const sessions = new Map<number, SessionEntry>()

export function set(
  accountId: number,
  args: { tokens: Tokens & { refresh_token: string } },
): void {
  const client = factory(config.googleClientId, config.googleClientSecret, redirectUri())
  client.setCredentials(args.tokens)
  // google-auth-library's `tokens` event fires when the access token is refreshed.
  // The refresh response may omit `refresh_token` (Google only returns it on first
  // consent or when re-prompted), so the shadow refreshToken is preserved when missing.
  client.on('tokens', (refreshed) => {
    const entry = sessions.get(accountId)
    if (entry === undefined) return
    if (refreshed.refresh_token) {
      entry.refreshToken = refreshed.refresh_token
    }
  })
  sessions.set(accountId, { client, refreshToken: args.tokens.refresh_token })
}

export function get(accountId: number): SessionEntry | undefined {
  return sessions.get(accountId)
}

export function clear(accountId: number): void {
  sessions.delete(accountId)
}

export function clearAllForTest(): void {
  sessions.clear()
}

export async function withFreshTokens<T>(
  accountId: number,
  callback: (client: SessionClientLike) => Promise<T>,
): Promise<T> {
  const entry = sessions.get(accountId)
  if (entry === undefined) {
    throw new Error(`No session for account ${accountId}`)
  }

  try {
    await entry.client.getAccessToken()
  } catch (err) {
    if (isInvalidGrantError(err)) {
      clear(accountId)
      accounts.updateStatus(accountId, 'needs_reauth')
    }
    throw err
  }

  return callback(entry.client)
}

