import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'migrations')

describe('documents repository', () => {
  let tempDir: string
  let documents: typeof import('./documents.js')
  let processedMessages: typeof import('./processed_messages.js')
  let accounts: typeof import('../../auth/accounts.js')
  let dbModule: typeof import('../index.js')
  let accountId: number
  let secondAccountId: number

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-documents-'))

    dbModule = await import('../index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
    dbModule.getDb().pragma('foreign_keys = ON')

    accounts = await import('../../auth/accounts.js')
    documents = await import('./documents.js')
    processedMessages = await import('./processed_messages.js')

    accountId = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    }).id

    secondAccountId = accounts.insert({
      email: 'bob@example.com',
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
    rmSync(tempDir, { recursive: true, force: true })
  })

  function baseDoc(
    overrides: Partial<import('./documents.js').DocumentInput> = {},
  ): import('./documents.js').DocumentInput {
    return {
      account_id: accountId,
      message_id: 'msg-1',
      kind: 'attachment',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      size: 1024,
      content_hash: 'h1',
      file_path: 'alice-at-example-com/2026/05/msg-1_0_invoice.pdf',
      vendor: null,
      amount: null,
      currency: null,
      transaction_date: null,
      created_at: '2026-05-09T10:00:00Z',
      updated_at: '2026-05-09T10:00:00Z',
      ...overrides,
    }
  }

  function basePM(
    overrides: Partial<import('./processed_messages.js').ProcessedMessageInput> = {},
  ): import('./processed_messages.js').ProcessedMessageInput {
    return {
      account_id: accountId,
      message_id: 'msg-1',
      thread_id: 't1',
      internal_date: '1715000000000',
      processed_at: '2026-05-09T10:00:00Z',
      model_used: 'qwen2.5vl:7b',
      status: 'success',
      error_message: null,
      classification: 'receipt',
      confidence: 'high',
      reason: 'invoice from acme',
      sender_domain: 'acme.com',
      subject: 'Your receipt',
      ...overrides,
    }
  }

  it('existsByHash returns false for an unseen hash and true after insert', () => {
    expect(documents.existsByHash({ account_id: accountId, content_hash: 'h1' })).toBe(false)
    documents.insert(baseDoc({ content_hash: 'h1' }))
    expect(documents.existsByHash({ account_id: accountId, content_hash: 'h1' })).toBe(true)
  })

  it('existsByHash is account-scoped (other account does not see this hash)', () => {
    documents.insert(baseDoc({ content_hash: 'shared' }))
    expect(documents.existsByHash({ account_id: secondAccountId, content_hash: 'shared' })).toBe(
      false,
    )
  })

  it('insert returns the surrogate id; findById returns the row', () => {
    const id = documents.insert(baseDoc({ vendor: 'Acme', amount: 12.5, currency: 'EUR' }))
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)

    const row = documents.findById(id)
    expect(row).toMatchObject({
      id,
      account_id: accountId,
      message_id: 'msg-1',
      kind: 'attachment',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      size: 1024,
      content_hash: 'h1',
      file_path: 'alice-at-example-com/2026/05/msg-1_0_invoice.pdf',
      vendor: 'Acme',
      amount: 12.5,
      currency: 'EUR',
      transaction_date: null,
      review_status: 'pending',
    })
  })

  it('findById returns undefined for an unknown id', () => {
    expect(documents.findById(999)).toBeUndefined()
  })

  it('rejects insert with a non-existent account_id (FK constraint)', () => {
    expect(() => documents.insert(baseDoc({ account_id: 999 }))).toThrow(/FOREIGN KEY/)
  })

  it('rejects a second insert with the same (account_id, content_hash) (UNIQUE)', () => {
    documents.insert(baseDoc({ content_hash: 'shared' }))
    expect(() =>
      documents.insert(baseDoc({ message_id: 'msg-2', content_hash: 'shared' })),
    ).toThrow(/UNIQUE/)
  })

  it('listForAccount orders by created_at DESC and respects limit + offset', () => {
    documents.insert(baseDoc({ message_id: 'msg-1', content_hash: 'h1', created_at: '2026-05-01T10:00:00Z' }))
    documents.insert(baseDoc({ message_id: 'msg-2', content_hash: 'h2', created_at: '2026-05-02T10:00:00Z' }))
    documents.insert(baseDoc({ message_id: 'msg-3', content_hash: 'h3', created_at: '2026-05-03T10:00:00Z' }))

    const page1 = documents.listForAccount({ account_id: accountId, limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.rows.map((r) => r.message_id)).toEqual(['msg-3', 'msg-2'])

    const page2 = documents.listForAccount({ account_id: accountId, limit: 2, offset: 2 })
    expect(page2.total).toBe(3)
    expect(page2.rows.map((r) => r.message_id)).toEqual(['msg-1'])
  })

  it("listForAccount filters by review_status when provided", () => {
    const id1 = documents.insert(baseDoc({ message_id: 'msg-1', content_hash: 'h1' }))
    const id2 = documents.insert(baseDoc({ message_id: 'msg-2', content_hash: 'h2' }))
    documents.insert(baseDoc({ message_id: 'msg-3', content_hash: 'h3' }))
    dbModule.getDb().prepare("UPDATE documents SET review_status = 'approved' WHERE id = ?").run(id1)
    dbModule.getDb().prepare("UPDATE documents SET review_status = 'rejected' WHERE id = ?").run(id2)

    const pending = documents.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
      review_status: 'pending',
    })
    expect(pending.total).toBe(1)
    expect(pending.rows.map((r) => r.message_id)).toEqual(['msg-3'])

    const approved = documents.listForAccount({
      account_id: accountId,
      limit: 50,
      offset: 0,
      review_status: 'approved',
    })
    expect(approved.total).toBe(1)
    expect(approved.rows[0]?.message_id).toBe('msg-1')
  })

  it('listForAccount is account-scoped (other accounts excluded)', () => {
    documents.insert(baseDoc({ message_id: 'msg-1', content_hash: 'h1' }))
    documents.insert(
      baseDoc({
        account_id: secondAccountId,
        message_id: 'msg-1',
        content_hash: 'h2',
      }),
    )

    const result = documents.listForAccount({ account_id: accountId, limit: 50, offset: 0 })
    expect(result.total).toBe(1)
    expect(result.rows[0]?.account_id).toBe(accountId)
  })

  it('listForAccount surfaces the latest processed_messages attempt for subject + sender_domain', () => {
    documents.insert(baseDoc({ message_id: 'msg-1', content_hash: 'h1' }))

    // Older attempt: classified as 'other' with subject "First"
    processedMessages.insert(
      basePM({
        message_id: 'msg-1',
        processed_at: '2026-05-09T10:00:00Z',
        classification: 'other',
        subject: 'First',
        sender_domain: 'old.example.com',
      }),
    )
    // Newer attempt: re-classified as 'receipt' with subject "Latest"
    processedMessages.insert(
      basePM({
        message_id: 'msg-1',
        processed_at: '2026-05-09T11:00:00Z',
        classification: 'receipt',
        subject: 'Latest',
        sender_domain: 'new.example.com',
      }),
    )

    const result = documents.listForAccount({ account_id: accountId, limit: 50, offset: 0 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      subject: 'Latest',
      sender_domain: 'new.example.com',
      classification: 'receipt',
    })
  })

  it('listForAccount returns null subject + sender_domain when no processed_messages row exists', () => {
    documents.insert(baseDoc({ message_id: 'orphan', content_hash: 'h1' }))
    const result = documents.listForAccount({ account_id: accountId, limit: 50, offset: 0 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ subject: null, sender_domain: null, classification: null })
  })
})
