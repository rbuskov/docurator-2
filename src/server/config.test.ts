import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('server config', () => {
  const originalAppPort = process.env.APP_PORT

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (originalAppPort === undefined) {
      delete process.env.APP_PORT
    } else {
      process.env.APP_PORT = originalAppPort
    }
  })

  it('defaults port to 3737 when APP_PORT is unset', async () => {
    delete process.env.APP_PORT
    const { config } = await import('./config.js')
    expect(config.port).toBe(3737)
  })

  it('reads port from APP_PORT env var when set', async () => {
    process.env.APP_PORT = '4242'
    const { config } = await import('./config.js')
    expect(config.port).toBe(4242)
  })

  it('exposes a frozen config object', async () => {
    delete process.env.APP_PORT
    const { config } = await import('./config.js')
    expect(Object.isFrozen(config)).toBe(true)
  })
})
