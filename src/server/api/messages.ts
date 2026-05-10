import type { Hono } from 'hono'
import * as accounts from '../auth/accounts.js'
import * as session from '../auth/session.js'
import { createGmailClient as defaultCreateGmailClient } from '../gmail/client.js'
import type { GmailClient } from '../gmail/client.js'
import { extractHeader } from '../gmail/headers.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export type MessagesRouteDeps = {
  createGmailClient?: (accountId: number) => GmailClient
}

export function registerMessagesRoutes(app: Hono, deps: MessagesRouteDeps = {}): void {
  const _createGmailClient = deps.createGmailClient ?? defaultCreateGmailClient

  app.get('/api/accounts/:id/messages', async (c) => {
    const idParam = c.req.param('id')
    const id = Number(idParam)
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid_id' }, 400)
    }

    const limitParam = c.req.query('limit')
    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: 'invalid_limit' }, 400)
    }

    const account = accounts.findById(id)
    if (account === undefined) {
      return c.json({ error: 'account_not_found' }, 404)
    }

    if (account.status !== 'connected') {
      return c.json(
        { error: 'account_not_connected', status: account.status },
        409,
      )
    }

    if (session.get(id) === undefined) {
      // Account is `connected` per DB but tokens are gone (e.g. container restart).
      // Flip to needs_reauth so the Dashboard surfaces the Reconnect button.
      accounts.updateStatus(id, 'needs_reauth')
      return c.json({ error: 'account_not_connected', status: 'needs_reauth' }, 409)
    }

    const client = _createGmailClient(id)

    try {
      const list = await client.listMessages({ maxResults: limit })

      const rows = []
      for (const m of list.messages) {
        if (typeof m.id !== 'string') continue
        const message = await client.getMessage(m.id, {
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        })
        rows.push({
          id: m.id,
          thread_id: m.threadId ?? '',
          subject: extractHeader(message, 'Subject'),
          from: extractHeader(message, 'From'),
          date: extractHeader(message, 'Date'),
          internal_date: message.internalDate ?? '',
        })
      }

      return c.json({ messages: rows })
    } catch (err) {
      if (isInvalidGrantError(err)) {
        // session.withFreshTokens already flipped the row + cleared the session.
        return c.json({ error: 'needs_reauth', account_id: id }, 401)
      }
      const message = err instanceof Error ? err.message : 'Gmail call failed'
      return c.json({ error: 'gmail_error', message }, 502)
    }
  })
}

function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('invalid_grant')) return true
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } } }
    if (e.response?.data?.error === 'invalid_grant') return true
  }
  return false
}
