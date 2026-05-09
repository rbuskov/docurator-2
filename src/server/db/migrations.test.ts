import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, 'migrations')

describe('0001_create_accounts.sql', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-mig-001-'))
    db = new Database(join(tempDir, 'test.db'))
    migrate(db, migrationsDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the accounts table with the spec column layout', () => {
    const cols = db.prepare('PRAGMA table_info(accounts)').all() as Array<{
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    expect(cols.map((c) => c.name).sort()).toEqual(
      ['connected_at', 'display_name', 'email', 'id', 'last_seen_at', 'slug', 'status'],
    )

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({ type: 'INTEGER', pk: 1 })
    expect(byName.email).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(byName.display_name).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 })
    expect(byName.slug).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(byName.connected_at).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(byName.last_seen_at).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 })
    expect(byName.status).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
  })

  it('enforces UNIQUE on email', () => {
    db.prepare(
      `INSERT INTO accounts (email, slug, connected_at, status)
       VALUES ('a@x.com', 'a-at-x-com', '2026-05-09T00:00:00Z', 'connected')`,
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (email, slug, connected_at, status)
           VALUES ('a@x.com', 'other-slug', '2026-05-09T00:00:00Z', 'connected')`,
        )
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('enforces UNIQUE on slug', () => {
    db.prepare(
      `INSERT INTO accounts (email, slug, connected_at, status)
       VALUES ('a@x.com', 'shared-slug', '2026-05-09T00:00:00Z', 'connected')`,
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (email, slug, connected_at, status)
           VALUES ('b@x.com', 'shared-slug', '2026-05-09T00:00:00Z', 'connected')`,
        )
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('enforces the status CHECK constraint', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (email, slug, connected_at, status)
           VALUES ('a@x.com', 'a-at-x-com', '2026-05-09T00:00:00Z', 'banana')`,
        )
        .run(),
    ).toThrow(/CHECK/)
  })
})
