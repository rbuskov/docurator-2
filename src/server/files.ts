import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { config } from './config.js'

const MAX_BASENAME_LEN = 100
const FALLBACK_BASENAME = 'unnamed'

// Windows reserved device names. We're not on Windows, but the export bundle
// (Slice 011) lands on accountants' machines that may be — escape proactively.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

let invoicesRootOverride: string | undefined

export function setInvoicesRootForTest(p: string): void {
  invoicesRootOverride = p
}

export function resetInvoicesRootForTest(): void {
  invoicesRootOverride = undefined
}

function invoicesRoot(): string {
  return resolve(invoicesRootOverride ?? config.invoicesDir)
}

// Public getter shared by readers (e.g. `api/documents.ts`) so they pick up
// the same test-override path as `writeReceiptFile`.
export function getInvoicesRoot(): string {
  return invoicesRoot()
}

export function sanitizeFilename(input: string): string {
  // Only the basename — path separators on either platform are stripped.
  const lastSlash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  let s = lastSlash >= 0 ? input.slice(lastSlash + 1) : input

  // Replace path-hostile + control characters with `_`.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[/\\:<>|"\x00-\x1f]/g, '_')

  // Strip leading dots (otherwise hidden on unix; also defangs `..`).
  s = s.replace(/^\.+/, '')

  // Truncate while preserving extension.
  if (s.length > MAX_BASENAME_LEN) {
    const ext = extname(s).slice(0, 16) // guard against absurd extensions
    const stem = s.slice(0, MAX_BASENAME_LEN - ext.length)
    s = stem + ext
  }

  if (s.length === 0) {
    s = FALLBACK_BASENAME
  }

  // Escape Windows reserved device names by prefixing with `_`.
  if (WINDOWS_RESERVED.test(s)) {
    s = `_${s}`
  }

  return s
}

export type WriteReceiptFileArgs = {
  account_slug: string
  internal_date: string
  message_id: string
  seq: number
  suggested_filename: string
  bytes: Buffer
}

export type WriteReceiptFileResult = {
  file_path: string
  content_hash: string
  size: number
}

export function writeReceiptFile(args: WriteReceiptFileArgs): WriteReceiptFileResult {
  const root = invoicesRoot()

  // Reject path-shaped account_slug inputs early — slugs are produced by
  // Slice 002's slugify() and never contain separators, but defense in depth.
  if (
    args.account_slug.includes('/') ||
    args.account_slug.includes('\\') ||
    args.account_slug.includes('..') ||
    args.account_slug.length === 0
  ) {
    throw new Error(`Invalid account_slug: ${args.account_slug}`)
  }

  const ms = Number.parseInt(args.internal_date, 10)
  const date = Number.isFinite(ms) ? new Date(ms) : new Date(0)
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')

  const safeBasename = sanitizeFilename(args.suggested_filename)
  // Sanitize message_id and seq for path safety too — Gmail message ids are
  // base64-url-safe in practice, but treat as untrusted for the same reason.
  const safeMessageId = args.message_id.replace(/[^A-Za-z0-9_-]/g, '_')
  const finalRelative = `${args.account_slug}/${yyyy}/${mm}/${safeMessageId}_${args.seq}_${safeBasename}`
  const finalAbsolute = resolve(root, finalRelative)

  // Path-traversal guard: the resolved path must remain inside `root`.
  // `resolve` collapses `..` segments, so if the result doesn't start with
  // `root + sep`, the input was attempting to escape.
  if (finalAbsolute !== root && !finalAbsolute.startsWith(root + sep)) {
    throw new Error('Refusing to write outside the invoices root')
  }

  const parentDir = resolve(finalAbsolute, '..')
  mkdirSync(parentDir, { recursive: true })

  // Atomic write: write to <final>.tmp then rename. Mid-write process death
  // leaves no partial final file; the caller's idempotency anchor is the
  // `documents` row, which is inserted in the same transaction as the
  // orchestrator commits.
  const tmpAbsolute = `${finalAbsolute}.tmp`
  try {
    writeFileSync(tmpAbsolute, args.bytes)
    renameSync(tmpAbsolute, finalAbsolute)
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename failed.
    try {
      rmSync(tmpAbsolute, { force: true })
    } catch {
      /* ignore cleanup failures */
    }
    throw err
  }

  const content_hash = createHash('sha256').update(args.bytes).digest('hex')

  return {
    file_path: finalRelative,
    content_hash,
    size: args.bytes.length,
  }
}
