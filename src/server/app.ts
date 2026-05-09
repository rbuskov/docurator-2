import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

export type CreateAppOptions = {
  staticDir?: string
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.text('ok'))

  if (options.staticDir !== undefined) {
    app.use('*', serveStatic({ root: options.staticDir }))
  }

  return app
}
