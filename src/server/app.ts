import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { registerAccountsRoutes } from './api/accounts.js'
import { registerMessagesRoutes } from './api/messages.js'
import { registerOauthRoutes } from './api/oauth.js'

export type CreateAppOptions = {
  staticDir?: string
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.text('ok'))
  registerAccountsRoutes(app)
  registerOauthRoutes(app)
  registerMessagesRoutes(app)

  if (options.staticDir !== undefined) {
    app.use('*', serveStatic({ root: options.staticDir }))
  }

  return app
}
