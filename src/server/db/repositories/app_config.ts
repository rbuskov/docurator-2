import type Database from 'better-sqlite3'
import { getDb } from '../index.js'

export type AppConfig = {
  id: 1
  fiscal_year_start_month: number
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

export function get(): AppConfig {
  const row = stmt(
    getDb(),
    'get',
    'SELECT id, fiscal_year_start_month FROM app_config WHERE id = 1',
  ).get() as AppConfig | undefined
  if (row === undefined) {
    throw new Error('app_config row missing — migration 0004 did not seed')
  }
  return row
}

export function update(partial: { fiscal_year_start_month?: number }): void {
  if (partial.fiscal_year_start_month !== undefined) {
    stmt(
      getDb(),
      'updateFiscalYearStartMonth',
      'UPDATE app_config SET fiscal_year_start_month = ? WHERE id = 1',
    ).run(partial.fiscal_year_start_month)
  }
}
