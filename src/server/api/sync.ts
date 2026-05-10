import { zValidator } from '@hono/zod-validator'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { syncEvents, type SyncEvent } from '../sync/events.js'
import {
  getActiveJob,
  runSync as defaultRunSync,
  SyncInProgressError,
  type RunSyncArgs,
  type RunSyncResult,
} from '../sync/orchestrator.js'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  account_ids: z.array(z.number().int().positive()).optional(),
  since: z.string().regex(ISO_DATE).optional(),
})

export type RunSyncFn = (args: RunSyncArgs) => Promise<RunSyncResult>

export type SyncRouteDeps = {
  runSync?: RunSyncFn
}

type AccountSnapshot = {
  account_id: number
  processed: number
  receipts: number
  failed: number
  in_progress: boolean
}

// Walks the recent event ring to derive per-account counters. The Dashboard
// hits `GET /api/sync/status` on mount so it can render counters without
// waiting for the SSE stream to deliver them again. Live updates ride the SSE
// stream; this snapshot is the bootstrap.
function buildStatus(): {
  active: boolean
  job_id?: string
  started_at?: string
  accounts?: AccountSnapshot[]
} {
  const job = getActiveJob()
  if (job === null) return { active: false }

  const byAccount = new Map<number, AccountSnapshot>()

  for (const ev of syncEvents.recent()) {
    const payload = ev.payload as { account_id?: number }
    if (ev.event === 'sync.account.start' && typeof payload.account_id === 'number') {
      byAccount.set(payload.account_id, {
        account_id: payload.account_id,
        processed: 0,
        receipts: 0,
        failed: 0,
        in_progress: true,
      })
    } else if (ev.event === 'sync.message' && typeof payload.account_id === 'number') {
      const acct = byAccount.get(payload.account_id)
      if (acct === undefined) continue
      const messagePayload = ev.payload as {
        status?: string
        document_ids?: number[]
      }
      // Skipped messages don't increment the per-job counters — they're
      // historical work that shows up in `processed_messages` but isn't part
      // of "what got done in this run".
      if (messagePayload.status === 'skipped') continue
      acct.processed += 1
      if (messagePayload.status === 'failed') {
        acct.failed += 1
      }
      if (
        messagePayload.status === 'success' &&
        Array.isArray(messagePayload.document_ids) &&
        messagePayload.document_ids.length > 0
      ) {
        acct.receipts += 1
      }
    } else if (ev.event === 'sync.account.done' && typeof payload.account_id === 'number') {
      const donePayload = ev.payload as {
        processed?: number
        receipts?: number
        failed?: number
      }
      const acct = byAccount.get(payload.account_id) ?? {
        account_id: payload.account_id,
        processed: 0,
        receipts: 0,
        failed: 0,
        in_progress: false,
      }
      // Trust the orchestrator's final count when the account is done.
      acct.processed = donePayload.processed ?? acct.processed
      acct.receipts = donePayload.receipts ?? acct.receipts
      acct.failed = donePayload.failed ?? acct.failed
      acct.in_progress = false
      byAccount.set(payload.account_id, acct)
    }
  }

  return {
    active: true,
    job_id: job.job_id,
    started_at: job.started_at,
    accounts: [...byAccount.values()],
  }
}

export function registerSyncRoutes(app: Hono, deps: SyncRouteDeps = {}): void {
  const _runSync = deps.runSync ?? defaultRunSync

  app.post(
    '/api/sync',
    zValidator('json', bodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'invalid_body' }, 400)
      }
    }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        const job = await _runSync(body)
        return c.json({ job_id: job.job_id, started_at: job.started_at }, 202)
      } catch (err) {
        if (err instanceof SyncInProgressError) {
          return c.json({ error: 'sync_in_progress', job_id: err.job_id }, 409)
        }
        const message = err instanceof Error ? err.message : 'sync failed to start'
        return c.json({ error: 'sync_start_failed', message }, 500)
      }
    },
  )

  app.get('/api/sync/status', (c) => {
    return c.json(buildStatus())
  })

  app.get('/api/sync/events', (c) => {
    return streamSSE(c, async (stream) => {
      for await (const ev of syncEvents.subscribe()) {
        const typed = ev as SyncEvent
        await stream.writeSSE({
          event: typed.event,
          data: JSON.stringify(typed.payload),
        })
      }
    })
  })
}
