import type { gmail_v1 } from 'googleapis'

export type AttachmentRef = {
  filename: string
  mime_type: string
  attachment_id: string
  size: number
}

export type ExtractedAttachments = {
  all: AttachmentRef[]
  receipt_eligible: AttachmentRef[]
}

const RECEIPT_ELIGIBLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
])

type Part = gmail_v1.Schema$MessagePart

// Walks the MIME tree once and returns every attachment (filename + body
// attachment_id present, not inline). Companion to extractBodyText: that
// function handles text/html/inline parts; this one handles the rest.
export function extractAttachmentMetadata(
  payload: Part | undefined,
): ExtractedAttachments {
  const all: AttachmentRef[] = []
  if (payload !== undefined) walk(payload, all)
  const receipt_eligible = all.filter((a) =>
    RECEIPT_ELIGIBLE_MIME_TYPES.has(a.mime_type.toLowerCase()),
  )
  return { all, receipt_eligible }
}

function walk(part: Part, out: AttachmentRef[]): void {
  const mime = (part.mimeType ?? '').toLowerCase()

  if (mime.startsWith('multipart/')) {
    for (const child of part.parts ?? []) {
      walk(child, out)
    }
    return
  }

  if (isInline(part)) return

  const filename = part.filename
  const attachmentId = part.body?.attachmentId
  if (typeof filename !== 'string' || filename === '') return
  if (typeof attachmentId !== 'string' || attachmentId === '') return

  out.push({
    filename,
    mime_type: typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream',
    attachment_id: attachmentId,
    size: typeof part.body?.size === 'number' ? part.body.size : 0,
  })
}

function isInline(part: Part): boolean {
  for (const h of part.headers ?? []) {
    if (typeof h.name !== 'string') continue
    if (h.name.toLowerCase() !== 'content-disposition') continue
    if (typeof h.value !== 'string') continue
    if (h.value.toLowerCase().includes('inline')) return true
  }
  return false
}
