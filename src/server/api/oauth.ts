import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import * as accounts from '../auth/accounts.js'
import { buildConsentUrl, exchangeCode } from '../auth/oauth.js'
import * as session from '../auth/session.js'

const STATE_TTL_MS = 10 * 60 * 1000
const PRUNE_THRESHOLD = 100

export type StateKind = 'add' | 'reconnect'

export type StateEntry = {
  kind: StateKind
  accountId?: number
  expiresAt: number
}

export type OauthRouteDeps = {
  exchangeCode?: typeof exchangeCode
  buildConsentUrl?: typeof buildConsentUrl
}

const stateMap = new Map<string, StateEntry>()

function pruneExpired(): void {
  const now = Date.now()
  for (const [key, entry] of stateMap) {
    if (entry.expiresAt < now) stateMap.delete(key)
  }
}

export function __resetStateMapForTest(): void {
  stateMap.clear()
}

export function __getStateMapForTest(): Map<string, StateEntry> {
  return stateMap
}

export function registerOauthRoutes(app: Hono, deps: OauthRouteDeps = {}): void {
  const _exchangeCode = deps.exchangeCode ?? exchangeCode
  const _buildConsentUrl = deps.buildConsentUrl ?? buildConsentUrl

  app.post('/api/oauth/start', (c) => {
    if (stateMap.size > PRUNE_THRESHOLD) pruneExpired()
    const state = randomUUID()
    stateMap.set(state, { kind: 'add', expiresAt: Date.now() + STATE_TTL_MS })
    return c.json({ consent_url: _buildConsentUrl({ state }), state })
  })

  app.post('/api/accounts/:id/reconnect', (c) => {
    const idParam = c.req.param('id')
    const id = Number(idParam)
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid id' }, 400)
    }
    const account = accounts.findById(id)
    if (account === undefined) {
      return c.json({ error: 'account not found' }, 404)
    }
    if (stateMap.size > PRUNE_THRESHOLD) pruneExpired()
    const state = randomUUID()
    stateMap.set(state, { kind: 'reconnect', accountId: id, expiresAt: Date.now() + STATE_TTL_MS })
    return c.json({ consent_url: _buildConsentUrl({ state }), state })
  })

  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')

    if (!code || !state) {
      return errorPage(c, 'Missing code or state in callback URL')
    }

    const entry = stateMap.get(state)
    if (!entry || entry.expiresAt < Date.now()) {
      stateMap.delete(state)
      return errorPage(c, "Unknown or expired state — start the Add Gmail account flow again")
    }

    // State is single-use — drop it now regardless of subsequent success or failure.
    stateMap.delete(state)

    let exchanged: Awaited<ReturnType<typeof exchangeCode>>
    try {
      exchanged = await _exchangeCode(code)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error during code exchange'
      return errorPage(c, message)
    }

    const now = new Date().toISOString()

    if (entry.kind === 'add') {
      const existing = accounts.findByEmail(exchanged.email)
      let accountId: number
      if (existing !== undefined) {
        accounts.updateStatus(existing.id, 'connected')
        accounts.touchLastSeen(existing.id, now)
        accountId = existing.id
      } else {
        const inserted = accounts.insert({
          email: exchanged.email,
          display_name: null,
          connected_at: now,
        })
        accountId = inserted.id
      }
      session.set(accountId, { tokens: exchanged.tokens })
      return c.redirect('/', 302)
    }

    if (entry.kind === 'reconnect') {
      if (entry.accountId === undefined) {
        return errorPage(c, 'Reconnect state is missing the account id')
      }
      const account = accounts.findById(entry.accountId)
      if (account === undefined) {
        return errorPage(c, 'The account being reconnected no longer exists')
      }
      if (account.email !== exchanged.email) {
        return errorPage(
          c,
          `This account is registered as ${account.email}, but you signed in as ${exchanged.email}. Reconnect using the original Google account.`,
        )
      }
      accounts.updateStatus(entry.accountId, 'connected')
      accounts.touchLastSeen(entry.accountId, now)
      session.set(entry.accountId, { tokens: exchanged.tokens })
      return c.redirect('/', 302)
    }

    return c.redirect('/', 302)
  })
}

function errorPage(c: Context, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Connection error · Docurator</title></head>
<body>
<h1>Couldn't connect this account</h1>
<p>${escapeHtml(message)}</p>
<p>You can close this tab.</p>
</body>
</html>`
  return c.html(html, 400)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return ch
    }
  })
}
