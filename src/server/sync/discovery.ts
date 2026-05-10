import type { SyncState } from '../db/repositories/sync_state.js'

export type DiscoveryArgs = {
  syncState: SyncState | undefined
  // ISO date `YYYY-MM-DD`, or already-slashed `YYYY/MM/DD`. When set, the
  // discovery is a range search regardless of last_history_id.
  since: string | undefined
  fallbackDays: number
  now: Date
}

export type DiscoveryDecision =
  | { kind: 'history'; start_history_id: string }
  | { kind: 'range'; q: string }

// Picks how the orchestrator should enumerate messages for one account.
// Pure: no I/O, no Gmail client. The orchestrator passes its own clock so
// the function is deterministic under test.
export function chooseDiscovery(args: DiscoveryArgs): DiscoveryDecision {
  if (args.since !== undefined) {
    return { kind: 'range', q: `after:${slashedDate(args.since)}` }
  }

  const lastHistoryId = args.syncState?.last_history_id ?? null
  if (lastHistoryId !== null && lastHistoryId !== '') {
    return { kind: 'history', start_history_id: lastHistoryId }
  }

  const cutoff = new Date(args.now)
  cutoff.setUTCDate(cutoff.getUTCDate() - args.fallbackDays)
  return { kind: 'range', q: `after:${formatUtcDate(cutoff)}` }
}

// Gmail's `q` after-operator accepts `YYYY/MM/DD`. Accept both `YYYY-MM-DD`
// and pre-slashed input — the spec describes `since` as ISO date, but we
// don't gain anything by rejecting an already-Gmail-shaped input.
function slashedDate(input: string): string {
  return input.replace(/-/g, '/')
}

function formatUtcDate(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0')
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = date.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}
