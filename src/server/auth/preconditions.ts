import * as accounts from './accounts.js'
import type { Account, AccountStatus } from './accounts.js'
import * as session from './session.js'

export type PreconditionFailure = {
  ok: false
  status: 404 | 409
  body: { error: string; status?: AccountStatus }
}

export type PreconditionSuccess = {
  ok: true
  account: Account
}

export type PreconditionResult = PreconditionSuccess | PreconditionFailure

// "Does this account row exist?" — the relaxed precondition for endpoints
// that read from local DB only and don't need OAuth tokens. Slice 006's
// `GET /api/accounts/:id/documents` uses this because document listing is
// purely a DB read; the user shouldn't see a `needs_reauth` flip just for
// browsing already-persisted receipts.
export function requireKnownAccount(accountId: number): PreconditionResult {
  const account = accounts.findById(accountId)
  if (account === undefined) {
    return { ok: false, status: 404, body: { error: 'account_not_found' } }
  }
  return { ok: true, account }
}

// Centralizes the four-branch "is this account ready for a Gmail call?" check
// that messages.ts, dev.ts, and (now) classify.ts share. The fourth branch —
// `connected` per DB but no in-memory session — flips the row to needs_reauth
// as a side effect so the Dashboard surfaces the Reconnect button on the next
// poll. Side effect is intentional and matches the prior in-handler behavior.
export function requireConnectedAccount(accountId: number): PreconditionResult {
  const account = accounts.findById(accountId)
  if (account === undefined) {
    return { ok: false, status: 404, body: { error: 'account_not_found' } }
  }
  if (account.status !== 'connected') {
    return {
      ok: false,
      status: 409,
      body: { error: 'account_not_connected', status: account.status },
    }
  }
  if (session.get(accountId) === undefined) {
    accounts.updateStatus(accountId, 'needs_reauth')
    return {
      ok: false,
      status: 409,
      body: { error: 'account_not_connected', status: 'needs_reauth' },
    }
  }
  return { ok: true, account }
}
