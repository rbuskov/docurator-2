import { useEffect, useState } from 'react'
import { AccountPicker } from '../components/AccountPicker.js'
import type { Account, ProcessedMessage } from '../types.js'

type SeedStatus =
  | { kind: 'idle' }
  | { kind: 'success'; inserted: number; skipped: number }
  | { kind: 'needs_reauth' }
  | { kind: 'gmail_error'; message: string }
  | { kind: 'not_connected' }
  | { kind: 'unexpected'; message: string }

const SEED_COUNT = 10

export function DevSeedPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [rows, setRows] = useState<ProcessedMessage[] | null>(null)
  const [status, setStatus] = useState<SeedStatus>({ kind: 'idle' })
  const [seeding, setSeeding] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/dev/enabled')
        if (cancelled) return
        if (!res.ok) {
          setEnabled(false)
          return
        }
        const data = (await res.json()) as { enabled?: boolean }
        setEnabled(data.enabled === true)
      } catch {
        if (!cancelled) setEnabled(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (enabled !== true) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/accounts')
        if (cancelled) return
        if (!res.ok) {
          setAccounts([])
          return
        }
        const data = (await res.json()) as { accounts: Account[] }
        if (cancelled) return
        setAccounts(data.accounts)
        const firstConnected = data.accounts.find((a) => a.status === 'connected')
        if (firstConnected !== undefined) {
          setSelectedAccountId(firstConnected.id)
        }
      } catch {
        if (!cancelled) setAccounts([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  useEffect(() => {
    if (selectedAccountId === null) {
      setRows(null)
      return
    }
    let cancelled = false
    setStatus({ kind: 'idle' })
    void (async () => {
      try {
        const res = await fetch(
          `/api/accounts/${selectedAccountId}/processed-messages?limit=50`,
        )
        if (cancelled) return
        if (!res.ok) {
          setRows([])
          return
        }
        const data = (await res.json()) as { rows: ProcessedMessage[] }
        if (cancelled) return
        setRows(data.rows)
      } catch {
        if (!cancelled) setRows([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedAccountId])

  async function handleSeed() {
    if (selectedAccountId === null) return
    setSeeding(true)
    try {
      const res = await fetch('/api/dev/processed-messages/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: selectedAccountId, count: SEED_COUNT }),
      })
      if (res.status === 401) {
        setStatus({ kind: 'needs_reauth' })
        return
      }
      if (res.status === 409) {
        setStatus({ kind: 'not_connected' })
        return
      }
      if (res.status === 502) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setStatus({ kind: 'gmail_error', message: body.message ?? 'unknown error' })
        return
      }
      if (!res.ok) {
        setStatus({
          kind: 'unexpected',
          message: `Status ${res.status}`,
        })
        return
      }
      const data = (await res.json()) as { inserted: number; skipped: number }
      setStatus({ kind: 'success', inserted: data.inserted, skipped: data.skipped })
      // Refetch the table to show the newly inserted rows.
      const refresh = await fetch(
        `/api/accounts/${selectedAccountId}/processed-messages?limit=50`,
      )
      if (refresh.ok) {
        const refreshData = (await refresh.json()) as { rows: ProcessedMessage[] }
        setRows(refreshData.rows)
      }
    } catch (err) {
      setStatus({
        kind: 'unexpected',
        message: err instanceof Error ? err.message : 'Failed to seed',
      })
    } finally {
      setSeeding(false)
    }
  }

  if (enabled !== true) return null
  if (accounts === null) return <p>Loading…</p>

  const hasConnected = accounts.some((a) => a.status === 'connected')

  return (
    <section>
      <h2>Dev tools</h2>
      <AccountPicker
        accounts={accounts}
        value={selectedAccountId}
        onChange={(id) => setSelectedAccountId(id)}
        includeDisconnected={false}
      />
      {hasConnected && (
        <>
          <button
            type="button"
            disabled={seeding || selectedAccountId === null}
            onClick={() => void handleSeed()}
          >
            Mark first 10 messages as processed
          </button>
          <p>{statusLine(status, rows)}</p>
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Sender</th>
                <th>Processed at</th>
                <th>Classification</th>
                <th>Confidence</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={`${r.message_id}-${r.processed_at}`}>
                  <td>{r.subject ?? '—'}</td>
                  <td>{r.sender_domain ?? '—'}</td>
                  <td>{r.processed_at}</td>
                  <td>{r.classification ?? '—'}</td>
                  <td>{r.confidence ?? '—'}</td>
                  <td>{r.model_used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function statusLine(status: SeedStatus, rows: ProcessedMessage[] | null): string {
  switch (status.kind) {
    case 'success':
      return `inserted ${status.inserted}, skipped ${status.skipped}`
    case 'needs_reauth':
      return 'This account needs to be reconnected — go to the Dashboard.'
    case 'gmail_error':
      return `Gmail returned an error: ${status.message}`
    case 'not_connected':
      return 'Account is not currently connected — try Reconnect on the Dashboard.'
    case 'unexpected':
      return `Unexpected error: ${status.message}`
    case 'idle':
      if (rows !== null && rows.length === 0) return 'No rows yet for this account.'
      return ''
  }
}
