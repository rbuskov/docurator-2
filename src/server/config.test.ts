import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
  'APP_PORT',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_REDIRECT_PORT',
  'NODE_ENV',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'OLLAMA_TIMEOUT_MS',
] as const

describe('server config', () => {
  const originals: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) {
      originals[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originals[key]
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  })

  it('defaults port to 3737 when APP_PORT is unset', async () => {
    const { config } = await import('./config.js')
    expect(config.port).toBe(3737)
  })

  it('reads port from APP_PORT env var when set', async () => {
    process.env.APP_PORT = '4242'
    const { config } = await import('./config.js')
    expect(config.port).toBe(4242)
  })

  it('exposes a frozen config object', async () => {
    const { config } = await import('./config.js')
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('defaults googleClientId to empty string when GOOGLE_CLIENT_ID is unset', async () => {
    const { config } = await import('./config.js')
    expect(config.googleClientId).toBe('')
  })

  it('reads googleClientId from GOOGLE_CLIENT_ID env var', async () => {
    process.env.GOOGLE_CLIENT_ID = 'my-client-id.apps.googleusercontent.com'
    const { config } = await import('./config.js')
    expect(config.googleClientId).toBe('my-client-id.apps.googleusercontent.com')
  })

  it('defaults googleClientSecret to empty string when GOOGLE_CLIENT_SECRET is unset', async () => {
    const { config } = await import('./config.js')
    expect(config.googleClientSecret).toBe('')
  })

  it('reads googleClientSecret from GOOGLE_CLIENT_SECRET env var', async () => {
    process.env.GOOGLE_CLIENT_SECRET = 's3cret'
    const { config } = await import('./config.js')
    expect(config.googleClientSecret).toBe('s3cret')
  })

  it('defaults oauthRedirectPort to config.port when OAUTH_REDIRECT_PORT is unset', async () => {
    const { config } = await import('./config.js')
    expect(config.oauthRedirectPort).toBe(config.port)
  })

  it('reads oauthRedirectPort from OAUTH_REDIRECT_PORT env var when set', async () => {
    process.env.OAUTH_REDIRECT_PORT = '8080'
    const { config } = await import('./config.js')
    expect(config.oauthRedirectPort).toBe(8080)
  })

  it('uses APP_PORT as oauthRedirectPort default when APP_PORT is set but OAUTH_REDIRECT_PORT is not', async () => {
    process.env.APP_PORT = '5555'
    const { config } = await import('./config.js')
    expect(config.oauthRedirectPort).toBe(5555)
  })

  it("defaults dbPath to './data/app.db'", async () => {
    const { config } = await import('./config.js')
    expect(config.dbPath).toBe('./data/app.db')
  })

  it("defaults nodeEnv to 'development' when NODE_ENV is unset", async () => {
    const { config } = await import('./config.js')
    expect(config.nodeEnv).toBe('development')
  })

  it("reads nodeEnv from NODE_ENV env var when set to 'production'", async () => {
    process.env.NODE_ENV = 'production'
    const { config } = await import('./config.js')
    expect(config.nodeEnv).toBe('production')
  })

  it("defaults ollamaUrl to 'http://host.docker.internal:11434' when OLLAMA_URL is unset", async () => {
    const { config } = await import('./config.js')
    expect(config.ollamaUrl).toBe('http://host.docker.internal:11434')
  })

  it('reads ollamaUrl from OLLAMA_URL env var when set', async () => {
    process.env.OLLAMA_URL = 'http://172.17.0.1:11434'
    const { config } = await import('./config.js')
    expect(config.ollamaUrl).toBe('http://172.17.0.1:11434')
  })

  it("defaults ollamaModel to 'qwen2.5vl:7b' when OLLAMA_MODEL is unset", async () => {
    const { config } = await import('./config.js')
    expect(config.ollamaModel).toBe('qwen2.5vl:7b')
  })

  it('reads ollamaModel from OLLAMA_MODEL env var when set', async () => {
    process.env.OLLAMA_MODEL = 'llava:34b'
    const { config } = await import('./config.js')
    expect(config.ollamaModel).toBe('llava:34b')
  })

  it('defaults ollamaTimeoutMs to 120000 when OLLAMA_TIMEOUT_MS is unset', async () => {
    const { config } = await import('./config.js')
    expect(config.ollamaTimeoutMs).toBe(120000)
  })

  it('reads ollamaTimeoutMs from OLLAMA_TIMEOUT_MS env var when set to a positive integer', async () => {
    process.env.OLLAMA_TIMEOUT_MS = '60000'
    const { config } = await import('./config.js')
    expect(config.ollamaTimeoutMs).toBe(60000)
  })

  it('falls back to default 120000 when OLLAMA_TIMEOUT_MS is non-numeric', async () => {
    process.env.OLLAMA_TIMEOUT_MS = 'banana'
    const { config } = await import('./config.js')
    expect(config.ollamaTimeoutMs).toBe(120000)
  })
})
