// Thin HTTP client for Ollama's /api/chat and /api/tags. No SDK — the surface
// is small enough that 80 lines is clearer than a dependency. Both functions
// take an explicit `baseUrl` and `timeoutMs`; callers pass them from
// `config.ollamaUrl` / `config.ollamaTimeoutMs` so this module stays trivially
// fakeable in tests.

export type OllamaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string }

export type ChatArgs = {
  baseUrl: string
  model: string
  messages: OllamaMessage[]
  format?: 'json'
  timeoutMs: number
}

export type ListModelsArgs = {
  baseUrl: string
  timeoutMs: number
}

// Network-level failures and request-aborted-on-timeout both surface as this.
// Mapped to HTTP 503 by the API layer.
export class OllamaUnreachableError extends Error {
  override name = 'OllamaUnreachableError'
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
  }
}

// Non-2xx HTTP response from a reachable Ollama. Mapped to HTTP 502 by the
// API layer with the body included for debugging.
export class OllamaHttpError extends Error {
  override name = 'OllamaHttpError'
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Ollama returned HTTP ${status}: ${body.slice(0, 200)}`)
  }
}

// Ollama returned a 2xx response but the assistant content failed to parse
// as JSON, or the parsed value did not match `classificationSchema`. The
// orchestrator constructs this with the raw response so the API layer can
// surface it in the 502 body for debugging.
export class OllamaParseError extends Error {
  override name = 'OllamaParseError'
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message)
  }
}

export async function chat(args: ChatArgs): Promise<string> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/api/chat`
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: false,
  }
  if (args.format !== undefined) body.format = args.format

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, args.timeoutMs)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new OllamaHttpError(res.status, text)
  }
  const json = (await res.json().catch(() => null)) as
    | { message?: { content?: unknown } }
    | null
  const content = json?.message?.content
  if (typeof content !== 'string') {
    throw new Error('Ollama response missing message.content string')
  }
  return content
}

export async function listModels(args: ListModelsArgs): Promise<string[]> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/api/tags`
  const res = await fetchWithTimeout(url, { method: 'GET' }, args.timeoutMs)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new OllamaHttpError(res.status, text)
  }
  const json = (await res.json().catch(() => null)) as
    | { models?: Array<{ name?: unknown }> }
    | null
  if (!json || !Array.isArray(json.models)) return []
  const out: string[] = []
  for (const m of json.models) {
    if (typeof m.name === 'string') out.push(m.name)
  }
  return out
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || isAbort(err))) {
      throw new OllamaUnreachableError(
        `Ollama request timed out after ${timeoutMs} ms`,
        err,
      )
    }
    throw new OllamaUnreachableError(
      err instanceof Error ? `Ollama request failed: ${err.message}` : 'Ollama request failed',
      err,
    )
  } finally {
    clearTimeout(timer)
  }
}

function isAbort(err: Error): boolean {
  // Some fetch implementations wrap the AbortError; check the cause too.
  if (err.name === 'AbortError') return true
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause instanceof Error && cause.name === 'AbortError') return true
  return false
}
