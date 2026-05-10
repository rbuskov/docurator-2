import type Database from 'better-sqlite3'
import { getDb } from '../index.js'

export type ProcessedMessageStatus = 'success' | 'failed'
export type ProcessedMessageClassification = 'invoice' | 'receipt' | 'other'
export type ProcessedMessageConfidence = 'high' | 'medium' | 'low'

export type ProcessedMessageInput = {
  account_id: number
  message_id: string
  thread_id: string
  internal_date: string
  processed_at: string
  model_used: string
  status: ProcessedMessageStatus
  error_message: string | null
  classification: ProcessedMessageClassification | null
  confidence: ProcessedMessageConfidence | null
  reason: string | null
  sender_domain: string | null
  subject: string | null
}

export type ProcessedMessage = {
  message_id: string
  thread_id: string
  internal_date: string
  processed_at: string
  model_used: string
  status: ProcessedMessageStatus
  classification: ProcessedMessageClassification | null
  confidence: ProcessedMessageConfidence | null
  sender_domain: string | null
  subject: string | null
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

export function existsForMessage(args: {
  account_id: number
  message_id: string
}): boolean {
  const row = stmt(
    getDb(),
    'existsForMessage',
    'SELECT 1 AS one FROM processed_messages WHERE account_id = ? AND message_id = ? LIMIT 1',
  ).get(args.account_id, args.message_id) as { one: number } | undefined
  return row !== undefined
}

export function insert(input: ProcessedMessageInput): number {
  const result = stmt(
    getDb(),
    'insert',
    `INSERT INTO processed_messages
       (account_id, message_id, thread_id, internal_date, processed_at, model_used,
        status, error_message, classification, confidence, reason, sender_domain, subject)
     VALUES
       (@account_id, @message_id, @thread_id, @internal_date, @processed_at, @model_used,
        @status, @error_message, @classification, @confidence, @reason, @sender_domain, @subject)`,
  ).run(input)
  return Number(result.lastInsertRowid)
}

export function listForAccount(args: {
  account_id: number
  limit: number
}): ProcessedMessage[] {
  return stmt(
    getDb(),
    'listForAccount',
    `SELECT message_id, thread_id, internal_date, processed_at, model_used,
            status, classification, confidence, sender_domain, subject
       FROM processed_messages
      WHERE account_id = ?
      ORDER BY processed_at DESC
      LIMIT ?`,
  ).all(args.account_id, args.limit) as ProcessedMessage[]
}

export function countForAccount(args: { account_id: number }): number {
  const row = stmt(
    getDb(),
    'countForAccount',
    'SELECT COUNT(*) AS c FROM processed_messages WHERE account_id = ?',
  ).get(args.account_id) as { c: number }
  return row.c
}
