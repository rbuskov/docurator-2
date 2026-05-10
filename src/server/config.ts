const DEFAULT_PORT = 3737
const DEFAULT_DEV_CLIENT_PORT = 5173
const DEFAULT_DB_PATH = './data/app.db'

const port = process.env.APP_PORT !== undefined ? Number(process.env.APP_PORT) : DEFAULT_PORT
const oauthRedirectPort =
  process.env.OAUTH_REDIRECT_PORT !== undefined ? Number(process.env.OAUTH_REDIRECT_PORT) : port

// OAuth credentials are read eagerly but stay empty when unset; the OAuth route
// handlers validate non-empty before use so the server can boot for tests and
// non-OAuth dev paths without a populated .env.
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? ''
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''

// In dev, the SPA is served by Vite on a separate port; the OAuth callback
// must redirect the browser there, not back to Hono on `:APP_PORT`.
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isDev = nodeEnv === 'development'
const devClientPort =
  process.env.CLIENT_DEV_PORT !== undefined
    ? Number(process.env.CLIENT_DEV_PORT)
    : DEFAULT_DEV_CLIENT_PORT
const postOauthRedirectUrl = isDev ? `http://localhost:${devClientPort}/` : '/'

export const config = Object.freeze({
  port,
  oauthRedirectPort,
  googleClientId,
  googleClientSecret,
  dbPath: DEFAULT_DB_PATH,
  postOauthRedirectUrl,
  nodeEnv,
})
