import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import * as eventsModule from '../sync/events.js'
import {
  __resetActiveJobForTest,
  SyncInProgressError,
  type RunSyncResult,
} from '../sync/orchestrator.js'
import { registerSyncRoutes } from './sync.js'

describe('sync API routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    eventsModule.__resetForTest()
    __resetActiveJobForTest()
  })

  afterEach(() => {
    eventsModule.__resetForTest()
    __resetActiveJobForTest()
  })

  describe('POST /api/sync', () => {
    it('returns 202 with { job_id, started_at } on success', async () => {
      const stubRunSync = vi.fn(
        async (_args: unknown): Promise<RunSyncResult> => ({
          job_id: 'job-1',
          started_at: '2026-05-09T12:00:00.000Z',
          done: Promise.resolve(),
        }),
      )
      registerSyncRoutes(app, { runSync: stubRunSync })

      const res = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({
        job_id: 'job-1',
        started_at: '2026-05-09T12:00:00.000Z',
      })
      expect(stubRunSync).toHaveBeenCalledTimes(1)
      expect(stubRunSync.mock.calls[0]?.[0]).toEqual({})
    })

    it('passes account_ids and since through to runSync', async () => {
      const stubRunSync = vi.fn(
        async (_args: unknown): Promise<RunSyncResult> => ({
          job_id: 'job-2',
          started_at: '2026-05-09T12:00:00.000Z',
          done: Promise.resolve(),
        }),
      )
      registerSyncRoutes(app, { runSync: stubRunSync })

      const res = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_ids: [1, 2], since: '2026-04-01' }),
        }),
      )

      expect(res.status).toBe(202)
      expect(stubRunSync.mock.calls[0]?.[0]).toEqual({
        account_ids: [1, 2],
        since: '2026-04-01',
      })
    })

    it('returns 400 on a malformed body (since not in YYYY-MM-DD shape)', async () => {
      registerSyncRoutes(app, { runSync: vi.fn() as never })

      const res = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since: 'last week' }),
        }),
      )

      expect(res.status).toBe(400)
    })

    it('returns 400 on account_ids that are not numbers', async () => {
      registerSyncRoutes(app, { runSync: vi.fn() as never })

      const res = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_ids: ['one', 'two'] }),
        }),
      )

      expect(res.status).toBe(400)
    })

    it('returns 409 sync_in_progress when runSync throws SyncInProgressError', async () => {
      const stubRunSync = vi.fn(async () => {
        throw new SyncInProgressError('job-already-running')
      })
      registerSyncRoutes(app, { runSync: stubRunSync as never })

      const res = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'sync_in_progress',
        job_id: 'job-already-running',
      })
    })
  })

  describe('GET /api/sync/status', () => {
    it("returns { active: false } when no job is running", async () => {
      registerSyncRoutes(app, { runSync: vi.fn() as never })

      const res = await app.fetch(new Request('http://x/api/sync/status'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ active: false })
    })

    it('returns { active: true, job_id, started_at, accounts: [...] } during a job', async () => {
      // Stub runSync to set the active job and emit some events, but never resolve
      // its `done` so the snapshot reflects an in-flight sync.
      const stubRunSync = vi.fn(async (): Promise<RunSyncResult> => {
        // Fake the orchestrator's mutex acquisition by reaching into its internal
        // state — there's no public set, but emitting matching events drives the
        // status snapshot the same way it would in production.
        eventsModule.syncEvents.emit('sync.start', {
          job_id: 'job-active',
          account_ids: [1, 2],
          started_at: '2026-05-09T12:00:00.000Z',
        })
        eventsModule.syncEvents.emit('sync.account.start', { account_id: 1 })
        eventsModule.syncEvents.emit('sync.message', {
          account_id: 1,
          message_id: 'm1',
          status: 'success',
          document_ids: [10],
        })
        eventsModule.syncEvents.emit('sync.message', {
          account_id: 1,
          message_id: 'm2',
          status: 'failed',
          document_ids: [],
        })
        eventsModule.syncEvents.emit('sync.account.start', { account_id: 2 })
        return {
          job_id: 'job-active',
          started_at: '2026-05-09T12:00:00.000Z',
          done: new Promise(() => {
            /* never resolve — test cleans up via __resetForTest */
          }),
        }
      })
      registerSyncRoutes(app, { runSync: stubRunSync as never })

      // Trigger a sync to populate status state.
      const triggerRes = await app.fetch(
        new Request('http://x/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(triggerRes.status).toBe(202)

      // Manually mark the active job (the stub didn't go through the real
      // orchestrator that would have set it).
      const orch = await import('../sync/orchestrator.js')
      orch.__setActiveJobForTest({
        job_id: 'job-active',
        started_at: '2026-05-09T12:00:00.000Z',
      })

      const res = await app.fetch(new Request('http://x/api/sync/status'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        active: boolean
        job_id?: string
        started_at?: string
        accounts?: Array<{
          account_id: number
          processed: number
          receipts: number
          failed: number
          in_progress: boolean
        }>
      }
      expect(body.active).toBe(true)
      expect(body.job_id).toBe('job-active')
      expect(body.started_at).toBe('2026-05-09T12:00:00.000Z')
      expect(body.accounts).toEqual(
        expect.arrayContaining([
          {
            account_id: 1,
            processed: 2,
            receipts: 1,
            failed: 1,
            in_progress: true,
          },
          {
            account_id: 2,
            processed: 0,
            receipts: 0,
            failed: 0,
            in_progress: true,
          },
        ]),
      )
    })
  })

  describe('GET /api/sync/events (SSE)', () => {
    it("streams events emitted to syncEvents as `data: <json>` lines", async () => {
      registerSyncRoutes(app, { runSync: vi.fn() as never })

      const res = await app.fetch(new Request('http://x/api/sync/events'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/i)

      // Emit two events — the SSE handler should write them to the response body.
      eventsModule.syncEvents.emit('sync.start', { job_id: 'sse-job' })
      eventsModule.syncEvents.emit('sync.message', {
        account_id: 1,
        message_id: 'm1',
        status: 'success',
      })

      // Read chunks until we have two SSE event blocks.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const blocks: string[] = []
      const start = Date.now()
      while (blocks.length < 2 && Date.now() - start < 2000) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Each SSE event ends with a blank line.
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          blocks.push(buf.slice(0, idx))
          buf = buf.slice(idx + 2)
        }
      }
      reader.cancel()

      expect(blocks.length).toBeGreaterThanOrEqual(2)
      const block0 = blocks[0] ?? ''
      const block1 = blocks[1] ?? ''
      expect(block0).toMatch(/^event: sync\.start/m)
      expect(block0).toMatch(/^data: \{"job_id":"sse-job"\}/m)
      expect(block1).toMatch(/^event: sync\.message/m)
      expect(block1).toMatch(/"message_id":"m1"/)
    })

    it('replays the ring buffer to a late subscriber on first iteration', async () => {
      // Emit a few events BEFORE the subscriber connects.
      eventsModule.syncEvents.emit('sync.start', { job_id: 'early' })
      eventsModule.syncEvents.emit('sync.account.start', { account_id: 1 })

      registerSyncRoutes(app, { runSync: vi.fn() as never })

      const res = await app.fetch(new Request('http://x/api/sync/events'))
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const blocks: string[] = []
      const start = Date.now()
      while (blocks.length < 2 && Date.now() - start < 2000) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          blocks.push(buf.slice(0, idx))
          buf = buf.slice(idx + 2)
        }
      }
      reader.cancel()

      const joined = blocks.join('\n')
      expect(joined).toMatch(/event: sync\.start/)
      expect(joined).toMatch(/"job_id":"early"/)
      expect(joined).toMatch(/event: sync\.account\.start/)
    })
  })
})
