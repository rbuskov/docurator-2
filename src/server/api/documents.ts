import { existsSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Hono } from 'hono'
import { requireKnownAccount } from '../auth/preconditions.js'
import * as documentsRepo from '../db/repositories/documents.js'
import type { DocumentReviewStatus } from '../db/repositories/documents.js'
import { getInvoicesRoot } from '../files.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const VALID_REVIEW_STATUSES: DocumentReviewStatus[] = ['pending', 'approved', 'rejected']

export type DocumentsRouteDeps = {
  invoicesRoot?: string
}

export function registerDocumentsRoutes(app: Hono, deps: DocumentsRouteDeps = {}): void {
  const _invoicesRoot = (): string =>
    deps.invoicesRoot !== undefined ? resolve(deps.invoicesRoot) : getInvoicesRoot()

  app.get('/api/accounts/:id/documents', (c) => {
    const idParam = c.req.param('id')
    const id = Number(idParam)
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid_id' }, 400)
    }

    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')
    const reviewStatusParam = c.req.query('review_status')

    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: 'invalid_limit' }, 400)
    }

    const offset = offsetParam === undefined ? 0 : Number(offsetParam)
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json({ error: 'invalid_offset' }, 400)
    }

    let review_status: DocumentReviewStatus | undefined
    if (reviewStatusParam !== undefined) {
      if (!VALID_REVIEW_STATUSES.includes(reviewStatusParam as DocumentReviewStatus)) {
        return c.json({ error: 'invalid_review_status' }, 400)
      }
      review_status = reviewStatusParam as DocumentReviewStatus
    }

    const pre = requireKnownAccount(id)
    if (!pre.ok) return c.json(pre.body, pre.status)

    const result = documentsRepo.listForAccount({
      account_id: id,
      limit,
      offset,
      review_status,
    })
    return c.json(result)
  })

  app.get('/api/documents/:id/file', (c) => {
    const idParam = c.req.param('id')
    const id = Number(idParam)
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid_id' }, 400)
    }

    const row = documentsRepo.findById(id)
    if (row === undefined) {
      return c.json({ error: 'document_not_found' }, 404)
    }

    const root = _invoicesRoot()
    const absolute = resolve(root, row.file_path)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      // The row's file_path resolves outside the invoices root — refuse.
      // This shouldn't be reachable in normal operation; the orchestrator
      // writes via `files.ts` which guarantees the path is inside the root.
      return c.json({ error: 'invalid_file_path' }, 403)
    }

    if (!existsSync(absolute)) {
      return c.json({ error: 'file_not_found' }, 404)
    }

    const size = statSync(absolute).size
    const stream = createReadStream(absolute)
    c.header('Content-Type', row.mime_type)
    c.header('Content-Length', String(size))
    c.header('Content-Disposition', `inline; filename="${sanitizeForHeader(row.filename)}"`)
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>)
  })
}

function sanitizeForHeader(filename: string): string {
  // RFC 6266: only quoted-string characters allowed. Strip quotes and CRLF.
  return filename.replace(/["\r\n]/g, '_')
}
