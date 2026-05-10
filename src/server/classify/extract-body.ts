import type { gmail_v1 } from 'googleapis'
import { parse as parseHtml } from 'node-html-parser'

export type ExtractedBody = {
  text: string
  html_was_used: boolean
  inline_image_count: number
}

type Part = gmail_v1.Schema$MessagePart

// Walks the MIME tree once and returns the best plain-text projection of the
// body, plus a count of inline images (parts with Content-Disposition: inline)
// for the prompt's metadata block. Pure — no I/O, no Gmail client.
export function extractBodyText(payload: Part | undefined): ExtractedBody {
  if (payload === undefined) {
    return { text: '', html_was_used: false, inline_image_count: 0 }
  }

  const collected = { plain: undefined as string | undefined, html: undefined as string | undefined, inlineCount: 0 }
  walk(payload, collected)

  if (collected.plain !== undefined) {
    return {
      text: collected.plain,
      html_was_used: false,
      inline_image_count: collected.inlineCount,
    }
  }
  if (collected.html !== undefined) {
    return {
      text: htmlToText(collected.html),
      html_was_used: true,
      inline_image_count: collected.inlineCount,
    }
  }
  return { text: '', html_was_used: false, inline_image_count: collected.inlineCount }
}

function walk(
  part: Part,
  out: { plain: string | undefined; html: string | undefined; inlineCount: number },
): void {
  const mime = (part.mimeType ?? '').toLowerCase()

  if (isInlineAttachmentPart(part)) {
    out.inlineCount += 1
    return
  }

  if (mime.startsWith('multipart/')) {
    for (const child of part.parts ?? []) {
      walk(child, out)
    }
    return
  }

  // Skip non-inline attachments — they have a filename and are not the body.
  if (typeof part.filename === 'string' && part.filename !== '') {
    return
  }

  if (mime === 'text/plain' && out.plain === undefined) {
    const data = part.body?.data
    if (typeof data === 'string') {
      out.plain = Buffer.from(data, 'base64url').toString('utf8')
    } else {
      // Empty plain part — record an empty string so we don't fall back to HTML
      // for what is conceptually a "deliberate empty plain body".
      out.plain = ''
    }
    return
  }

  if (mime === 'text/html' && out.html === undefined) {
    const data = part.body?.data
    if (typeof data === 'string') {
      out.html = Buffer.from(data, 'base64url').toString('utf8')
    } else {
      out.html = ''
    }
  }
}

function isInlineAttachmentPart(part: Part): boolean {
  const headers = part.headers ?? []
  for (const h of headers) {
    if (typeof h.name !== 'string') continue
    if (h.name.toLowerCase() !== 'content-disposition') continue
    if (typeof h.value !== 'string') continue
    if (h.value.toLowerCase().includes('inline')) return true
  }
  return false
}

function htmlToText(html: string): string {
  const root = parseHtml(html)
  return root.text.replace(/\s+/g, ' ').trim()
}
