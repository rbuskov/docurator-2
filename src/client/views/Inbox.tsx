import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountPicker } from '../components/AccountPicker.js'
import type { Account, Document } from '../types.js'

export const LAST_INBOX_ACCOUNT_KEY = 'docurator.lastInboxAccountId'

const DASH = '—'

type ErrorState =
  | { kind: 'none' }
  | { kind: 'unexpected'; message: string }

function readStoredId(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_INBOX_ACCOUNT_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function persistId(id: number): void {
  try {
    window.localStorage.setItem(LAST_INBOX_ACCOUNT_KEY, String(id))
  } catch {
    // private mode / disabled storage — silently ignore
  }
}

function pickInitialAccount(accounts: Account[], storedId: number | null): number | null {
  if (storedId !== null) {
    const stored = accounts.find((a) => a.id === storedId)
    if (stored !== undefined && stored.status === 'connected') {
      return stored.id
    }
  }
  const first = accounts.find((a) => a.status === 'connected')
  return first ? first.id : null
}

function or(value: string | number | null): string {
  return value === null ? DASH : String(value)
}

export function Inbox() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [documents, setDocuments] = useState<Document[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ErrorState>({ kind: 'none' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/accounts')
        if (!res.ok) throw new Error(`GET /api/accounts failed: ${res.status}`)
        const data = (await res.json()) as { accounts: Account[] }
        if (cancelled) return
        setAccounts(data.accounts)
        const initial = pickInitialAccount(data.accounts, readStoredId())
        setSelectedAccountId(initial)
      } catch (err) {
        if (cancelled) return
        setAccounts([])
        setError({
          kind: 'unexpected',
          message: err instanceof Error ? err.message : 'Failed to load accounts',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedAccountId === null) {
      setDocuments(null)
      return
    }
    persistId(selectedAccountId)
    let cancelled = false
    setLoading(true)
    setError({ kind: 'none' })
    setDocuments(null)
    void (async () => {
      try {
        const res = await fetch(
          `/api/accounts/${selectedAccountId}/documents?limit=50&offset=0`,
        )
        if (cancelled) return
        if (!res.ok) {
          setError({ kind: 'unexpected', message: `Status ${res.status}` })
          return
        }
        const data = (await res.json()) as { rows: Document[]; total: number }
        setDocuments(data.rows)
      } catch (err) {
        if (cancelled) return
        setError({
          kind: 'unexpected',
          message: err instanceof Error ? err.message : 'Failed to load documents',
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedAccountId])

  const hasAnyAccount = accounts !== null && accounts.length > 0
  const accountList = accounts ?? []
  const hasConnected = useMemo(
    () => accountList.some((a) => a.status === 'connected'),
    [accountList],
  )

  if (accounts === null) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    )
  }

  if (!hasAnyAccount) {
    return (
      <main>
        <p>
          No accounts connected — connect one on the <Link to="/">Dashboard</Link>.
        </p>
      </main>
    )
  }

  return (
    <main>
      <AccountPicker
        accounts={accountList}
        value={selectedAccountId}
        onChange={(id) => setSelectedAccountId(id)}
        includeDisconnected
      />
      {hasConnected && error.kind === 'unexpected' && (
        <p role="alert">Unexpected error: {error.message}.</p>
      )}
      {hasConnected && error.kind === 'none' && loading && <p>Loading documents…</p>}
      {hasConnected && error.kind === 'none' && documents !== null && documents.length === 0 && (
        <p>No documents yet — kick off a sync from the Dashboard.</p>
      )}
      {hasConnected && error.kind === 'none' && documents !== null && documents.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Amount</th>
              <th>Currency</th>
              <th>Transaction Date</th>
              <th>Subject</th>
              <th>Sender Domain</th>
              <th>Created At</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{or(d.vendor)}</td>
                <td>{or(d.amount)}</td>
                <td>{or(d.currency)}</td>
                <td>{or(d.transaction_date)}</td>
                <td>{or(d.subject)}</td>
                <td>{or(d.sender_domain)}</td>
                <td>{d.created_at}</td>
                <td>
                  <a
                    href={`/api/documents/${d.id}/file`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Preview
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
