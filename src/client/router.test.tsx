import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Nav } from './components/Nav.js'
import { AppRoutes } from './router.js'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AppRoutes', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.localStorage.clear()
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accounts: [] }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the Dashboard at "/"', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Nav />
        <AppRoutes />
      </MemoryRouter>,
    )

    // Dashboard's empty-state CTA from AccountList renders once accounts resolves to [].
    await waitFor(() => screen.getByRole('button', { name: /add gmail account/i }))
  })

  it('renders the Inbox at "/inbox"', async () => {
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Nav />
        <AppRoutes />
      </MemoryRouter>,
    )

    await waitFor(() => screen.getByText(/no accounts connected/i))
    expect(screen.queryByRole('button', { name: /add gmail account/i })).toBeNull()
  })

  it('navigates from "/" to "/inbox" when the Inbox link is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Nav />
        <AppRoutes />
      </MemoryRouter>,
    )

    await waitFor(() => screen.getByRole('button', { name: /add gmail account/i }))
    await userEvent.click(screen.getByRole('link', { name: 'Inbox' }))

    await waitFor(() => screen.getByText(/no accounts connected/i))
    expect(screen.queryByRole('button', { name: /add gmail account/i })).toBeNull()
  })
})
