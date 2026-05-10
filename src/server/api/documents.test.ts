import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'db', 'migrations')

describe('documents API routes', () => {
  let tempDir: string
  let invoicesRoot: string
  let dbModule: typeof import('../db/index.js')
  let accounts: typeof import('../auth/accounts.js')
  let documentsRepo: typeof import('../db/repositories/documents.js')
  let filesModule: typeof import('../files.js')
  let registerDocumentsRoutes: typeof import('./documents.js').registerDocumentsRoutes
  let app: Hono
  let accountId: number
  let secondAccountId: number

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-docs-api-'))
    invoicesRoot = mkdtempSync(join(tmpdir(), 'docurator-docs-api-invoices-'))

    dbModule = await import('../db/index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))
    const { migrate } = await import('../db/migrate.js')
    migrate(dbModule.getDb(), migrationsDir)
    dbModule.getDb().pragma('foreign_keys = ON')

    accounts = await import('../auth/accounts.js')
    documentsRepo = await import('../db/repositories/documents.js')
    filesModule = await import('../files.js')
    filesModule.setInvoicesRootForTest(invoicesRoot)
    ;({ registerDocumentsRoutes } = await import('./documents.js'))

    accountId = accounts.insert({
      email: 'alice@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    }).id
    secondAccountId = accounts.insert({
      email: 'bob@example.com',
      display_name: null,
      connected_at: '2026-05-09T10:00:00Z',
    }).id

    app = new Hono()
    registerDocumentsRoutes(app)
  })

  afterEach(() => {
    filesModule.resetInvoicesRootForTest()
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(invoicesRoot, { recursive: true, force: true })
  })

  function insertDoc(overrides: Record<string, unknown> = {}): {
    id: number
    file_path: string
    bytes: Buffer
  } {
    const bytes = Buffer.from((overrides.body as string) ?? 'pdf-bytes')
    delete overrides.body
    const file_path = (overrides.file_path as string) ?? `${overrides.account_slug ?? 'alice-at-example-com'}/2026/05/${(overrides.message_id as string) ?? 'msg-1'}_0_${(overrides.filename as string) ?? 'invoice.pdf'}`
    delete overrides.account_slug
    // Write the file at <invoicesRoot>/<file_path> so streaming tests find it.
    const absDir = join(invoicesRoot, dirname(file_path))
    require('node:fs').mkdirSync(absDir, { recursive: true })
    writeFileSync(join(invoicesRoot, file_path), bytes)
    const id = documentsRepo.insert({
      account_id: accountId,
      message_id: 'msg-1',
      kind: 'attachment',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      content_hash: `h-${Math.random()}`,
      file_path,
      vendor: null,
      amount: null,
      currency: null,
      transaction_date: null,
      created_at: '2026-05-09T10:00:00Z',
      updated_at: '2026-05-09T10:00:00Z',
      ...overrides,
    })
    return { id, file_path, bytes }
  }

  describe('GET /api/accounts/:id/documents', () => {
    it('returns 400 on a non-numeric :id', async () => {
      const res = await app.fetch(new Request('http://x/api/accounts/abc/documents'))
      expect(res.status).toBe(400)
    })

    it('returns 404 on an unknown account id', async () => {
      const res = await app.fetch(new Request('http://x/api/accounts/9999/documents'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'account_not_found' })
    })

    it('returns 200 with empty rows when no documents exist for the account', async () => {
      const res = await app.fetch(new Request(`http://x/api/accounts/${accountId}/documents`))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ rows: [], total: 0 })
    })

    it('returns the account-scoped documents in created_at DESC order', async () => {
      insertDoc({
        message_id: 'm1',
        content_hash: 'h1',
        file_path: 'alice-at-example-com/2026/05/m1_0_a.pdf',
        created_at: '2026-05-01T10:00:00Z',
      })
      insertDoc({
        message_id: 'm2',
        content_hash: 'h2',
        file_path: 'alice-at-example-com/2026/05/m2_0_b.pdf',
        created_at: '2026-05-02T10:00:00Z',
      })

      const res = await app.fetch(new Request(`http://x/api/accounts/${accountId}/documents`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rows: Array<{ message_id: string }>; total: number }
      expect(body.total).toBe(2)
      expect(body.rows.map((r) => r.message_id)).toEqual(['m2', 'm1'])
    })

    it('respects ?limit and ?offset', async () => {
      for (let i = 1; i <= 5; i++) {
        insertDoc({
          message_id: `m${i}`,
          content_hash: `h${i}`,
          file_path: `alice-at-example-com/2026/05/m${i}_0_a.pdf`,
          created_at: `2026-05-0${i}T10:00:00Z`,
        })
      }

      const page1 = await app.fetch(
        new Request(`http://x/api/accounts/${accountId}/documents?limit=2&offset=0`),
      )
      const body1 = (await page1.json()) as { rows: Array<{ message_id: string }>; total: number }
      expect(body1.total).toBe(5)
      expect(body1.rows.map((r) => r.message_id)).toEqual(['m5', 'm4'])

      const page2 = await app.fetch(
        new Request(`http://x/api/accounts/${accountId}/documents?limit=2&offset=2`),
      )
      const body2 = (await page2.json()) as { rows: Array<{ message_id: string }> }
      expect(body2.rows.map((r) => r.message_id)).toEqual(['m3', 'm2'])
    })

    it('filters by ?review_status when provided', async () => {
      const a = insertDoc({
        message_id: 'm1',
        content_hash: 'h1',
        file_path: 'alice-at-example-com/2026/05/m1_0_a.pdf',
      })
      insertDoc({
        message_id: 'm2',
        content_hash: 'h2',
        file_path: 'alice-at-example-com/2026/05/m2_0_b.pdf',
      })
      dbModule
        .getDb()
        .prepare("UPDATE documents SET review_status = 'approved' WHERE id = ?")
        .run(a.id)

      const res = await app.fetch(
        new Request(`http://x/api/accounts/${accountId}/documents?review_status=approved`),
      )
      const body = (await res.json()) as { rows: Array<{ message_id: string }>; total: number }
      expect(body.total).toBe(1)
      expect(body.rows[0]?.message_id).toBe('m1')
    })

    it("returns 400 on an invalid ?review_status value", async () => {
      const res = await app.fetch(
        new Request(`http://x/api/accounts/${accountId}/documents?review_status=archived`),
      )
      expect(res.status).toBe(400)
    })

    it('returns 200 (not 409) for accounts in needs_reauth status — listing is DB-only', async () => {
      accounts.updateStatus(accountId, 'needs_reauth')
      insertDoc({
        message_id: 'm1',
        content_hash: 'h1',
        file_path: 'alice-at-example-com/2026/05/m1_0_a.pdf',
      })
      const res = await app.fetch(new Request(`http://x/api/accounts/${accountId}/documents`))
      expect(res.status).toBe(200)
    })

    it('does not leak documents from other accounts', async () => {
      insertDoc({
        message_id: 'm1',
        content_hash: 'h1',
        file_path: 'alice-at-example-com/2026/05/m1_0_a.pdf',
      })
      const res = await app.fetch(
        new Request(`http://x/api/accounts/${secondAccountId}/documents`),
      )
      const body = (await res.json()) as { rows: unknown[]; total: number }
      expect(body.total).toBe(0)
      expect(body.rows).toEqual([])
    })
  })

  describe('GET /api/documents/:id/file', () => {
    it('returns 400 on non-numeric :id', async () => {
      const res = await app.fetch(new Request('http://x/api/documents/foo/file'))
      expect(res.status).toBe(400)
    })

    it('returns 404 when the document row does not exist', async () => {
      const res = await app.fetch(new Request('http://x/api/documents/9999/file'))
      expect(res.status).toBe(404)
    })

    it('streams the file bytes with the row mime_type and Content-Disposition: inline', async () => {
      const doc = insertDoc({
        message_id: 'm-stream',
        content_hash: 'h-stream',
        file_path: 'alice-at-example-com/2026/05/m-stream_0_invoice.pdf',
      })

      const res = await app.fetch(new Request(`http://x/api/documents/${doc.id}/file`))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^application\/pdf/)
      expect(res.headers.get('content-disposition')).toMatch(/inline/i)
      const buf = Buffer.from(await res.arrayBuffer())
      expect(buf.equals(doc.bytes)).toBe(true)
    })

    it("returns 404 when the row exists but the file is missing on disk", async () => {
      const doc = insertDoc({
        message_id: 'm-orphan',
        content_hash: 'h-orphan',
        file_path: 'alice-at-example-com/2026/05/m-orphan_0_invoice.pdf',
      })
      // Delete the file but keep the row.
      rmSync(join(invoicesRoot, doc.file_path))

      const res = await app.fetch(new Request(`http://x/api/documents/${doc.id}/file`))
      expect(res.status).toBe(404)
    })

    it("returns 403/404 when the row's file_path resolves outside the invoices root", async () => {
      // Construct a row by hand whose file_path escapes the root via `..`.
      const id = documentsRepo.insert({
        account_id: accountId,
        message_id: 'm-evil',
        kind: 'attachment',
        filename: 'evil.pdf',
        mime_type: 'application/pdf',
        size: 0,
        content_hash: 'h-evil',
        file_path: '../escape.pdf',
        vendor: null,
        amount: null,
        currency: null,
        transaction_date: null,
        created_at: '2026-05-09T10:00:00Z',
        updated_at: '2026-05-09T10:00:00Z',
      })

      const res = await app.fetch(new Request(`http://x/api/documents/${id}/file`))
      expect([403, 404]).toContain(res.status)
    })
  })
})
