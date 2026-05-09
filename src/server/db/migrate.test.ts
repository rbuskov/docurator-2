import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'

describe('migrate', () => {
  let tempDir: string
  let migrationsDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-migrate-'))
    migrationsDir = join(tempDir, 'migrations')
    mkdirSync(migrationsDir)
    db = new Database(join(tempDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeMigration(name: string, sql: string): void {
    writeFileSync(join(migrationsDir, name), sql)
  }

  it('applies all unapplied migrations in lexical order', () => {
    writeMigration('0001_first.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);')
    writeMigration('0002_second.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);')

    migrate(db, migrationsDir)

    const applied = db
      .prepare('SELECT filename FROM _migrations ORDER BY filename')
      .all() as { filename: string }[]
    expect(applied.map((r) => r.filename)).toEqual(['0001_first.sql', '0002_second.sql'])

    db.exec('INSERT INTO t1 (id) VALUES (1)')
    db.exec('INSERT INTO t2 (id) VALUES (1)')
  })

  it('is a no-op on a second run', () => {
    writeMigration('0001_first.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);')

    migrate(db, migrationsDir)
    migrate(db, migrationsDir)

    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number }
    ).c
    expect(count).toBe(1)
  })

  it('skips already-applied migrations recorded in _migrations', () => {
    writeMigration('0001_first.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);')
    writeMigration('0002_second.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);')

    db.exec('CREATE TABLE _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
    db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)')
    db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(
      '0001_first.sql',
      new Date().toISOString(),
    )

    migrate(db, migrationsDir)

    const applied = db
      .prepare('SELECT filename FROM _migrations ORDER BY filename')
      .all() as { filename: string }[]
    expect(applied.map((r) => r.filename)).toEqual(['0001_first.sql', '0002_second.sql'])

    db.exec('INSERT INTO t2 (id) VALUES (1)')
  })

  it('rolls back the failing migration entirely on error', () => {
    writeMigration('0001_first.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);')
    writeMigration(
      '0002_second.sql',
      'CREATE TABLE t2 (id INTEGER PRIMARY KEY);\nINSERT INTO t2 (id, missing_col) VALUES (1, 2);',
    )

    expect(() => migrate(db, migrationsDir)).toThrow()

    const applied = db
      .prepare('SELECT filename FROM _migrations ORDER BY filename')
      .all() as { filename: string }[]
    expect(applied.map((r) => r.filename)).toEqual(['0001_first.sql'])

    db.exec('INSERT INTO t1 (id) VALUES (1)')
    expect(() => db.exec('INSERT INTO t2 (id) VALUES (1)')).toThrow()
  })
})
