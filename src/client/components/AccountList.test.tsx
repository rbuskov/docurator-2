import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../types.js'
import { AccountList } from './AccountList.js'

const alice: Account = {
  id: 1,
  email: 'alice@example.com',
  display_name: null,
  slug: 'alice-at-example-com',
  status: 'connected',
  connected_at: '2026-05-09T10:00:00Z',
  last_seen_at: null,
}

const bob: Account = {
  id: 2,
  email: 'bob@example.com',
  display_name: 'Bob (work)',
  slug: 'bob-at-example-com',
  status: 'needs_reauth',
  connected_at: '2026-05-09T11:00:00Z',
  last_seen_at: null,
}

describe('AccountList', () => {
  it('renders an empty-state message when no accounts are connected', () => {
    render(<AccountList accounts={[]} onReconnect={() => {}} />)
    expect(screen.getByText(/no accounts connected/i)).toBeDefined()
  })

  it('renders one row per account showing email and the status text', () => {
    render(<AccountList accounts={[alice]} onReconnect={() => {}} />)
    expect(screen.getByText('alice@example.com')).toBeDefined()
    expect(screen.getAllByText(/connected/i).length).toBeGreaterThan(0)
  })

  it('renders display_name alongside email when set', () => {
    render(<AccountList accounts={[bob]} onReconnect={() => {}} />)
    expect(screen.getByText('Bob (work)')).toBeDefined()
    expect(screen.getByText('bob@example.com')).toBeDefined()
  })

  it('renders the Reconnect button only on rows whose status is needs_reauth', () => {
    render(<AccountList accounts={[alice, bob]} onReconnect={() => {}} />)
    const buttons = screen.getAllByRole('button', { name: /reconnect/i })
    expect(buttons).toHaveLength(1)
  })

  it('clicking Reconnect calls onReconnect with the account id', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(<AccountList accounts={[bob]} onReconnect={onReconnect} />)

    await user.click(screen.getByRole('button', { name: /reconnect/i }))
    expect(onReconnect).toHaveBeenCalledWith(2)
  })

  it('renders the needs_reauth status text on those rows', () => {
    render(<AccountList accounts={[bob]} onReconnect={() => {}} />)
    expect(screen.getByText(/needs reauth/i)).toBeDefined()
  })
})
