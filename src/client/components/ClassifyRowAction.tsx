import { useState } from 'react'
import type { ClassificationResult } from '../types.js'

type State =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; verdict: ClassificationResult }
  | { kind: 'unreachable' }
  | { kind: 'parse_error'; raw_response: string }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'needs_reauth' }
  | { kind: 'error'; message: string }

export type ClassifyRowActionProps = {
  account_id: number
  message_id: string
}

export function ClassifyRowAction({ account_id, message_id }: ClassifyRowActionProps) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function classify() {
    setState({ kind: 'pending' })
    try {
      const res = await fetch(
        `/api/accounts/${account_id}/messages/${encodeURIComponent(message_id)}/classify`,
        { method: 'POST' },
      )
      if (res.status === 200) {
        const verdict = (await res.json()) as ClassificationResult
        setState({ kind: 'success', verdict })
        return
      }
      if (res.status === 503) {
        setState({ kind: 'unreachable' })
        return
      }
      if (res.status === 401) {
        setState({ kind: 'needs_reauth' })
        return
      }
      if (res.status === 502) {
        const body = (await res.json().catch(() => ({}))) as
          | { error?: string; raw_response?: string; status?: number; body?: string }
          | Record<string, unknown>
        const error = (body as { error?: string }).error
        if (error === 'ollama_parse_error') {
          const raw = typeof (body as { raw_response?: unknown }).raw_response === 'string'
            ? ((body as { raw_response: string }).raw_response)
            : ''
          setState({ kind: 'parse_error', raw_response: raw })
          return
        }
        if (error === 'ollama_http_error') {
          setState({
            kind: 'http_error',
            status: typeof (body as { status?: unknown }).status === 'number'
              ? (body as { status: number }).status
              : 0,
            body: typeof (body as { body?: unknown }).body === 'string'
              ? (body as { body: string }).body
              : '',
          })
          return
        }
        // gmail_error or other 502
        const message =
          typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : 'Gmail returned an error'
        setState({ kind: 'error', message })
        return
      }
      // Any other non-2xx
      setState({
        kind: 'error',
        message: `Unexpected error: status ${res.status}`,
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'classify failed',
      })
    }
  }

  if (state.kind === 'idle') {
    return (
      <button type="button" onClick={() => void classify()}>
        Classify
      </button>
    )
  }
  if (state.kind === 'pending') {
    return <span data-testid="classify-status">Classifying…</span>
  }
  if (state.kind === 'success') {
    const v = state.verdict
    return (
      <span data-testid="classify-result" data-verdict={v.classification}>
        <strong>{v.classification}</strong>
        {' · '}
        <span>{v.confidence} confidence</span>
        {' · '}
        <span>{v.reason}</span>
      </span>
    )
  }
  if (state.kind === 'unreachable') {
    return (
      <span data-testid="classify-error" data-error="ollama_unreachable">
        Ollama unreachable.{' '}
        <button type="button" onClick={() => void classify()}>
          Retry
        </button>
      </span>
    )
  }
  if (state.kind === 'parse_error') {
    return (
      <span data-testid="classify-error" data-error="ollama_parse_error">
        Parse error from Ollama.{' '}
        <details>
          <summary>Raw response</summary>
          <pre>{state.raw_response}</pre>
        </details>
        <button type="button" onClick={() => void classify()}>
          Retry
        </button>
      </span>
    )
  }
  if (state.kind === 'http_error') {
    return (
      <span data-testid="classify-error" data-error="ollama_http_error">
        Ollama error {state.status}: {state.body}{' '}
        <button type="button" onClick={() => void classify()}>
          Retry
        </button>
      </span>
    )
  }
  if (state.kind === 'needs_reauth') {
    return (
      <span data-testid="classify-error" data-error="needs_reauth">
        Account needs to be reconnected — go to the Dashboard.
      </span>
    )
  }
  // error
  return (
    <span data-testid="classify-error" data-error="generic">
      Error: {state.message}{' '}
      <button type="button" onClick={() => void classify()}>
        Retry
      </button>
    </span>
  )
}
