import type { Hono } from 'hono'
import { isInvalidGrantError } from '../auth/invalid-grant.js'
import { requireConnectedAccount } from '../auth/preconditions.js'
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

    const pre = requireConnectedAccount(id)
    if (!pre.ok) return c.json(pre.body, pre.status)

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

