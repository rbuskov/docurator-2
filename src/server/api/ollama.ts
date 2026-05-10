import type { Hono } from 'hono'
import {
  listModels as defaultListModels,
  OllamaHttpError,
  OllamaUnreachableError,
} from '../classify/ollama.js'
import { config } from '../config.js'

// The health badge polls every 30s; a 5s ceiling on this probe means the badge
// flips to red within a tight window when Ollama goes down. The full 120s
// `OLLAMA_TIMEOUT_MS` is reserved for the per-classify endpoint.
const HEALTH_TIMEOUT_MS = 5000

export type ListModelsFn = (args: {
  baseUrl: string
  timeoutMs: number
}) => Promise<string[]>

export type OllamaRouteDeps = {
  listModels?: ListModelsFn
}

export function registerOllamaRoutes(app: Hono, deps: OllamaRouteDeps = {}): void {
  const _listModels = deps.listModels ?? defaultListModels

  app.get('/api/ollama/health', async (c) => {
    const model = config.ollamaModel
    try {
      const names = await _listModels({
        baseUrl: config.ollamaUrl,
        timeoutMs: HEALTH_TIMEOUT_MS,
      })
      return c.json({
        reachable: true,
        model,
        model_available: names.includes(model),
      })
    } catch (err) {
      if (err instanceof OllamaUnreachableError) {
        return c.json({
          reachable: false,
          model,
          model_available: false,
          error: `unreachable: ${err.message}`,
        })
      }
      if (err instanceof OllamaHttpError) {
        return c.json({
          reachable: true,
          model,
          model_available: false,
          error: `http_${err.status}`,
        })
      }
      // Unknown error — surface as unreachable with the message so the badge
      // shows something rather than spinning forever.
      const message = err instanceof Error ? err.message : 'unknown'
      return c.json({
        reachable: false,
        model,
        model_available: false,
        error: `unreachable: ${message}`,
      })
    }
  })
}
