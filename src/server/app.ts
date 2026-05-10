import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { registerAccountsRoutes } from './api/accounts.js'
import { registerDevRoutes } from './api/dev.js'
import { registerMessagesRoutes } from './api/messages.js'
import { registerOauthRoutes } from './api/oauth.js'
import { registerProcessedMessagesRoutes } from './api/processed_messages.js'

export type CreateAppOptions = {
  staticDir?: string
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.text('ok'))
  registerAccountsRoutes(app)
  registerOauthRoutes(app)
  registerMessagesRoutes(app)
  registerDevRoutes(app)
  registerProcessedMessagesRoutes(app)

  if (options.staticDir !== undefined) {
    app.use('*', serveStatic({ root: options.staticDir }))
  }

  return app
}
