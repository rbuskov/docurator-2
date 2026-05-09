import type { Account } from '../types.js'

export type AccountListProps = {
  accounts: Account[]
  onReconnect: (accountId: number) => void
}

export function AccountList({ accounts, onReconnect }: AccountListProps) {
  if (accounts.length === 0) {
    return (
      <p>No accounts connected yet — click "Add Gmail account" below to get started.</p>
    )
  }

  return (
    <ul>
      {accounts.map((account) => (
        <li key={account.id}>
          {account.display_name !== null && <strong>{account.display_name}</strong>}{' '}
          <span>{account.email}</span>{' '}
          <span aria-label="status">
            {account.status === 'connected' ? 'connected' : 'needs reauth'}
          </span>
          {account.status === 'needs_reauth' && (
            <button onClick={() => onReconnect(account.id)}>Reconnect</button>
          )}
        </li>
      ))}
    </ul>
  )
}
