const DEFAULT_PORT = 3737
const DEFAULT_DB_PATH = './data/app.db'

const port = process.env.APP_PORT !== undefined ? Number(process.env.APP_PORT) : DEFAULT_PORT
const oauthRedirectPort =
  process.env.OAUTH_REDIRECT_PORT !== undefined ? Number(process.env.OAUTH_REDIRECT_PORT) : port

// OAuth credentials are read eagerly but stay empty when unset; the OAuth route
// handlers validate non-empty before use so the server can boot for tests and
// non-OAuth dev paths without a populated .env.
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? ''
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''

export const config = Object.freeze({
  port,
  oauthRedirectPort,
  googleClientId,
  googleClientSecret,
  dbPath: DEFAULT_DB_PATH,
})
