import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_OLLAMA_MODEL = process.env.OLLAMA_MODEL

afterEach(() => {
  if (ORIGINAL_OLLAMA_MODEL === undefined) {
    delete process.env.OLLAMA_MODEL
  } else {
    process.env.OLLAMA_MODEL = ORIGINAL_OLLAMA_MODEL
  }
})

beforeEach(() => {
  vi.resetModules()
})

type ListModelsFn = (args: { baseUrl: string; timeoutMs: number }) => Promise<string[]>

async function buildApp(deps: { listModels: ListModelsFn }) {
  const { registerOllamaRoutes } = await import('./ollama.js')
  const a = new Hono()
  registerOllamaRoutes(a, deps)
  return a
}

describe('GET /api/ollama/health', () => {
  it('returns reachable=true and model_available=true when the configured model is in the list', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const app = await buildApp({
      listModels: async () => ['qwen2.5vl:7b', 'llama3:8b'],
    })
    const res = await app.fetch(new Request('http://x/api/ollama/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      reachable: true,
      model: 'qwen2.5vl:7b',
      model_available: true,
    })
  })

  it('returns reachable=true and model_available=false when the model is missing', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const app = await buildApp({
      listModels: async () => ['llama3:8b'],
    })
    const res = await app.fetch(new Request('http://x/api/ollama/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      reachable: true,
      model: 'qwen2.5vl:7b',
      model_available: false,
    })
  })

  it('returns reachable=false with an error string when listModels throws OllamaUnreachableError', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const { OllamaUnreachableError } = await import('../classify/ollama.js')
    const app = await buildApp({
      listModels: async () => {
        throw new OllamaUnreachableError('ECONNREFUSED')
      },
    })
    const res = await app.fetch(new Request('http://x/api/ollama/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.reachable).toBe(false)
    expect(body.model).toBe('qwen2.5vl:7b')
    expect(body.model_available).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.error as string).toMatch(/unreachable/i)
  })

  it('returns reachable=true and model_available=false with an http_<status> error when listModels throws OllamaHttpError', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const { OllamaHttpError } = await import('../classify/ollama.js')
    const app = await buildApp({
      listModels: async () => {
        throw new OllamaHttpError(500, 'boom')
      },
    })
    const res = await app.fetch(new Request('http://x/api/ollama/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      reachable: true,
      model: 'qwen2.5vl:7b',
      model_available: false,
      error: 'http_500',
    })
  })

  it('passes a tight 5s timeout to listModels (not the full 120s classify timeout)', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const listModels = vi.fn<ListModelsFn>(async () => ['qwen2.5vl:7b'])
    const app = await buildApp({ listModels })
    await app.fetch(new Request('http://x/api/ollama/health'))
    expect(listModels).toHaveBeenCalledTimes(1)
    const args = listModels.mock.calls[0]?.[0]
    expect(args?.timeoutMs).toBe(5000)
  })

  it('returns 200 (not non-2xx) on every code path so the badge gets a structured payload', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5vl:7b'
    const { OllamaUnreachableError } = await import('../classify/ollama.js')
    const app = await buildApp({
      listModels: async () => {
        throw new OllamaUnreachableError('down')
      },
    })
    const res = await app.fetch(new Request('http://x/api/ollama/health'))
    // Even on the unreachable path the endpoint returns 200 — the body's
    // `reachable` field carries the signal.
    expect(res.status).toBe(200)
  })
})
