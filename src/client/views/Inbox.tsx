import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountPicker } from '../components/AccountPicker.js'
import type { Account, Message } from '../types.js'

export const LAST_INBOX_ACCOUNT_KEY = 'docurator.lastInboxAccountId'

type ErrorState =
  | { kind: 'none' }
  | { kind: 'needs_reauth' }
  | { kind: 'gmail_error'; message: string }
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

function pickInitialAccount(
  accounts: Account[],
  storedId: number | null,
): number | null {
  if (storedId !== null) {
    const stored = accounts.find((a) => a.id === storedId)
    if (stored !== undefined && stored.status === 'connected') {
      return stored.id
    }
  }
  const first = accounts.find((a) => a.status === 'connected')
  return first ? first.id : null
}

export function Inbox() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)
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
      setMessages(null)
      return
    }
    persistId(selectedAccountId)
    let cancelled = false
    setLoadingMessages(true)
    setError({ kind: 'none' })
    setMessages(null)
    void (async () => {
      try {
        const res = await fetch(
          `/api/accounts/${selectedAccountId}/messages?limit=50`,
        )
        if (cancelled) return
        if (res.status === 401) {
          setError({ kind: 'needs_reauth' })
          return
        }
        if (res.status === 502) {
          const body = (await res.json().catch(() => ({}))) as { message?: string }
          setError({ kind: 'gmail_error', message: body.message ?? 'unknown error' })
          return
        }
        if (!res.ok) {
          setError({ kind: 'unexpected', message: `Status ${res.status}` })
          return
        }
        const data = (await res.json()) as { messages: Message[] }
        setMessages(data.messages)
      } catch (err) {
        if (cancelled) return
        setError({
          kind: 'unexpected',
          message: err instanceof Error ? err.message : 'Failed to load messages',
        })
      } finally {
        if (!cancelled) setLoadingMessages(false)
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
      {hasConnected && error.kind === 'needs_reauth' && (
        <p role="alert">
          This account needs to be reconnected — go to the{' '}
          <Link to="/">Dashboard</Link>.
        </p>
      )}
      {hasConnected && error.kind === 'gmail_error' && (
        <p role="alert">Gmail returned an error: {error.message}. Try again.</p>
      )}
      {hasConnected && error.kind === 'unexpected' && (
        <p role="alert">Unexpected error: {error.message}.</p>
      )}
      {hasConnected && error.kind === 'none' && loadingMessages && (
        <p>Loading messages…</p>
      )}
      {hasConnected && error.kind === 'none' && messages !== null && (
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>Sender</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id}>
                <td>{m.subject}</td>
                <td>{m.from}</td>
                <td>{m.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
