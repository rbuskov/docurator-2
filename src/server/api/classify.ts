import { zValidator } from '@hono/zod-validator'
import type { Hono } from 'hono'
import { z } from 'zod'
import { isInvalidGrantError } from '../auth/invalid-grant.js'
import { requireConnectedAccount } from '../auth/preconditions.js'
import {
  classifyMessage as defaultClassifyMessage,
  type ClassifyMessageArgs,
  type ClassifyMessageDeps,
  type ClassifyResponse,
} from '../classify/index.js'
import {
  OllamaHttpError,
  OllamaParseError,
  OllamaUnreachableError,
} from '../classify/ollama.js'
import { config } from '../config.js'

const paramsSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
  // Gmail message ids are URL-safe base64-style: alphanumerics plus hyphen and
  // underscore. Cap at 64 chars (Gmail returns 16-char ids; the cap is
  // defensive, generous, and bounded).
  message_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
})

export type ClassifyMessageFn = (
  args: ClassifyMessageArgs,
  deps: ClassifyMessageDeps,
) => Promise<ClassifyResponse>

export type ClassifyRouteDeps = {
  classifyMessage?: ClassifyMessageFn
}

export function registerClassifyRoutes(app: Hono, deps: ClassifyRouteDeps = {}): void {
  const _classifyMessage = deps.classifyMessage ?? defaultClassifyMessage

  app.post(
    '/api/accounts/:id/messages/:message_id/classify',
    zValidator('param', paramsSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'invalid_params' }, 400)
      }
    }),
    async (c) => {
      const { id, message_id } = c.req.valid('param')

      const pre = requireConnectedAccount(id)
      if (!pre.ok) return c.json(pre.body, pre.status)

      try {
        const verdict = await _classifyMessage(
          { account_id: id, message_id },
          {
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel,
            ollamaTimeoutMs: config.ollamaTimeoutMs,
          },
        )
        return c.json(verdict)
      } catch (err) {
        if (err instanceof OllamaUnreachableError) {
          return c.json({ error: 'ollama_unreachable' }, 503)
        }
        if (err instanceof OllamaParseError) {
          return c.json(
            { error: 'ollama_parse_error', raw_response: err.rawResponse },
            502,
          )
        }
        if (err instanceof OllamaHttpError) {
          return c.json(
            { error: 'ollama_http_error', status: err.status, body: err.body },
            502,
          )
        }
        if (isInvalidGrantError(err)) {
          return c.json({ error: 'needs_reauth', account_id: id }, 401)
        }
        const message = err instanceof Error ? err.message : 'classify failed'
        return c.json({ error: 'gmail_error', message }, 502)
      }
    },
  )
}
