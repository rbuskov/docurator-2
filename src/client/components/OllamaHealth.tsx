import { useEffect, useState } from 'react'
import type { OllamaHealth as OllamaHealthBody } from '../types.js'

const POLL_INTERVAL_MS = 30_000

type PillState = 'loading' | 'ready' | 'model_missing' | 'unreachable'

type Status =
  | { kind: 'loading' }
  | { kind: 'ok'; body: OllamaHealthBody }
  | { kind: 'fetch_error' }

export function OllamaHealth() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function probe() {
      try {
        const res = await fetch('/api/ollama/health')
        if (cancelled) return
        if (!res.ok) {
          setStatus({ kind: 'fetch_error' })
          return
        }
        const body = (await res.json()) as OllamaHealthBody
        if (cancelled) return
        setStatus({ kind: 'ok', body })
      } catch {
        if (!cancelled) setStatus({ kind: 'fetch_error' })
      }
    }

    void probe()
    const id = setInterval(() => void probe(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (status.kind === 'loading') {
    return <span data-testid="ollama-health-pill" data-state="loading">Loading Ollama status…</span>
  }

  if (status.kind === 'fetch_error') {
    // The /api/ollama/health endpoint is supposed to always return 200; if it
    // didn't, treat the failure as Ollama-unreachable for the user's purposes.
    return (
      <span data-testid="ollama-health-pill" data-state="unreachable">
        Ollama unreachable (no health response)
      </span>
    )
  }

  const { body } = status
  const state: PillState = body.reachable
    ? body.model_available
      ? 'ready'
      : 'model_missing'
    : 'unreachable'

  if (state === 'ready') {
    return (
      <span data-testid="ollama-health-pill" data-state="ready">
        Ollama: {body.model} ready
      </span>
    )
  }
  if (state === 'model_missing') {
    return (
      <span data-testid="ollama-health-pill" data-state="model_missing">
        Ollama reachable, model {body.model} not pulled — run{' '}
        <code>ollama pull {body.model}</code>
      </span>
    )
  }
  // unreachable
  return (
    <span data-testid="ollama-health-pill" data-state="unreachable">
      Ollama unreachable{body.error ? ` (${body.error})` : ''}
    </span>
  )
}
