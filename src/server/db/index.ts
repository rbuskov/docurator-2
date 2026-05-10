import Database from 'better-sqlite3'
import { config } from '../config.js'

let _db: Database.Database | undefined
let _path: string | undefined

export function getDb(): Database.Database {
  if (_db === undefined) {
    _db = new Database(_path ?? config.dbPath)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
  }
  return _db
}

export function setDbPathForTest(path: string): void {
  if (_db !== undefined) {
    _db.close()
    _db = undefined
  }
  _path = path
}
