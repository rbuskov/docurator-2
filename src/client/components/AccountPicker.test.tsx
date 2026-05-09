import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../types.js'
import { AccountPicker } from './AccountPicker.js'

const connectedA: Account = {
  id: 1,
  email: 'alice@example.com',
  display_name: null,
  slug: 'alice-at-example-com',
  connected_at: '2026-05-09T10:00:00Z',
  last_seen_at: null,
  status: 'connected',
}

const connectedB: Account = {
  id: 2,
  email: 'bob@example.com',
  display_name: 'Bob (work)',
  slug: 'bob-at-example-com',
  connected_at: '2026-05-09T11:00:00Z',
  last_seen_at: null,
  status: 'connected',
}

const needsReauthC: Account = {
  id: 3,
  email: 'carol@example.com',
  display_name: null,
  slug: 'carol-at-example-com',
  connected_at: '2026-05-09T12:00:00Z',
  last_seen_at: null,
  status: 'needs_reauth',
}

describe('<AccountPicker />', () => {
  it('renders the empty-state message when no accounts are connectable', () => {
    render(<AccountPicker accounts={[]} value={null} onChange={() => {}} />)

    expect(
      screen.getByText(/No connected accounts\. Connect one on the Dashboard\./i),
    ).toBeDefined()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('renders one option per account and reflects the current value', () => {
    render(
      <AccountPicker
        accounts={[connectedA, connectedB]}
        value={connectedA.id}
        onChange={() => {}}
      />,
    )

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe(String(connectedA.id))
    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    expect(options).toHaveLength(2)
    expect(options[0]?.value).toBe(String(connectedA.id))
    expect(options[1]?.value).toBe(String(connectedB.id))
  })

  it('fires onChange with the selected account id (as a number)', async () => {
    const onChange = vi.fn()
    render(
      <AccountPicker
        accounts={[connectedA, connectedB]}
        value={connectedA.id}
        onChange={onChange}
      />,
    )

    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, String(connectedB.id))

    expect(onChange).toHaveBeenCalledWith(connectedB.id)
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('number')
  })

  it('shows needs_reauth options as disabled with a "reconnect" suffix when includeDisconnected is true', () => {
    render(
      <AccountPicker
        accounts={[connectedA, connectedB, needsReauthC]}
        value={connectedA.id}
        onChange={() => {}}
        includeDisconnected
      />,
    )

    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    expect(options).toHaveLength(3)

    const carol = options.find((o) => o.value === String(needsReauthC.id))
    expect(carol).toBeDefined()
    expect(carol?.disabled).toBe(true)
    expect(carol?.textContent ?? '').toMatch(
      /needs reauth.*reconnect on Dashboard/i,
    )

    const alice = options.find((o) => o.value === String(connectedA.id))
    const bob = options.find((o) => o.value === String(connectedB.id))
    expect(alice?.disabled).toBe(false)
    expect(bob?.disabled).toBe(false)
  })

  it('filters out needs_reauth accounts when includeDisconnected is false', () => {
    render(
      <AccountPicker
        accounts={[connectedA, connectedB, needsReauthC]}
        value={connectedA.id}
        onChange={() => {}}
        includeDisconnected={false}
      />,
    )

    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.value)).not.toContain(String(needsReauthC.id))
  })

  it('renders the empty state when only needs_reauth accounts are present', () => {
    render(
      <AccountPicker
        accounts={[needsReauthC]}
        value={null}
        onChange={() => {}}
        includeDisconnected
      />,
    )

    expect(
      screen.getByText(/No connected accounts\. Connect one on the Dashboard\./i),
    ).toBeDefined()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
