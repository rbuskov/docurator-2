import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('db singleton', () => {
  let tempDir: string
  let tempPath: string

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-db-'))
    tempPath = join(tempDir, 'test.db')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns the same instance on repeated calls', async () => {
    const { getDb, setDbPathForTest } = await import('./index.js')
    setDbPathForTest(tempPath)
    const a = getDb()
    const b = getDb()
    expect(a).toBe(b)
  })

  it('opens the connection at the override path provided to setDbPathForTest', async () => {
    const { getDb, setDbPathForTest } = await import('./index.js')
    setDbPathForTest(tempPath)
    const db = getDb()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.prepare('INSERT INTO t (id) VALUES (?)').run(42)
    const row = db.prepare('SELECT id FROM t').get() as { id: number }
    expect(row.id).toBe(42)
  })

  it('replaces and closes the old handle when setDbPathForTest is called again', async () => {
    const { getDb, setDbPathForTest } = await import('./index.js')
    setDbPathForTest(tempPath)
    const first = getDb()

    const tempPath2 = join(tempDir, 'other.db')
    setDbPathForTest(tempPath2)
    const second = getDb()

    expect(second).not.toBe(first)
    expect(() => first.exec('CREATE TABLE z (id INTEGER PRIMARY KEY)')).toThrow()
  })
})
