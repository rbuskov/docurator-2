import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chat,
  listModels,
  OllamaHttpError,
  OllamaUnreachableError,
} from './ollama.js'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchMockFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

describe('chat', () => {
  it('POSTs the right URL and body shape and returns the assistant content', async () => {
    const fetchMock = vi.fn<FetchMockFn>(async () =>
      jsonResponse({ message: { role: 'assistant', content: '{"hello":1}' } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await chat({
      baseUrl: 'http://ollama',
      model: 'qwen2.5vl:7b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user', images: ['aGVsbG8='] },
      ],
      format: 'json',
      timeoutMs: 5000,
    })
    expect(result).toBe('{"hello":1}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://ollama/api/chat')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({
      model: 'qwen2.5vl:7b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user', images: ['aGVsbG8='] },
      ],
      format: 'json',
      stream: false,
    })
  })

  it('does not include the format field when undefined', async () => {
    const fetchMock = vi.fn<FetchMockFn>(async () =>
      jsonResponse({ message: { content: 'ok' } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await chat({
      baseUrl: 'http://ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'u' }],
      timeoutMs: 1000,
    })
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(body.format).toBeUndefined()
  })

  it('throws OllamaHttpError on a non-2xx response, exposing status and body', async () => {
    globalThis.fetch = (async () =>
      new Response('Internal Server Error', { status: 500 })) as unknown as typeof fetch

    await expect(
      chat({
        baseUrl: 'http://ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'u' }],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: 'OllamaHttpError',
      status: 500,
      body: 'Internal Server Error',
    })
    await expect(
      chat({
        baseUrl: 'http://ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'u' }],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(OllamaHttpError)
  })

  it('wraps a fetch network failure in OllamaUnreachableError', async () => {
    const cause = new Error('fetch failed: ECONNREFUSED')
    globalThis.fetch = (async () => {
      throw cause
    }) as unknown as typeof fetch

    await expect(
      chat({
        baseUrl: 'http://ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'u' }],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(OllamaUnreachableError)
  })

  it('aborts when the timeout elapses and surfaces an OllamaUnreachableError', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted') as Error & { name: string }
            e.name = 'AbortError'
            reject(e)
          })
        }
      })) as unknown as typeof fetch

    await expect(
      chat({
        baseUrl: 'http://ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'u' }],
        timeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(OllamaUnreachableError)
  })

  it('throws when the response shape is missing message.content', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ message: {} })) as unknown as typeof fetch

    await expect(
      chat({
        baseUrl: 'http://ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'u' }],
        timeoutMs: 1000,
      }),
    ).rejects.toThrow()
  })
})

describe('listModels', () => {
  it('returns names from response.models[].name', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        models: [
          { name: 'qwen2.5vl:7b', size: 1 },
          { name: 'llama3:8b', size: 2 },
        ],
      })) as unknown as typeof fetch

    const names = await listModels({ baseUrl: 'http://ollama', timeoutMs: 5000 })
    expect(names).toEqual(['qwen2.5vl:7b', 'llama3:8b'])
  })

  it('returns [] when the models array is empty', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ models: [] })) as unknown as typeof fetch

    const names = await listModels({ baseUrl: 'http://ollama', timeoutMs: 5000 })
    expect(names).toEqual([])
  })

  it('returns [] when models is missing from the payload', async () => {
    globalThis.fetch = (async () => jsonResponse({})) as unknown as typeof fetch
    const names = await listModels({ baseUrl: 'http://ollama', timeoutMs: 5000 })
    expect(names).toEqual([])
  })

  it('wraps a network failure in OllamaUnreachableError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch

    await expect(
      listModels({ baseUrl: 'http://ollama', timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(OllamaUnreachableError)
  })

  it('throws OllamaHttpError on a non-2xx response', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch

    await expect(
      listModels({ baseUrl: 'http://ollama', timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(OllamaHttpError)
  })
})

describe('error classes', () => {
  it('OllamaUnreachableError carries a name and message', () => {
    const e = new OllamaUnreachableError('down')
    expect(e.name).toBe('OllamaUnreachableError')
    expect(e.message).toBe('down')
    expect(e).toBeInstanceOf(Error)
  })

  it('OllamaHttpError carries name, status, body, and message', () => {
    const e = new OllamaHttpError(502, 'bad gateway')
    expect(e.name).toBe('OllamaHttpError')
    expect(e.status).toBe(502)
    expect(e.body).toBe('bad gateway')
    expect(e).toBeInstanceOf(Error)
  })
})

beforeEach(() => {
  // Reset fetch between tests in case a previous test failed to clean up.
  globalThis.fetch = ORIGINAL_FETCH
})
