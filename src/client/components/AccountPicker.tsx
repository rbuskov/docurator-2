import type { Account } from '../types.js'

export type AccountPickerProps = {
  accounts: Account[]
  value: number | null
  onChange: (accountId: number) => void
  includeDisconnected?: boolean
}

export function AccountPicker({
  accounts,
  value,
  onChange,
  includeDisconnected = true,
}: AccountPickerProps) {
  const visible = includeDisconnected
    ? accounts
    : accounts.filter((a) => a.status === 'connected')
  const hasSelectable = visible.some((a) => a.status === 'connected')

  if (!hasSelectable) {
    return <p>No connected accounts. Connect one on the Dashboard.</p>
  }

  return (
    <select
      aria-label="Account"
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {visible.map((account) => {
        const label = labelFor(account)
        return (
          <option
            key={account.id}
            value={account.id}
            disabled={account.status !== 'connected'}
          >
            {label}
          </option>
        )
      })}
    </select>
  )
}

function labelFor(account: Account): string {
  const base = account.display_name ?? account.email
  if (account.status === 'needs_reauth') {
    return `${base} (needs reauth — reconnect on Dashboard)`
  }
  return base
}
