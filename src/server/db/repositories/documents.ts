import type Database from 'better-sqlite3'
import { getDb } from '../index.js'
import type {
  ProcessedMessageClassification,
  ProcessedMessageConfidence,
} from './processed_messages.js'

export type DocumentKind = 'attachment' | 'rendered_body'
export type DocumentReviewStatus = 'pending' | 'approved' | 'rejected'

export type DocumentInput = {
  account_id: number
  message_id: string
  kind: DocumentKind
  filename: string
  mime_type: string
  size: number
  content_hash: string
  file_path: string
  vendor: string | null
  amount: number | null
  currency: string | null
  transaction_date: string | null
  created_at: string
  updated_at: string
}

export type Document = {
  id: number
  account_id: number
  message_id: string
  kind: DocumentKind
  filename: string
  mime_type: string
  size: number
  content_hash: string
  file_path: string
  vendor: string | null
  amount: number | null
  currency: string | null
  transaction_date: string | null
  review_status: DocumentReviewStatus
  created_at: string
  updated_at: string
}

// listForAccount joins to processed_messages on (account_id, message_id) and
// filters to the most recent attempt — Slice 004's processed_messages is
// append-only (one row per reclassification attempt). The Inbox surfaces the
// latest attempt's classification + subject + sender_domain.
export type DocumentListRow = Document & {
  classification: ProcessedMessageClassification | null
  confidence: ProcessedMessageConfidence | null
  subject: string | null
  sender_domain: string | null
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

export function existsByHash(args: {
  account_id: number
  content_hash: string
}): boolean {
  const row = stmt(
    getDb(),
    'existsByHash',
    'SELECT 1 AS one FROM documents WHERE account_id = ? AND content_hash = ? LIMIT 1',
  ).get(args.account_id, args.content_hash) as { one: number } | undefined
  return row !== undefined
}

export function insert(input: DocumentInput): number {
  const result = stmt(
    getDb(),
    'insert',
    `INSERT INTO documents
       (account_id, message_id, kind, filename, mime_type, size, content_hash, file_path,
        vendor, amount, currency, transaction_date, created_at, updated_at)
     VALUES
       (@account_id, @message_id, @kind, @filename, @mime_type, @size, @content_hash, @file_path,
        @vendor, @amount, @currency, @transaction_date, @created_at, @updated_at)`,
  ).run(input)
  return Number(result.lastInsertRowid)
}

export function findById(id: number): Document | undefined {
  return stmt(getDb(), 'findById', 'SELECT * FROM documents WHERE id = ?').get(id) as
    | Document
    | undefined
}

export function findByHash(args: {
  account_id: number
  content_hash: string
}): Document | undefined {
  return stmt(
    getDb(),
    'findByHash',
    'SELECT * FROM documents WHERE account_id = ? AND content_hash = ?',
  ).get(args.account_id, args.content_hash) as Document | undefined
}

const SELECT_LATEST_PM = `
  LEFT JOIN processed_messages pm
         ON pm.id = (
           SELECT MAX(id) FROM processed_messages
            WHERE account_id = d.account_id AND message_id = d.message_id
         )`

export function listForAccount(args: {
  account_id: number
  limit: number
  offset: number
  review_status?: DocumentReviewStatus
}): { rows: DocumentListRow[]; total: number } {
  const filterClause = args.review_status !== undefined ? ' AND d.review_status = @review_status' : ''
  const totalKey = args.review_status !== undefined ? 'totalForStatus' : 'total'
  const listKey = args.review_status !== undefined ? 'listForStatus' : 'list'

  const total = (
    stmt(
      getDb(),
      totalKey,
      `SELECT COUNT(*) AS c FROM documents d
        WHERE d.account_id = @account_id${filterClause}`,
    ).get({ account_id: args.account_id, review_status: args.review_status ?? null }) as {
      c: number
    }
  ).c

  const rows = stmt(
    getDb(),
    listKey,
    `SELECT d.*,
            pm.classification AS classification,
            pm.confidence AS confidence,
            pm.subject AS subject,
            pm.sender_domain AS sender_domain
       FROM documents d
       ${SELECT_LATEST_PM}
      WHERE d.account_id = @account_id${filterClause}
      ORDER BY d.created_at DESC
      LIMIT @limit OFFSET @offset`,
  ).all({
    account_id: args.account_id,
    review_status: args.review_status ?? null,
    limit: args.limit,
    offset: args.offset,
  }) as DocumentListRow[]

  return { rows, total }
}
