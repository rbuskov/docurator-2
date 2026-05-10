import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'migrations')

describe('sync_state repository', () => {
  let tempDir: string
  let syncState: typeof import('./sync_state.js')
  let accounts: typeof import('../../auth/accounts.js')
  let dbModule: typeof import('../index.js')
  let accountId: number

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-sync-state-'))

    dbModule = await import('../index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    accounts = await import('../../auth/accounts.js')
    syncState = await import('./sync_state.js')

    const a = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    })
    accountId = a.id
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('get returns undefined when no row exists for the account', () => {
    expect(syncState.get(accountId)).toBeUndefined()
  })

  it('upsert inserts a row that is then returned by get', () => {
    syncState.upsert({
      account_id: accountId,
      last_history_id: 'abc123',
      last_synced_at: '2026-05-09T10:00:00Z',
    })
    expect(syncState.get(accountId)).toEqual({
      account_id: accountId,
      last_history_id: 'abc123',
      last_synced_at: '2026-05-09T10:00:00Z',
    })
  })

  it('upsert updates an existing row in place — only one row per account', () => {
    syncState.upsert({
      account_id: accountId,
      last_history_id: 'first',
      last_synced_at: '2026-05-09T10:00:00Z',
    })
    syncState.upsert({
      account_id: accountId,
      last_history_id: 'second',
      last_synced_at: '2026-05-09T11:00:00Z',
    })
    expect(syncState.get(accountId)).toEqual({
      account_id: accountId,
      last_history_id: 'second',
      last_synced_at: '2026-05-09T11:00:00Z',
    })

    const count = (
      dbModule
        .getDb()
        .prepare('SELECT COUNT(*) AS c FROM sync_state WHERE account_id = ?')
        .get(accountId) as { c: number }
    ).c
    expect(count).toBe(1)
  })

  it('accepts null for both last_history_id and last_synced_at', () => {
    syncState.upsert({
      account_id: accountId,
      last_history_id: null,
      last_synced_at: null,
    })
    expect(syncState.get(accountId)).toEqual({
      account_id: accountId,
      last_history_id: null,
      last_synced_at: null,
    })
  })

  it('throws when account_id references a non-existent account (FK enforcement)', () => {
    expect(() =>
      syncState.upsert({
        account_id: 99999,
        last_history_id: 'abc',
        last_synced_at: '2026-05-09T10:00:00Z',
      }),
    ).toThrow(/FOREIGN KEY/)
  })
})
