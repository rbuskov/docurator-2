import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('orchestrator.runSync — happy path', () => {
  let tempDir: string
  let invoicesRoot: string
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let documentsRepo: typeof import('../db/repositories/documents.js')
  let processedMessages: typeof import('../db/repositories/processed_messages.js')
  let filesModule: typeof import('../files.js')
  let eventsModule: typeof import('./events.js')
  let orchestrator: typeof import('./orchestrator.js')
  let accountId: number

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-orch-'))
    invoicesRoot = mkdtempSync(join(tmpdir(), 'docurator-orch-invoices-'))

    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
    dbModule.getDb().pragma('foreign_keys = ON')

    accounts = await import('../auth/accounts.js')
    documentsRepo = await import('../db/repositories/documents.js')
    processedMessages = await import('../db/repositories/processed_messages.js')
    filesModule = await import('../files.js')
    eventsModule = await import('./events.js')
    orchestrator = await import('./orchestrator.js')

    filesModule.setInvoicesRootForTest(invoicesRoot)
    eventsModule.__resetForTest()

    accountId = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    }).id
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    filesModule.resetInvoicesRootForTest()
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(invoicesRoot, { recursive: true, force: true })
  })

  function fakeGmailClientWithMessages(messageIds: string[]) {
    return {
      listMessages: async () => ({
        messages: messageIds.map((id) => ({ id, threadId: 't1' })),
      }),
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: 'alice@example.com',
        history_id: '5000',
        messages_total: 1,
        threads_total: 1,
      }),
    }
  }

  it('processes one receipt-shaped message: writes file, inserts processed_messages + documents, emits events in order', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\nfake-receipt-bytes\n%%EOF')
    const stubClassify = vi.fn(
      async (
        _args: import('../classify/index.js').ClassifyMessageArgs,
        _deps: import('../classify/index.js').ClassifyMessageDeps,
      ): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'receipt' as const,
        confidence: 'high' as const,
        reason: 'Stripe-shaped invoice',
        vendor: 'Acme',
        amount: 12.5,
        currency: 'EUR',
        transaction_date: '2026-05-01',
        model_used: 'qwen2.5vl:7b',
        artifacts: [
          { kind: 'attachment' as const, mime_type: 'application/pdf', filename: 'invoice.pdf' },
        ],
        source_bytes: new Map([['attachment:invoice.pdf', pdfBytes]]),
      }),
    )

    // Collect events as they emit, in order.
    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      // Drain until sync.done arrives.
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { job_id, done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-1']),
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )

    await done
    await collectorDone
    await it.return?.()

    // Database side effects.
    const pmRows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
    expect(pmRows).toHaveLength(1)
    expect(pmRows[0]).toMatchObject({
      message_id: 'msg-1',
      status: 'success',
      classification: 'receipt',
      confidence: 'high',
    })

    const docs = documentsRepo.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
    })
    expect(docs.total).toBe(1)
    expect(docs.rows[0]).toMatchObject({
      account_id: accountId,
      message_id: 'msg-1',
      kind: 'attachment',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      vendor: 'Acme',
      amount: 12.5,
      currency: 'EUR',
      transaction_date: '2026-05-01',
      review_status: 'pending',
    })
    expect(docs.rows[0]?.size).toBe(pdfBytes.length)

    // File on disk.
    const docRow = docs.rows[0]
    if (docRow === undefined) throw new Error('expected one row')
    const onDisk = join(invoicesRoot, docRow.file_path)
    expect(existsSync(onDisk)).toBe(true)
    expect(readFileSync(onDisk).equals(pdfBytes)).toBe(true)

    // SSE events.
    const eventNames = collected.map((e) => e.event)
    expect(eventNames).toEqual([
      'sync.start',
      'sync.account.start',
      'sync.message',
      'sync.account.done',
      'sync.done',
    ])

    // Job id present in start + done events.
    const start = collected.find((e) => e.event === 'sync.start')
    expect((start?.payload as { job_id: string }).job_id).toBe(job_id)
    const doneEv = collected.find((e) => e.event === 'sync.done')
    expect((doneEv?.payload as { job_id: string }).job_id).toBe(job_id)

    // sync.message payload includes the document_id we inserted.
    const msgEv = collected.find((e) => e.event === 'sync.message')
    expect((msgEv?.payload as { account_id: number; message_id: string; status: string }).status).toBe('success')
    expect((msgEv?.payload as { document_ids: number[] }).document_ids).toEqual([
      docRow.id,
    ])

    // sync.account.done counters.
    const acctDone = collected.find((e) => e.event === 'sync.account.done')
    expect(acctDone?.payload).toMatchObject({
      account_id: accountId,
      processed: 1,
      receipts: 1,
      failed: 0,
    })

    // The classifier was called with the right args.
    expect(stubClassify).toHaveBeenCalledTimes(1)
    expect(stubClassify.mock.calls[0]?.[0]).toEqual({
      account_id: accountId,
      message_id: 'msg-1',
    })
  })

  it('rejects a second runSync while the first is still in flight (mutex)', async () => {
    // First job stalls on classifyMessage so its mutex stays held.
    let releaseFirst: (() => void) | null = null
    const stallingClassify = vi.fn(
      () =>
        new Promise<never>((_resolve, _reject) => {
          // Never settle — we'll abandon this promise via the test's cleanup.
          releaseFirst = () => {
            // satisfy lint; we don't need to call this.
          }
        }),
    )

    const first = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-stall']),
        classifyMessage: stallingClassify as never,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )

    await expect(
      orchestrator.runSync(
        {},
        {
          createGmailClient: () => fakeGmailClientWithMessages(['msg-other']),
          classifyMessage: vi.fn() as never,
          now: () => new Date('2026-05-09T12:00:01Z'),
        },
      ),
    ).rejects.toThrow(/sync_in_progress/i)

    // Tell TS the variable is used.
    expect(typeof releaseFirst === 'function' || releaseFirst === null).toBe(true)
    // Release the test by abandoning the first job's done promise (no-op cleanup).
    void first
  })

  it('hard-dedups within an account: same content_hash twice → 1 documents row, 2nd sync.message references the existing doc id', async () => {
    const sharedBytes = Buffer.from('%PDF-1.4\nshared-attachment-bytes\n%%EOF')
    const stubClassify = vi.fn(
      async (
        a: import('../classify/index.js').ClassifyMessageArgs,
      ): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'receipt' as const,
        confidence: 'high' as const,
        reason: 'shared',
        vendor: 'Acme',
        amount: 9.99,
        currency: 'EUR',
        transaction_date: '2026-05-01',
        model_used: 'qwen2.5vl:7b',
        artifacts: [
          { kind: 'attachment' as const, mime_type: 'application/pdf', filename: 'shared.pdf' },
        ],
        // Both messages return the SAME bytes — this is the dedup case.
        source_bytes: new Map([[`attachment:shared.pdf`, sharedBytes]]),
      }),
    )

    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-A', 'msg-B']),
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done
    await collectorDone
    await it.return?.()

    // Two processed_messages rows (one per message) — successful both times.
    const pmRows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
    expect(pmRows).toHaveLength(2)
    for (const row of pmRows) {
      expect(row.status).toBe('success')
      expect(row.classification).toBe('receipt')
    }

    // ONE documents row, despite two messages.
    const docs = documentsRepo.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
    })
    expect(docs.total).toBe(1)
    const onlyDoc = docs.rows[0]
    if (onlyDoc === undefined) throw new Error('expected one row')

    // Both sync.message events should reference the same document id.
    const msgEvents = collected.filter((e) => e.event === 'sync.message')
    expect(msgEvents).toHaveLength(2)
    for (const ev of msgEvents) {
      expect((ev.payload as { document_ids: number[] }).document_ids).toEqual([onlyDoc.id])
    }

    // Per-account counter still reports 2 receipts (the message itself was a
    // receipt; deduplication is a storage-level optimization).
    const acctDone = collected.find((e) => e.event === 'sync.account.done')
    expect(acctDone?.payload).toMatchObject({
      account_id: accountId,
      processed: 2,
      receipts: 2,
      failed: 0,
    })

    // Classifier was called once per message — dedup is enforced at persist time,
    // not at the API layer.
    expect(stubClassify).toHaveBeenCalledTimes(2)
  })

  it('flips account to needs_reauth and continues to the next account when classify raises invalid_grant', async () => {
    // Two connected accounts. Account A's classify throws invalid_grant on the
    // first message; account B should still be processed.
    const secondAccountId = accounts.insert({
      email: 'bob@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    }).id

    const goodPdf = Buffer.from('%PDF-1.4\nbob-receipt\n%%EOF')
    const stubClassify = vi.fn(
      async (
        a: import('../classify/index.js').ClassifyMessageArgs,
      ): Promise<import('../classify/index.js').ClassifyResult> => {
        if (a.account_id === accountId) {
          throw new Error('invalid_grant: token revoked')
        }
        return {
          classification: 'receipt' as const,
          confidence: 'high' as const,
          reason: 'r',
          model_used: 'qwen2.5vl:7b',
          artifacts: [
            { kind: 'attachment' as const, mime_type: 'application/pdf', filename: 'b.pdf' },
          ],
          source_bytes: new Map([['attachment:b.pdf', goodPdf]]),
        }
      },
    )

    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: (id) => fakeGmailClientWithMessages(id === accountId ? ['msg-A'] : ['msg-B']),
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done
    await collectorDone
    await it.return?.()

    // Account A: marked needs_reauth, sync.error emitted, no processed_messages row.
    const a = accounts.findById(accountId)
    expect(a?.status).toBe('needs_reauth')
    expect(processedMessages.countForAccount({ account_id: accountId })).toBe(0)
    const errEv = collected.find(
      (e) =>
        e.event === 'sync.error' &&
        (e.payload as { account_id?: number }).account_id === accountId,
    )
    expect(errEv).toBeDefined()

    // Account B: untouched; processed normally.
    const b = accounts.findById(secondAccountId)
    expect(b?.status).toBe('connected')
    const bRows = processedMessages.listForAccount({ account_id: secondAccountId, limit: 50 })
    expect(bRows).toHaveLength(1)
    expect(bRows[0]?.status).toBe('success')
    const bDocs = documentsRepo.listForAccount({
      account_id: secondAccountId,
      limit: 50,
      offset: 0,
    })
    expect(bDocs.total).toBe(1)
  })

  it('retries a generic classify failure once; second failure → processed_messages.status=failed', async () => {
    let attempt = 0
    const stubClassify = vi.fn(
      async (): Promise<import('../classify/index.js').ClassifyResult> => {
        attempt += 1
        // Always throws → first attempt + 1 retry → 2 calls total.
        throw new Error('Gmail 429: rate limit exceeded')
      },
    )

    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-flaky']),
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done
    await collectorDone
    await it.return?.()

    expect(stubClassify).toHaveBeenCalledTimes(2)
    expect(attempt).toBe(2)

    // Account NOT flipped to needs_reauth — generic errors are not auth errors.
    const a = accounts.findById(accountId)
    expect(a?.status).toBe('connected')

    // One processed_messages row, status=failed.
    const pm = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
    expect(pm).toHaveLength(1)
    expect(pm[0]?.status).toBe('failed')

    // sync.message event has status:'failed'.
    const msgEv = collected.find((e) => e.event === 'sync.message')
    expect((msgEv?.payload as { status: string }).status).toBe('failed')

    // sync.account.done counter reports failed:1.
    const acctDone = collected.find((e) => e.event === 'sync.account.done')
    expect(acctDone?.payload).toMatchObject({
      account_id: accountId,
      processed: 1,
      receipts: 0,
      failed: 1,
    })
  })

  it('retry succeeds on the second attempt → processed_messages.status=success, no failure recorded', async () => {
    let attempt = 0
    const goodPdf = Buffer.from('%PDF-1.4\ngood\n%%EOF')
    const stubClassify = vi.fn(
      async (): Promise<import('../classify/index.js').ClassifyResult> => {
        attempt += 1
        if (attempt === 1) throw new Error('transient 503')
        return {
          classification: 'receipt' as const,
          confidence: 'high' as const,
          reason: 'r',
          model_used: 'qwen2.5vl:7b',
          artifacts: [
            { kind: 'attachment' as const, mime_type: 'application/pdf', filename: 'g.pdf' },
          ],
          source_bytes: new Map([['attachment:g.pdf', goodPdf]]),
        }
      },
    )

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-retry']),
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done

    expect(stubClassify).toHaveBeenCalledTimes(2)
    const pm = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
    expect(pm).toHaveLength(1)
    expect(pm[0]?.status).toBe('success')
    expect(documentsRepo.listForAccount({ account_id: accountId, limit: 50, offset: 0 }).total).toBe(1)
  })

  it('uses historyList when sync_state.last_history_id is set; updates sync_state from getProfile after the run', async () => {
    const syncStateRepo = await import('../db/repositories/sync_state.js')
    syncStateRepo.upsert({
      account_id: accountId,
      last_history_id: '5000',
      last_synced_at: '2026-05-01T00:00:00Z',
    })

    let historyListCalled = false
    let listMessagesCalled = false
    const fakeClient = {
      listMessages: async () => {
        listMessagesCalled = true
        return { messages: [] }
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async (args: { start_history_id: string }) => {
        historyListCalled = true
        expect(args.start_history_id).toBe('5000')
        return {
          history: [
            {
              id: 'h1',
              messagesAdded: [{ message: { id: 'msg-h1', threadId: 't1' } }],
            },
          ],
          history_id: '6000',
        }
      },
      getProfile: async () => ({
        email_address: 'alice@example.com',
        history_id: '6000',
        messages_total: 100,
        threads_total: 50,
      }),
    }

    const stubClassify = vi.fn(
      async (
        _args: import('../classify/index.js').ClassifyMessageArgs,
        _deps: import('../classify/index.js').ClassifyMessageDeps,
      ): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'other' as const,
        confidence: 'low' as const,
        reason: 'r',
        model_used: 'qwen2.5vl:7b',
        artifacts: [],
        source_bytes: new Map(),
      }),
    )

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeClient,
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done

    expect(historyListCalled).toBe(true)
    expect(listMessagesCalled).toBe(false)
    expect(stubClassify).toHaveBeenCalledTimes(1)
    expect(stubClassify.mock.calls[0]?.[0]).toEqual({
      account_id: accountId,
      message_id: 'msg-h1',
    })

    // sync_state was updated with the new history_id from getProfile.
    const ss = syncStateRepo.get(accountId)
    expect(ss?.last_history_id).toBe('6000')
    expect(ss?.last_synced_at).toBe('2026-05-09T12:00:00.000Z')
  })

  it('falls back to listMessages when historyList throws a 404 (stale history id); still updates sync_state via getProfile', async () => {
    const syncStateRepo = await import('../db/repositories/sync_state.js')
    syncStateRepo.upsert({
      account_id: accountId,
      last_history_id: '99999',
      last_synced_at: '2026-04-01T00:00:00Z',
    })

    const goodPdf = Buffer.from('%PDF-1.4\nfallback\n%%EOF')
    let historyAttempted = false
    let listMessagesCalled = false
    let getProfileCalled = false
    const fakeClient = {
      listMessages: async (a: { maxResults: number; q?: string }) => {
        listMessagesCalled = true
        expect(a.q).toMatch(/^after:\d{4}\/\d{2}\/\d{2}$/)
        return { messages: [{ id: 'msg-fallback', threadId: 't1' }] }
      },
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => {
        historyAttempted = true
        const err = Object.assign(new Error('history id not found'), {
          response: { status: 404 },
        })
        throw err
      },
      getProfile: async () => {
        getProfileCalled = true
        return {
          email_address: 'alice@example.com',
          history_id: '12000',
          messages_total: 200,
          threads_total: 80,
        }
      },
    }

    const stubClassify = vi.fn(
      async (): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'receipt' as const,
        confidence: 'high' as const,
        reason: 'r',
        model_used: 'qwen2.5vl:7b',
        artifacts: [
          { kind: 'attachment' as const, mime_type: 'application/pdf', filename: 'fb.pdf' },
        ],
        source_bytes: new Map([['attachment:fb.pdf', goodPdf]]),
      }),
    )

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeClient,
        classifyMessage: stubClassify,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done

    expect(historyAttempted).toBe(true)
    expect(listMessagesCalled).toBe(true)
    expect(getProfileCalled).toBe(true)
    expect(stubClassify).toHaveBeenCalledTimes(1)

    // sync_state refreshed with the post-fallback history id from getProfile.
    const ss = syncStateRepo.get(accountId)
    expect(ss?.last_history_id).toBe('12000')

    // Account NOT flipped to needs_reauth — 404 is just a stale history id, not a token revoke.
    expect(accounts.findById(accountId)?.status).toBe('connected')
  })

  it('records sync_state.last_history_id from getProfile on the first sync (no prior history)', async () => {
    const syncStateRepo = await import('../db/repositories/sync_state.js')
    expect(syncStateRepo.get(accountId)).toBeUndefined()

    const fakeClient = {
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => ({}),
      getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: 'alice@example.com',
        history_id: '10000',
        messages_total: 1,
        threads_total: 1,
      }),
    }

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeClient,
        classifyMessage: vi.fn() as never,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done

    const ss = syncStateRepo.get(accountId)
    expect(ss).toBeDefined()
    expect(ss?.last_history_id).toBe('10000')
    expect(ss?.last_synced_at).toBe('2026-05-09T12:00:00.000Z')
  })

  it("renders the body to PDF and persists it as kind='rendered_body' when only a body artifact exists", async () => {
    const htmlSource = '<!doctype html><body>Body-receipt: total $9.99</body>'
    const renderedPdf = Buffer.from('%PDF-1.4\nrendered-from-html\n%%EOF')
    const renderHtmlToPdf = vi.fn(async (_html: string): Promise<Buffer> => renderedPdf)
    const stubClassify = vi.fn(
      async (
        _args: import('../classify/index.js').ClassifyMessageArgs,
        _deps: import('../classify/index.js').ClassifyMessageDeps,
      ): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'receipt' as const,
        confidence: 'high' as const,
        reason: 'body looks like a receipt',
        vendor: 'BodyVendor',
        amount: 9.99,
        currency: 'USD',
        transaction_date: '2026-05-09',
        model_used: 'qwen2.5vl:7b',
        artifacts: [{ kind: 'body' as const, mime_type: 'text/html' }],
        source_bytes: new Map([
          ['body:rendered_html_source', Buffer.from(htmlSource, 'utf8')],
        ]),
      }),
    )

    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-body']),
        classifyMessage: stubClassify,
        renderHtmlToPdf,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done
    await collectorDone
    await it.return?.()

    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1)
    expect(renderHtmlToPdf.mock.calls[0]?.[0]).toBe(htmlSource)

    const docs = documentsRepo.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
    })
    expect(docs.total).toBe(1)
    expect(docs.rows[0]).toMatchObject({
      account_id: accountId,
      message_id: 'msg-body',
      kind: 'rendered_body',
      mime_type: 'application/pdf',
      vendor: 'BodyVendor',
      amount: 9.99,
      currency: 'USD',
      transaction_date: '2026-05-09',
    })

    const onDisk = join(invoicesRoot, docs.rows[0]?.file_path ?? '')
    expect(readFileSync(onDisk).equals(renderedPdf)).toBe(true)

    const msgEv = collected.find((e) => e.event === 'sync.message')
    expect((msgEv?.payload as { document_ids: number[] }).document_ids).toEqual([
      docs.rows[0]?.id,
    ])
  })

  it('prefers attachment over body when both exist (no renderHtmlToPdf call)', async () => {
    const htmlSource = '<!doctype html><body>not used</body>'
    const pdfBytes = Buffer.from('%PDF-1.4\nattached-receipt\n%%EOF')
    const renderHtmlToPdf = vi.fn(async () =>
      Buffer.from('%PDF-1.4\nshould-not-be-called\n%%EOF'),
    )
    const stubClassify = vi.fn(
      async (
        _args: import('../classify/index.js').ClassifyMessageArgs,
        _deps: import('../classify/index.js').ClassifyMessageDeps,
      ): Promise<import('../classify/index.js').ClassifyResult> => ({
        classification: 'receipt' as const,
        confidence: 'high' as const,
        reason: 'attachment + body',
        model_used: 'qwen2.5vl:7b',
        artifacts: [
          { kind: 'body' as const, mime_type: 'text/html' },
          {
            kind: 'attachment' as const,
            mime_type: 'application/pdf',
            filename: 'invoice.pdf',
          },
        ],
        source_bytes: new Map<string, Buffer>([
          ['body:rendered_html_source', Buffer.from(htmlSource, 'utf8')],
          ['attachment:invoice.pdf', pdfBytes],
        ]),
      }),
    )

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages(['msg-both']),
        classifyMessage: stubClassify,
        renderHtmlToPdf,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done

    expect(renderHtmlToPdf).not.toHaveBeenCalled()

    const docs = documentsRepo.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
    })
    expect(docs.total).toBe(1)
    expect(docs.rows[0]).toMatchObject({
      kind: 'attachment',
      filename: 'invoice.pdf',
    })
  })

  it('skips accounts in needs_reauth status and emits sync.error for them', async () => {
    accounts.updateStatus(accountId, 'needs_reauth')
    const stubClassify = vi.fn()

    const collected: Array<{ event: string; payload: unknown }> = []
    const it = eventsModule.syncEvents.subscribe()[Symbol.asyncIterator]()
    const collectorDone = (async () => {
      while (true) {
        const r = await it.next()
        if (r.done) return
        collected.push(r.value)
        if (r.value.event === 'sync.done') return
      }
    })()

    const { done } = await orchestrator.runSync(
      {},
      {
        createGmailClient: () => fakeGmailClientWithMessages([]),
        classifyMessage: stubClassify as never,
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    )
    await done
    await collectorDone
    await it.return?.()

    expect(stubClassify).not.toHaveBeenCalled()
    const errEv = collected.find((e) => e.event === 'sync.error')
    expect(errEv?.payload).toMatchObject({ account_id: accountId })
  })
})
