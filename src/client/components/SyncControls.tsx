import { useEffect, useRef, useState } from 'react'
import { useSyncEvents } from '../hooks/useSyncEvents.js'

export function SyncControls() {
  const sync = useSyncEvents()
  // Local "I just clicked, server replied 202" flag. The SSE stream eventually
  // catches up via `sync.start` → `sync.active` flips true. Until that happens
  // we still want the button disabled so a user can't double-fire the sync.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Latch: once the SSE confirms an active job, remember it. When it drops
  // back to inactive (sync.done arrived), clear the local busy flag.
  const sawActive = useRef(false)

  useEffect(() => {
    if (sync.active) {
      sawActive.current = true
    } else if (sawActive.current) {
      setBusy(false)
      sawActive.current = false
    }
  }, [sync.active])

  const isSyncing = busy || sync.active

  async function handleClick() {
    setError(null)
    setBusy(true)
    let res: Response
    try {
      res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Sync failed to start')
      return
    }

    if (res.status === 202) {
      // SSE will flip active=true → ... → active=false; busy clears in the
      // effect above. Nothing to do here.
      return
    }
    if (res.status === 409) {
      // Another sync is already running — the in-flight job is reflected via
      // SSE; keep the local busy flag on so the button stays disabled until
      // that job finishes.
      return
    }
    const text = await res.text().catch(() => '')
    setBusy(false)
    setError(`Sync failed to start: ${res.status} ${text}`.trim())
  }

  return (
    <section data-testid="sync-controls">
      <button onClick={handleClick} disabled={isSyncing}>
        {isSyncing ? 'Syncing…' : 'Sync now'}
      </button>
      {error !== null && <p role="alert">{error}</p>}
      {sync.accounts.length > 0 && (
        <ul data-testid="sync-account-counters">
          {sync.accounts.map((a) => (
            <li key={a.account_id} data-account-id={a.account_id}>
              Account {a.account_id}: {a.processed} processed, {a.receipts} receipts,{' '}
              {a.failed} failed{a.in_progress ? ' (in progress)' : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
