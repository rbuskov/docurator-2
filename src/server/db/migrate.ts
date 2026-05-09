import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export function migrate(db: Database.Database, migrationsDir: string): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const appliedRows = db
    .prepare('SELECT filename FROM _migrations')
    .all() as { filename: string }[]
  const applied = new Set(appliedRows.map((r) => r.filename))

  for (const filename of files) {
    if (applied.has(filename)) continue
    const sql = readFileSync(join(migrationsDir, filename), 'utf8')
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(
        filename,
        new Date().toISOString(),
      )
    })
    tx()
  }
}
