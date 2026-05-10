import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClassificationResult } from '../types.js'
import { ClassifyRowAction } from './ClassifyRowAction.js'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function happyVerdict(): ClassificationResult {
  return {
    classification: 'receipt',
    confidence: 'high',
    reason: 'Stripe-shaped receipt',
    vendor: 'Stripe',
    amount: 9.99,
    currency: 'USD',
    transaction_date: '2026-05-01',
    model_used: 'qwen2.5vl:7b',
    artifacts: [{ kind: 'body', mime_type: 'text/plain' }],
  }
}

describe('ClassifyRowAction', () => {
  it('renders a Classify button initially', () => {
    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    expect(screen.getByRole('button', { name: /classify/i })).toBeDefined()
  })

  it('POSTs to the per-message classify endpoint and renders the verdict on success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(happyVerdict()))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={42} message_id="msgABC" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/accounts/42/messages/msgABC/classify',
      expect.objectContaining({ method: 'POST' }),
    )

    await waitFor(() => {
      expect(screen.getByTestId('classify-result')).toBeDefined()
    })
    const result = screen.getByTestId('classify-result')
    expect(result.getAttribute('data-verdict')).toBe('receipt')
    expect(result.textContent).toContain('high')
    expect(result.textContent).toContain('Stripe-shaped receipt')
  })

  it('shows a spinner / pending text while the request is in flight', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    globalThis.fetch = (() =>
      new Promise<Response>((r) => {
        resolveFetch = r
      })) as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    expect(screen.getByText(/classifying/i)).toBeDefined()
    // Resolve to clean up.
    resolveFetch(jsonResponse(happyVerdict()))
  })

  it('renders an Ollama-unreachable chip with a Retry button on a 503', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'ollama_unreachable' }, 503)) as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    await waitFor(() => {
      expect(screen.getByText(/ollama unreachable/i)).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined()
  })

  it('renders an ollama_parse_error chip and surfaces the raw_response inside <details>', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          error: 'ollama_parse_error',
          raw_response: '{ "classification":"spam"',
        },
        502,
      )) as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    await waitFor(() => {
      expect(screen.getByText(/parse error/i)).toBeDefined()
    })
    // Raw response is surfaced via a <details> block.
    const details = screen.getByText(/raw response/i).closest('details')
    expect(details).toBeDefined()
    expect(details?.textContent).toContain('"classification":"spam"')
  })

  it('renders a needs-reauth chip on a 401', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'needs_reauth', account_id: 1 }, 401)) as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    await waitFor(() => {
      expect(screen.getByText(/needs.*reconnect/i)).toBeDefined()
    })
  })

  it('Retry click after an error re-issues the POST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'ollama_unreachable' }, 503))
      .mockResolvedValueOnce(jsonResponse(happyVerdict()))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeDefined()
    })
    await user.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => {
      expect(screen.getByTestId('classify-result')).toBeDefined()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('renders a generic error chip on an unexpected status code', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch
    const user = userEvent.setup()

    render(<ClassifyRowAction account_id={1} message_id="m1" />)
    await user.click(screen.getByRole('button', { name: /classify/i }))

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeDefined()
    })
  })
})
