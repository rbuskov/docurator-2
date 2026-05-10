const DEFAULT_PORT = 3737
const DEFAULT_DEV_CLIENT_PORT = 5173
const DEFAULT_DB_PATH = './data/app.db'
const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:7b'
const DEFAULT_OLLAMA_TIMEOUT_MS = 120000

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

const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL
const ollamaModel = process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL
// Non-numeric / NaN env values fall back to the default; this mirrors how
// `port` is parsed but with an explicit guard since the default is large.
const ollamaTimeoutRaw =
  process.env.OLLAMA_TIMEOUT_MS !== undefined ? Number(process.env.OLLAMA_TIMEOUT_MS) : NaN
const ollamaTimeoutMs =
  Number.isFinite(ollamaTimeoutRaw) && ollamaTimeoutRaw > 0
    ? ollamaTimeoutRaw
    : DEFAULT_OLLAMA_TIMEOUT_MS

export const config = Object.freeze({
  port,
  oauthRedirectPort,
  googleClientId,
  googleClientSecret,
  dbPath: DEFAULT_DB_PATH,
  postOauthRedirectUrl,
  nodeEnv,
  ollamaUrl,
  ollamaModel,
  ollamaTimeoutMs,
})
