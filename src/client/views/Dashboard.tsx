import { useEffect, useState } from 'react'
import { getJson, postJson } from '../api.js'
import { AccountList } from '../components/AccountList.js'
import { AddAccountButton } from '../components/AddAccountButton.js'
import { useAccountsPoll } from '../hooks/useAccountsPoll.js'
import type { Account } from '../types.js'

export type DashboardProps = {
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export function Dashboard({ pollIntervalMs, pollTimeoutMs }: DashboardProps) {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reconnectingId, setReconnectingId] = useState<number | null>(null)

  async function loadAccounts() {
    try {
      const data = await getJson<{ accounts: Account[] }>('/api/accounts')
      setAccounts(data.accounts)
      setError(null)
    } catch (err) {
      setAccounts((prev) => prev ?? [])
      setError(err instanceof Error ? err.message : 'Failed to load accounts.')
    }
  }

  useEffect(() => {
    void loadAccounts()
  }, [])

  async function handleReconnect(id: number) {
    setError(null)
    try {
      const { consent_url } = await postJson<{ consent_url: string; state: string }>(
        `/api/accounts/${id}/reconnect`,
      )
      window.open(consent_url, '_blank', 'noopener,noreferrer')
      setReconnectingId(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start reconnect.')
    }
  }

  function handleAdded(account: Account) {
    setAccounts((prev) => (prev !== null ? [...prev, account] : [account]))
  }

  useAccountsPoll({
    enabled: reconnectingId !== null,
    done: (latest) => {
      if (reconnectingId === null) return false
      const target = latest.find((a) => a.id === reconnectingId)
      if (target !== undefined && target.status === 'connected') {
        setAccounts(latest)
        setReconnectingId(null)
        return true
      }
      return false
    },
    onTimeout: () => {
      setReconnectingId(null)
      setError('Reconnect took too long — try again.')
    },
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
  })

  if (accounts === null && error === null) {
    return (
      <main>
        <h1>Docurator</h1>
        <p>Loading…</p>
      </main>
    )
  }

  const list = accounts ?? []

  return (
    <main>
      <h1>Docurator</h1>
      {error !== null && <p role="alert">{error}</p>}
      <AccountList accounts={list} onReconnect={handleReconnect} />
      <AddAccountButton
        baselineIds={list.map((a) => a.id)}
        onAdded={handleAdded}
        pollIntervalMs={pollIntervalMs}
        pollTimeoutMs={pollTimeoutMs}
      />
    </main>
  )
}
