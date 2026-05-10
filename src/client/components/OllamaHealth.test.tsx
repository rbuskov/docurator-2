import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OllamaHealth as OllamaHealthBody } from '../types.js'
import { OllamaHealth } from './OllamaHealth.js'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.useRealTimers()
})

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function jsonResponse(body: OllamaHealthBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OllamaHealth', () => {
  it('shows a loading message before the first fetch resolves', () => {
    let resolve: (r: Response) => void = () => {}
    globalThis.fetch = (() =>
      new Promise<Response>((r) => {
        resolve = r
      })) as unknown as typeof fetch
    render(<OllamaHealth />)
    expect(screen.getByText(/loading ollama/i)).toBeDefined()
    // Clean up the dangling fetch so the test can finish.
    resolve(jsonResponse({ reachable: true, model: 'm', model_available: true }))
  })

  it('renders the green ready label when reachable and model is available', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        reachable: true,
        model: 'qwen2.5vl:7b',
        model_available: true,
      })) as unknown as typeof fetch
    render(<OllamaHealth />)
    await waitFor(() => {
      expect(screen.getByText(/ollama: qwen2\.5vl:7b ready/i)).toBeDefined()
    })
    const pill = screen.getByText(/ollama: qwen2\.5vl:7b ready/i)
    expect(pill.getAttribute('data-state')).toBe('ready')
  })

  it('renders the yellow not-pulled label when reachable but model is missing', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        reachable: true,
        model: 'qwen2.5vl:7b',
        model_available: false,
      })) as unknown as typeof fetch
    render(<OllamaHealth />)
    await waitFor(() => {
      expect(screen.getByText(/ollama reachable.*not pulled/i)).toBeDefined()
    })
    expect(screen.getByText(/ollama pull qwen2\.5vl:7b/i)).toBeDefined()
    const pill = screen.getByTestId('ollama-health-pill')
    expect(pill.getAttribute('data-state')).toBe('model_missing')
  })

  it('renders the red unreachable label when reachable=false', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        reachable: false,
        model: 'qwen2.5vl:7b',
        model_available: false,
        error: 'unreachable: ECONNREFUSED',
      })) as unknown as typeof fetch
    render(<OllamaHealth />)
    await waitFor(() => {
      expect(screen.getByText(/ollama unreachable/i)).toBeDefined()
    })
    const pill = screen.getByTestId('ollama-health-pill')
    expect(pill.getAttribute('data-state')).toBe('unreachable')
  })

  it('polls /api/ollama/health every 30 s', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reachable: true, model: 'm', model_available: true }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<OllamaHealth />)
    // Initial fetch is async; let it resolve.
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('renders the unreachable label when fetch itself rejects', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    render(<OllamaHealth />)
    await waitFor(() => {
      expect(screen.getByText(/ollama unreachable/i)).toBeDefined()
    })
  })
})
