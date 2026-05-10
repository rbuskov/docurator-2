import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'migrations')

describe('processed_messages repository', () => {
  let tempDir: string
  let processedMessages: typeof import('./processed_messages.js')
  let accounts: typeof import('../../auth/accounts.js')
  let dbModule: typeof import('../index.js')
  let accountId: number
  let secondAccountId: number

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-processed-messages-'))

    dbModule = await import('../index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../../auth/accounts.js')
    processedMessages = await import('./processed_messages.js')

    const a = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    accountId = a.id

    const b = accounts.insert({
      email: 'bob@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    secondAccountId = b.id
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function baseInput(
    overrides: Partial<import('./processed_messages.js').ProcessedMessageInput> = {},
  ): import('./processed_messages.js').ProcessedMessageInput {
    return {
      account_id: accountId,
      message_id: 'm1',
      thread_id: 't1',
      internal_date: '1715000000000',
      processed_at: '2026-05-09T10:00:00Z',
      model_used: 'dev-seed',
      status: 'success',
      error_message: null,
      classification: 'other',
      confidence: 'low',
      reason: null,
      sender_domain: 'example.com',
      subject: 'hello',
      ...overrides,
    }
  }

  describe('existsForMessage', () => {
    it('returns false when no rows exist', () => {
      expect(
        processedMessages.existsForMessage({ account_id: accountId, message_id: 'm1' }),
      ).toBe(false)
    })

    it('returns true after a row is inserted for the same (account_id, message_id)', () => {
      processedMessages.insert(baseInput({ message_id: 'msg-x' }))
      expect(
        processedMessages.existsForMessage({ account_id: accountId, message_id: 'msg-x' }),
      ).toBe(true)
    })

    it('still returns true after a second row is appended for the same (account_id, message_id)', () => {
      processedMessages.insert(
        baseInput({ message_id: 'msg-x', processed_at: '2026-05-09T10:00:00Z' }),
      )
      processedMessages.insert(
        baseInput({ message_id: 'msg-x', processed_at: '2026-05-09T11:00:00Z' }),
      )
      expect(
        processedMessages.existsForMessage({ account_id: accountId, message_id: 'msg-x' }),
      ).toBe(true)
    })

    it('is account-scoped — a row under another account is not visible', () => {
      processedMessages.insert(
        baseInput({ account_id: secondAccountId, message_id: 'shared' }),
      )
      expect(
        processedMessages.existsForMessage({ account_id: accountId, message_id: 'shared' }),
      ).toBe(false)
    })
  })

  describe('insert', () => {
    it('returns a positive integer id and stores the row', () => {
      const id = processedMessages.insert(baseInput({ message_id: 'msg-1' }))
      expect(Number.isInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)

      const rows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        message_id: 'msg-1',
        thread_id: 't1',
        internal_date: '1715000000000',
        processed_at: '2026-05-09T10:00:00Z',
        model_used: 'dev-seed',
        status: 'success',
        classification: 'other',
        confidence: 'low',
        sender_domain: 'example.com',
        subject: 'hello',
      })
    })

    it('accepts null for every nullable column', () => {
      const id = processedMessages.insert(
        baseInput({
          message_id: 'msg-null',
          error_message: null,
          classification: null,
          confidence: null,
          reason: null,
          sender_domain: null,
          subject: null,
        }),
      )
      expect(id).toBeGreaterThan(0)

      const rows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
      const row = rows.find((r) => r.message_id === 'msg-null')
      expect(row).toBeDefined()
      expect(row).toMatchObject({
        classification: null,
        confidence: null,
        sender_domain: null,
        subject: null,
      })
    })

    it('throws on a status value outside the CHECK enum', () => {
      expect(() =>
        processedMessages.insert(baseInput({ status: 'banana' as 'success' })),
      ).toThrow(/CHECK/)
    })

    it('throws on a classification value outside the CHECK enum', () => {
      expect(() =>
        processedMessages.insert(
          baseInput({ classification: 'spam' as 'other' }),
        ),
      ).toThrow(/CHECK/)
    })

    it('throws when account_id references a non-existent account (FK enforcement)', () => {
      expect(() =>
        processedMessages.insert(baseInput({ account_id: 99999 })),
      ).toThrow(/FOREIGN KEY/)
    })
  })

  describe('listForAccount', () => {
    it('returns rows ordered by processed_at DESC', () => {
      processedMessages.insert(
        baseInput({ message_id: 'oldest', processed_at: '2026-05-09T08:00:00Z' }),
      )
      processedMessages.insert(
        baseInput({ message_id: 'newest', processed_at: '2026-05-09T12:00:00Z' }),
      )
      processedMessages.insert(
        baseInput({ message_id: 'middle', processed_at: '2026-05-09T10:00:00Z' }),
      )

      const rows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
      expect(rows.map((r) => r.message_id)).toEqual(['newest', 'middle', 'oldest'])
    })

    it('respects the limit', () => {
      for (let i = 0; i < 3; i++) {
        processedMessages.insert(
          baseInput({
            message_id: `m-${i}`,
            processed_at: `2026-05-09T1${i}:00:00Z`,
          }),
        )
      }
      const rows = processedMessages.listForAccount({ account_id: accountId, limit: 2 })
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.message_id)).toEqual(['m-2', 'm-1'])
    })

    it('is account-scoped — rows under another account are not returned', () => {
      processedMessages.insert(baseInput({ message_id: 'mine' }))
      processedMessages.insert(
        baseInput({ account_id: secondAccountId, message_id: 'theirs' }),
      )

      const rows = processedMessages.listForAccount({ account_id: accountId, limit: 50 })
      expect(rows.map((r) => r.message_id)).toEqual(['mine'])
    })
  })

  describe('countForAccount', () => {
    it('returns 0 when the account has no rows', () => {
      expect(processedMessages.countForAccount({ account_id: accountId })).toBe(0)
    })

    it('matches the actual row count for the account', () => {
      processedMessages.insert(baseInput({ message_id: 'a' }))
      processedMessages.insert(baseInput({ message_id: 'b' }))
      processedMessages.insert(baseInput({ message_id: 'c' }))
      expect(processedMessages.countForAccount({ account_id: accountId })).toBe(3)
    })

    it('is account-scoped', () => {
      processedMessages.insert(baseInput({ message_id: 'a' }))
      processedMessages.insert(
        baseInput({ account_id: secondAccountId, message_id: 'b' }),
      )
      expect(processedMessages.countForAccount({ account_id: accountId })).toBe(1)
      expect(processedMessages.countForAccount({ account_id: secondAccountId })).toBe(1)
    })
  })
})
