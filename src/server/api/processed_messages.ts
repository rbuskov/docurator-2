import type { Hono } from 'hono'
import * as accounts from '../auth/accounts.js'
import * as processedMessages from '../db/repositories/processed_messages.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 50

export function registerProcessedMessagesRoutes(app: Hono): void {
  app.get('/api/accounts/:id/processed-messages', (c) => {
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

    const rows = processedMessages.listForAccount({ account_id: id, limit })
    return c.json({ rows })
  })
}
