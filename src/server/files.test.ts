import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetInvoicesRootForTest,
  sanitizeFilename,
  setInvoicesRootForTest,
  writeReceiptFile,
} from './files.js'

describe('files.writeReceiptFile', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'docurator-files-'))
    setInvoicesRootForTest(tempRoot)
  })

  afterEach(() => {
    resetInvoicesRootForTest()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('writes bytes to {slug}/{yyyy}/{mm}/{message_id}_{seq}_{safe_filename}', () => {
    const bytes = Buffer.from('hello world')
    const result = writeReceiptFile({
      account_slug: 'alice-at-example-com',
      internal_date: String(Date.UTC(2026, 4, 9, 10, 0)),
      message_id: 'abc123',
      seq: 0,
      suggested_filename: 'invoice.pdf',
      bytes,
    })

    expect(result.file_path).toBe(
      'alice-at-example-com/2026/05/abc123_0_invoice.pdf',
    )
    expect(result.size).toBe(bytes.length)

    const expectedHash = createHash('sha256').update(bytes).digest('hex')
    expect(result.content_hash).toBe(expectedHash)

    const absPath = join(tempRoot, result.file_path)
    expect(existsSync(absPath)).toBe(true)
    expect(readFileSync(absPath).equals(bytes)).toBe(true)
  })

  it('projects yyyy/mm from internal_date in UTC', () => {
    // 2025-12-31T23:30:00Z (December UTC, even if local TZ rolls into Jan)
    const result = writeReceiptFile({
      account_slug: 's',
      internal_date: String(Date.UTC(2025, 11, 31, 23, 30)),
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
      bytes: Buffer.from('x'),
    })
    expect(result.file_path).toMatch(/^s\/2025\/12\//)
  })

  it('zero-pads single-digit months', () => {
    // 2026-03-15T00:00:00Z
    const result = writeReceiptFile({
      account_slug: 's',
      internal_date: String(Date.UTC(2026, 2, 15)),
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
      bytes: Buffer.from('x'),
    })
    expect(result.file_path).toContain('/2026/03/')
  })

  it('returns the SHA-256 hex matching node:crypto', () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const result = writeReceiptFile({
      account_slug: 's',
      internal_date: '0',
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.bin',
      bytes,
    })
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(result.content_hash).toBe(expected)
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('multiple seqs for the same message produce distinct paths', () => {
    const r0 = writeReceiptFile({
      account_slug: 's',
      internal_date: '0',
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
      bytes: Buffer.from('a'),
    })
    const r1 = writeReceiptFile({
      account_slug: 's',
      internal_date: '0',
      message_id: 'm',
      seq: 1,
      suggested_filename: 'b.pdf',
      bytes: Buffer.from('b'),
    })
    expect(r0.file_path).not.toBe(r1.file_path)
    expect(r0.file_path).toContain('m_0_')
    expect(r1.file_path).toContain('m_1_')
  })

  describe('filename sanitization', () => {
    it('strips path separators from a traversal-shaped suggested_filename', () => {
      const r = writeReceiptFile({
        account_slug: 's',
        internal_date: '0',
        message_id: 'm',
        seq: 0,
        suggested_filename: '../../etc/passwd',
        bytes: Buffer.from('x'),
      })
      const safeBasename = r.file_path.split('/').pop() ?? ''
      expect(safeBasename).not.toContain('..')
      expect(safeBasename).not.toContain('/')
      expect(safeBasename).toMatch(/^m_0_/)
    })

    it('strips path separators from an embedded-traversal filename', () => {
      const r = writeReceiptFile({
        account_slug: 's',
        internal_date: '0',
        message_id: 'm',
        seq: 0,
        suggested_filename: 'foo/../bar.pdf',
        bytes: Buffer.from('x'),
      })
      const safeBasename = r.file_path.split('/').pop() ?? ''
      expect(safeBasename).not.toContain('/')
      expect(safeBasename).not.toContain('..')
      expect(safeBasename).toMatch(/\.pdf$/)
    })

    it('escapes Windows reserved names', () => {
      expect(sanitizeFilename('CON.txt')).not.toBe('CON.txt')
      expect(sanitizeFilename('CON.txt')).toMatch(/^_?CON.txt$|^_CON\.txt$/i)
      expect(sanitizeFilename('LPT1.pdf').toLowerCase()).toContain('lpt1')
      // Pure CON without extension
      expect(sanitizeFilename('CON').toLowerCase()).not.toBe('con')
    })

    it('truncates very long names while preserving the extension', () => {
      const longName = `${'x'.repeat(500)}.pdf`
      const safe = sanitizeFilename(longName)
      expect(safe.length).toBeLessThanOrEqual(120)
      expect(safe).toMatch(/\.pdf$/)
    })

    it('strips control characters', () => {
      const naughty = `name\x00with\x01ctrl\x1f.pdf`
      const safe = sanitizeFilename(naughty)
      expect(safe).not.toMatch(/[\x00-\x1f]/)
      expect(safe).toMatch(/\.pdf$/)
    })

    it('strips colons, backslashes, and other path-hostile chars', () => {
      const safe = sanitizeFilename('a:b\\c<d>e|f"g.pdf')
      expect(safe).not.toMatch(/[:\\<>|"]/)
      expect(safe).toMatch(/\.pdf$/)
    })

    it('falls back to a non-empty default when the input sanitizes to empty', () => {
      const safe = sanitizeFilename('...')
      expect(safe.length).toBeGreaterThan(0)
      const safe2 = sanitizeFilename('')
      expect(safe2.length).toBeGreaterThan(0)
    })

    it('strips leading dots so the file is not hidden on unix', () => {
      const safe = sanitizeFilename('.hidden.pdf')
      expect(safe.startsWith('.')).toBe(false)
      expect(safe).toMatch(/\.pdf$/)
    })
  })

  it('always lands inside the invoices root even with traversal-shaped account_slug', () => {
    // Even an attacker-shaped account_slug (which never happens — slugs are
    // derived in Slice 002 from the email — but defense in depth) must not
    // escape. The function should reject before writing.
    expect(() =>
      writeReceiptFile({
        account_slug: '../../escape',
        internal_date: '0',
        message_id: 'm',
        seq: 0,
        suggested_filename: 'a.pdf',
        bytes: Buffer.from('x'),
      }),
    ).toThrow()
  })

  it('rejects an account_slug containing path separators', () => {
    expect(() =>
      writeReceiptFile({
        account_slug: 'a/b',
        internal_date: '0',
        message_id: 'm',
        seq: 0,
        suggested_filename: 'a.pdf',
        bytes: Buffer.from('x'),
      }),
    ).toThrow()
  })

  it('cleans up the .tmp file after a successful rename (no partial files)', () => {
    writeReceiptFile({
      account_slug: 's',
      internal_date: '0',
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
      bytes: Buffer.from('x'),
    })
    const dir = join(tempRoot, 's', '1970', '01')
    const entries = readdirSync(dir)
    // Exactly one file, and it has no .tmp suffix.
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toMatch(/\.tmp$/)
  })

  it('creates parent directories as needed', () => {
    const r = writeReceiptFile({
      account_slug: 'fresh-slug',
      internal_date: String(Date.UTC(2026, 6, 4)),
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
      bytes: Buffer.from('x'),
    })
    expect(r.file_path).toBe('fresh-slug/2026/07/m_0_a.pdf')
    const absDir = resolve(tempRoot, 'fresh-slug', '2026', '07')
    expect(statSync(absDir).isDirectory()).toBe(true)
  })

  it('overwrites a pre-existing file with the same final path (idempotent re-write)', () => {
    // The orchestrator's hard-dedup check happens *before* the write call, so in
    // practice this case shouldn't fire. Defensive check: even if it does,
    // the rename-over semantics preserve the bytes the caller asked to write.
    const args = {
      account_slug: 's',
      internal_date: '0',
      message_id: 'm',
      seq: 0,
      suggested_filename: 'a.pdf',
    }
    writeReceiptFile({ ...args, bytes: Buffer.from('first') })
    writeReceiptFile({ ...args, bytes: Buffer.from('second') })
    const finalPath = join(tempRoot, 's', '1970', '01', 'm_0_a.pdf')
    expect(readFileSync(finalPath).toString()).toBe('second')
  })
})
