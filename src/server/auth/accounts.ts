import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { slugify } from './slug.js'

export type AccountStatus = 'connected' | 'needs_reauth'

export type Account = {
  id: number
  email: string
  display_name: string | null
  slug: string
  connected_at: string
  last_seen_at: string | null
  status: AccountStatus
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

export function findByEmail(email: string): Account | undefined {
  return stmt(getDb(), 'findByEmail', 'SELECT * FROM accounts WHERE email = ?').get(email) as
    | Account
    | undefined
}

export function findById(id: number): Account | undefined {
  return stmt(getDb(), 'findById', 'SELECT * FROM accounts WHERE id = ?').get(id) as
    | Account
    | undefined
}

export function findBySlug(slug: string): Account | undefined {
  return stmt(getDb(), 'findBySlug', 'SELECT * FROM accounts WHERE slug = ?').get(slug) as
    | Account
    | undefined
}

export function insert(input: {
  email: string
  display_name: string | null
  connected_at: string
}): { id: number; slug: string } {
  const baseSlug = slugify(input.email)
  let slug = baseSlug
  let n = 2
  while (findBySlug(slug) !== undefined) {
    slug = `${baseSlug}-${n}`
    n += 1
  }

  const result = stmt(
    getDb(),
    'insert',
    `INSERT INTO accounts (email, display_name, slug, connected_at, status)
     VALUES (?, ?, ?, ?, 'connected')`,
  ).run(input.email, input.display_name, slug, input.connected_at)

  return { id: Number(result.lastInsertRowid), slug }
}

export function updateStatus(id: number, status: AccountStatus): void {
  stmt(getDb(), 'updateStatus', 'UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
}

export function touchLastSeen(id: number, at: string): void {
  stmt(getDb(), 'touchLastSeen', 'UPDATE accounts SET last_seen_at = ? WHERE id = ?').run(at, id)
}

export function list(): Account[] {
  return stmt(getDb(), 'list', 'SELECT * FROM accounts ORDER BY id ASC').all() as Account[]
}
