import type { Hono } from 'hono'
import * as accounts from '../auth/accounts.js'

export function registerAccountsRoutes(app: Hono): void {
  app.get('/api/accounts', (c) => c.json({ accounts: accounts.list() }))
}
