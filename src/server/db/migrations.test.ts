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

describe('0002_create_processed_messages.sql', () => {
  let tempDir: string
  let db: Database.Database
  let accountId: number

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-mig-002-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, migrationsDir)
    const info = db
      .prepare(
        `INSERT INTO accounts (email, slug, connected_at, status)
         VALUES ('a@x.com', 'a-at-x-com', '2026-05-09T00:00:00Z', 'connected')`,
      )
      .run()
    accountId = Number(info.lastInsertRowid)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function insertRow(overrides: Record<string, unknown> = {}): unknown {
    const row = {
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
    return db
      .prepare(
        `INSERT INTO processed_messages
         (account_id, message_id, thread_id, internal_date, processed_at, model_used,
          status, error_message, classification, confidence, reason, sender_domain, subject)
         VALUES (@account_id, @message_id, @thread_id, @internal_date, @processed_at, @model_used,
          @status, @error_message, @classification, @confidence, @reason, @sender_domain, @subject)`,
      )
      .run(row)
  }

  it('creates the processed_messages table with the spec column layout', () => {
    const cols = db.prepare('PRAGMA table_info(processed_messages)').all() as Array<{
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    expect(cols.map((c) => c.name).sort()).toEqual([
      'account_id',
      'classification',
      'confidence',
      'error_message',
      'id',
      'internal_date',
      'message_id',
      'model_used',
      'processed_at',
      'reason',
      'sender_domain',
      'status',
      'subject',
      'thread_id',
    ])

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({ type: 'INTEGER', pk: 1 })
    expect(byName.account_id).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 })
    expect(byName.message_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.thread_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.internal_date).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.processed_at).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.model_used).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.status).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.error_message).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.classification).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.confidence).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.reason).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.sender_domain).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.subject).toMatchObject({ type: 'TEXT', notnull: 0 })
  })

  it('uses AUTOINCREMENT on id (sqlite_sequence row exists)', () => {
    const seq = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
      .get() as { name: string } | undefined
    expect(seq?.name).toBe('sqlite_sequence')
  })

  it('declares a foreign key on account_id referencing accounts(id)', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(processed_messages)').all() as Array<{
      table: string
      from: string
      to: string
    }>
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ table: 'accounts', from: 'account_id', to: 'id' })
  })

  it('creates the (account_id, message_id, processed_at DESC) and (account_id, processed_at) indices', () => {
    const indices = db.prepare('PRAGMA index_list(processed_messages)').all() as Array<{
      name: string
      unique: number
    }>
    const userIndices = indices.filter((i) => !i.name.startsWith('sqlite_autoindex'))
    expect(userIndices).toHaveLength(2)

    const resolved = userIndices.map((i) => {
      const cols = db.prepare(`PRAGMA index_xinfo(${i.name})`).all() as Array<{
        seqno: number
        name: string | null
        desc: number
        key: number
      }>
      return {
        name: i.name,
        keyCols: cols.filter((c) => c.key === 1),
      }
    })

    const composite = resolved.find(
      (i) =>
        i.keyCols.map((c) => c.name).join(',') ===
        'account_id,message_id,processed_at',
    )
    const accountProcessed = resolved.find(
      (i) => i.keyCols.map((c) => c.name).join(',') === 'account_id,processed_at',
    )
    expect(composite).toBeDefined()
    expect(accountProcessed).toBeDefined()

    const processedAtCol = composite!.keyCols.find((c) => c.name === 'processed_at')
    expect(processedAtCol?.desc).toBe(1)
  })

  it('enforces the status CHECK constraint', () => {
    expect(() => insertRow({ status: 'banana' })).toThrow(/CHECK/)
  })

  it('enforces the classification CHECK constraint', () => {
    expect(() => insertRow({ classification: 'spam' })).toThrow(/CHECK/)
    expect(() => insertRow({ classification: null })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-receipt', classification: 'receipt' })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-invoice', classification: 'invoice' })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-other', classification: 'other' })).not.toThrow()
  })

  it('enforces the confidence CHECK constraint', () => {
    expect(() => insertRow({ confidence: 'ultra' })).toThrow(/CHECK/)
    expect(() => insertRow({ confidence: null })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-high', confidence: 'high' })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-med', confidence: 'medium' })).not.toThrow()
    expect(() => insertRow({ message_id: 'm-low', confidence: 'low' })).not.toThrow()
  })

  it('allows two rows with the same (account_id, message_id) — append-only audit log', () => {
    insertRow({ message_id: 'msg-1', processed_at: '2026-05-09T10:00:00Z' })
    expect(() =>
      insertRow({ message_id: 'msg-1', processed_at: '2026-05-09T11:00:00Z' }),
    ).not.toThrow()
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM processed_messages WHERE message_id = ?')
        .get('msg-1') as { c: number }
    ).c
    expect(count).toBe(2)
  })
})

describe('0003_create_sync_state.sql', () => {
  let tempDir: string
  let db: Database.Database
  let accountId: number

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-mig-003-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, migrationsDir)
    const info = db
      .prepare(
        `INSERT INTO accounts (email, slug, connected_at, status)
         VALUES ('a@x.com', 'a-at-x-com', '2026-05-09T00:00:00Z', 'connected')`,
      )
      .run()
    accountId = Number(info.lastInsertRowid)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the sync_state table with the spec column layout', () => {
    const cols = db.prepare('PRAGMA table_info(sync_state)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>

    expect(cols.map((c) => c.name).sort()).toEqual([
      'account_id',
      'last_history_id',
      'last_synced_at',
    ])

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.account_id).toMatchObject({ type: 'INTEGER', pk: 1 })
    expect(byName.last_history_id).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.last_synced_at).toMatchObject({ type: 'TEXT', notnull: 0 })
  })

  it('declares a foreign key on account_id referencing accounts(id)', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(sync_state)').all() as Array<{
      table: string
      from: string
      to: string
    }>
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ table: 'accounts', from: 'account_id', to: 'id' })
  })

  it('uses account_id as the single-column primary key', () => {
    db.prepare(
      'INSERT INTO sync_state (account_id, last_history_id, last_synced_at) VALUES (?, ?, ?)',
    ).run(accountId, 'h1', '2026-05-09T10:00:00Z')
    expect(() =>
      db
        .prepare(
          'INSERT INTO sync_state (account_id, last_history_id, last_synced_at) VALUES (?, ?, ?)',
        )
        .run(accountId, 'h2', '2026-05-09T11:00:00Z'),
    ).toThrow(/UNIQUE|PRIMARY KEY/)
  })
})

describe('0004_create_app_config.sql', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-mig-004-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, migrationsDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the app_config table with the spec column layout', () => {
    const cols = db.prepare('PRAGMA table_info(app_config)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
      dflt_value: string | null
    }>

    expect(cols.map((c) => c.name).sort()).toEqual(['fiscal_year_start_month', 'id'])
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({ type: 'INTEGER', pk: 1 })
    expect(byName.fiscal_year_start_month).toMatchObject({ type: 'INTEGER', notnull: 1 })
  })

  it('seeds exactly one row with id=1 and fiscal_year_start_month=1', () => {
    const rows = db.prepare('SELECT id, fiscal_year_start_month FROM app_config').all() as Array<{
      id: number
      fiscal_year_start_month: number
    }>
    expect(rows).toEqual([{ id: 1, fiscal_year_start_month: 1 }])
  })

  it('rejects rows with id != 1 (single-row CHECK)', () => {
    expect(() =>
      db
        .prepare('INSERT INTO app_config (id, fiscal_year_start_month) VALUES (?, ?)')
        .run(2, 1),
    ).toThrow(/CHECK/)
  })

  it('rejects a second row with id=1 (PK uniqueness)', () => {
    expect(() =>
      db
        .prepare('INSERT INTO app_config (id, fiscal_year_start_month) VALUES (?, ?)')
        .run(1, 6),
    ).toThrow(/UNIQUE|PRIMARY KEY/)
  })

  it('enforces the fiscal_year_start_month range CHECK', () => {
    expect(() =>
      db.prepare('UPDATE app_config SET fiscal_year_start_month = ? WHERE id = 1').run(13),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE app_config SET fiscal_year_start_month = ? WHERE id = 1').run(0),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE app_config SET fiscal_year_start_month = ? WHERE id = 1').run(7),
    ).not.toThrow()
  })

  it('does not duplicate the seed row when migrate runs again on the same DB', () => {
    migrate(db, migrationsDir)
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM app_config').get() as { c: number }
    ).c
    expect(count).toBe(1)
  })
})
