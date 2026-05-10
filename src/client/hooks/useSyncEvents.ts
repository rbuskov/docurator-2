import { useEffect, useReducer } from 'react'
import type { SyncAccountSnapshot, SyncEvent } from '../types.js'

export type UseSyncEventsState = {
  active: boolean
  job_id?: string
  accounts: SyncAccountSnapshot[]
}

const INITIAL_STATE: UseSyncEventsState = {
  active: false,
  accounts: [],
}

// SSE event names the orchestrator emits. Keep in sync with `SyncEvent` in
// types.ts and `src/server/sync/orchestrator.ts`.
const EVENT_NAMES = [
  'sync.start',
  'sync.account.start',
  'sync.message',
  'sync.account.done',
  'sync.error',
  'sync.done',
] as const

function reduceState(prev: UseSyncEventsState, ev: SyncEvent): UseSyncEventsState {
  switch (ev.event) {
    case 'sync.start': {
      // A new run resets per-account counters so the prior run's totals
      // don't bleed in. Late subscribers replaying the ring buffer end up
      // here too — the same reset is what they want.
      return { active: true, job_id: ev.payload.job_id, accounts: [] }
    }
    case 'sync.account.start': {
      const { account_id } = ev.payload
      if (prev.accounts.some((a) => a.account_id === account_id)) return prev
      return {
        ...prev,
        accounts: [
          ...prev.accounts,
          { account_id, processed: 0, receipts: 0, failed: 0, in_progress: true },
        ],
      }
    }
    case 'sync.message': {
      const { account_id, status, document_ids } = ev.payload
      // Skipped messages are historical work surfaced for transparency; they
      // don't represent progress in this run.
      if (status === 'skipped') return prev
      return {
        ...prev,
        accounts: prev.accounts.map((a) =>
          a.account_id !== account_id
            ? a
            : {
                ...a,
                processed: a.processed + 1,
                failed: status === 'failed' ? a.failed + 1 : a.failed,
                receipts:
                  status === 'success' && document_ids.length > 0
                    ? a.receipts + 1
                    : a.receipts,
              },
        ),
      }
    }
    case 'sync.account.done': {
      const { account_id, processed, receipts, failed } = ev.payload
      return {
        ...prev,
        accounts: prev.accounts.map((a) =>
          a.account_id !== account_id
            ? a
            : { ...a, processed, receipts, failed, in_progress: false },
        ),
      }
    }
    case 'sync.error':
      return prev
    case 'sync.done':
      return { ...prev, active: false }
  }
}

export function useSyncEvents(): UseSyncEventsState {
  const [state, dispatch] = useReducer(reduceState, INITIAL_STATE)

  useEffect(() => {
    const es = new EventSource('/api/sync/events')

    type Listener = { name: string; fn: (ev: MessageEvent) => void }
    const listeners: Listener[] = []
    for (const name of EVENT_NAMES) {
      const fn = (raw: MessageEvent) => {
        let payload: unknown
        try {
          payload = JSON.parse(raw.data)
        } catch {
          return
        }
        dispatch({ event: name, payload } as SyncEvent)
      }
      es.addEventListener(name, fn)
      listeners.push({ name, fn })
    }

    return () => {
      for (const { name, fn } of listeners) es.removeEventListener(name, fn)
      es.close()
    }
  }, [])

  return state
}
