import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { migrate } from './db/migrate.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const staticDir = resolve(moduleDir, '../client')
const migrationsDir = resolve(moduleDir, './db/migrations')

mkdirSync(dirname(resolve(config.dbPath)), { recursive: true })
migrate(getDb(), migrationsDir)

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
