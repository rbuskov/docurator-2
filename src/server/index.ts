import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { config } from './config.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const staticDir = resolve(moduleDir, '../client')

const app = createApp({ staticDir })

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`Docurator listening on http://localhost:${info.port}`)
  },
)
