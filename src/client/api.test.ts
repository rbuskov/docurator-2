import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('client api helpers', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('getJson fetches with GET and returns the parsed JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { getJson } = await import('./api.js')
    const result = await getJson<{ accounts: unknown[] }>('/api/accounts')

    expect(result).toEqual({ accounts: [] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/accounts',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('postJson fetches with POST and Content-Type: application/json', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { postJson } = await import('./api.js')
    const result = await postJson<{ ok: number }>('/api/oauth/start')

    expect(result).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/oauth/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })

  it('postJson serializes a body when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { postJson } = await import('./api.js')
    await postJson('/api/foo', { hello: 'world' })

    const init = fetchMock.mock.lastCall?.[1] as RequestInit | undefined
    expect(init?.body).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('postJson without a body omits the body field', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { postJson } = await import('./api.js')
    await postJson('/api/foo')

    const init = fetchMock.mock.lastCall?.[1] as RequestInit | undefined
    expect(init?.body).toBeUndefined()
  })

  it('getJson throws on non-2xx with the response body in the error message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('something bad happened', { status: 500 }))
    const { getJson } = await import('./api.js')
    await expect(getJson('/api/accounts')).rejects.toThrow(/something bad happened/)
  })

  it('postJson throws on non-2xx with the response body in the error message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 400 }))
    const { postJson } = await import('./api.js')
    await expect(postJson('/api/foo')).rejects.toThrow(/nope/)
  })
})
