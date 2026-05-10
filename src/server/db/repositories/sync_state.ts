import type Database from 'better-sqlite3'
import { getDb } from '../index.js'

export type SyncState = {
  account_id: number
  last_history_id: string | null
  last_synced_at: string | null
}

const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>()

function stmt(db: Database.Database, key: string, sql: string): Database.Statement {
  let cache = stmtCache.get(db)
  if (cache === undefined) {
    cache = new Map()
    stmtCache.set(db, cache)
  }
  let s = cache.get(key)
  if (s === undefined) {
    s = db.prepare(sql)
    cache.set(key, s)
  }
  return s
}

export function get(account_id: number): SyncState | undefined {
  return stmt(
    getDb(),
    'get',
    'SELECT account_id, last_history_id, last_synced_at FROM sync_state WHERE account_id = ?',
  ).get(account_id) as SyncState | undefined
}

export function upsert(input: {
  account_id: number
  last_history_id: string | null
  last_synced_at: string | null
}): void {
  stmt(
    getDb(),
    'upsert',
    `INSERT INTO sync_state (account_id, last_history_id, last_synced_at)
     VALUES (@account_id, @last_history_id, @last_synced_at)
     ON CONFLICT(account_id) DO UPDATE SET
       last_history_id = excluded.last_history_id,
       last_synced_at = excluded.last_synced_at`,
  ).run(input)
}
