import type { gmail_v1 } from 'googleapis'
import { createGmailClient as defaultCreateGmailClient } from '../gmail/client.js'
import type { GmailClient } from '../gmail/client.js'
import { extractHeader } from '../gmail/headers.js'
import { extractAttachmentMetadata } from './extract-attachments.js'
import type { AttachmentRef } from './extract-attachments.js'
import { extractBodyText } from './extract-body.js'
import { chat as defaultChat, OllamaParseError } from './ollama.js'
import type { ChatArgs, OllamaMessage } from './ollama.js'
import { buildClassificationMessages } from './prompt.js'
import type { AttachmentMetadata } from './prompt.js'
import { renderPdfToImages as defaultRenderPdfToImages } from './render-pdf.js'
import {
  classificationSchema,
  type Artifact,
  type ClassifyResponse,
} from './schema.js'

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_PDF_PAGES = 5

// The orchestrator (Slice 006) needs the raw bytes the classifier saw so it
// can persist them without re-fetching. Keys are stable artifact descriptors:
//   `attachment:<filename>`         — raw attachment bytes
//   `body:rendered_html_source`     — raw HTML when html_was_used (the
//                                     orchestrator runs Playwright on it)
// The field is intentionally non-JSON-serializable (`Map<string, Buffer>`); it
// lives off the type because the only consumer is the in-process orchestrator.
export type ClassifyResult = ClassifyResponse & {
  source_bytes?: Map<string, Buffer>
}

export type ClassifyMessageArgs = {
  account_id: number
  message_id: string
}

export type ClassifyMessageDeps = {
  ollamaUrl: string
  ollamaModel: string
  ollamaTimeoutMs: number
  createGmailClient?: (accountId: number) => GmailClient
  chat?: (args: ChatArgs) => Promise<string>
  renderPdfToImages?: (bytes: Uint8Array, maxPages: number) => Promise<Buffer[]>
}

const RECEIPT_IMAGE_MIME_PREFIX = 'image/'

export async function classifyMessage(
  args: ClassifyMessageArgs,
  deps: ClassifyMessageDeps,
): Promise<ClassifyResult> {
  const _createGmailClient = deps.createGmailClient ?? defaultCreateGmailClient
  const _chat = deps.chat ?? defaultChat
  const _renderPdfToImages = deps.renderPdfToImages ?? defaultRenderPdfToImages

  const client = _createGmailClient(args.account_id)
  const message = await client.getMessage(args.message_id, { format: 'full' })

  const subject = extractHeader(message, 'Subject')
  const from = extractHeader(message, 'From')
  const date = extractHeader(message, 'Date')

  const body = extractBodyText(message.payload)
  const attachments = extractAttachmentMetadata(message.payload)

  const images: string[] = []
  const attachmentsMetadata: AttachmentMetadata[] = []
  const artifacts: Artifact[] = []
  const sourceBytes = new Map<string, Buffer>()

  if (body.text !== '') {
    artifacts.push({
      kind: 'body',
      mime_type: body.html_was_used ? 'text/html' : 'text/plain',
    })
    if (body.html_was_used && body.html_source !== undefined) {
      sourceBytes.set('body:rendered_html_source', Buffer.from(body.html_source, 'utf8'))
    }
  }

  for (const att of attachments.all) {
    const eligible = attachments.receipt_eligible.includes(att)
    if (!eligible) {
      attachmentsMetadata.push({
        filename: att.filename,
        mime_type: att.mime_type,
        size: att.size,
        included: false,
        skipped_reason: 'mime not in receipt-eligible set',
      })
      continue
    }
    if (att.size > MAX_ATTACHMENT_BYTES) {
      attachmentsMetadata.push({
        filename: att.filename,
        mime_type: att.mime_type,
        size: att.size,
        included: false,
        skipped_reason: `over ${MAX_ATTACHMENT_BYTES} bytes`,
      })
      continue
    }

    const fetched = await client.getAttachment(args.message_id, att.attachment_id)
    const lowerMime = att.mime_type.toLowerCase()
    if (lowerMime.startsWith(RECEIPT_IMAGE_MIME_PREFIX)) {
      images.push(fetched.data.toString('base64'))
    } else if (lowerMime === 'application/pdf') {
      const pageBuffers = await _renderPdfToImages(
        new Uint8Array(fetched.data),
        MAX_PDF_PAGES,
      )
      for (const buf of pageBuffers) {
        images.push(buf.toString('base64'))
      }
    }
    attachmentsMetadata.push({
      filename: att.filename,
      mime_type: att.mime_type,
      size: att.size,
      included: true,
    })
    artifacts.push({
      kind: 'attachment',
      mime_type: att.mime_type,
      filename: att.filename,
    })
    sourceBytes.set(`attachment:${att.filename}`, fetched.data)
  }

  const messages = buildClassificationMessages({
    subject,
    from,
    date,
    body_text: body.text,
    inline_image_count: body.inline_image_count,
    attachments_metadata: attachmentsMetadata,
    images,
  })

  const ollamaMessages: OllamaMessage[] = [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user.content, images: messages.user.images },
  ]

  const raw = await _chat({
    baseUrl: deps.ollamaUrl,
    model: deps.ollamaModel,
    messages: ollamaMessages,
    format: 'json',
    timeoutMs: deps.ollamaTimeoutMs,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new OllamaParseError(
      `Ollama response was not valid JSON: ${err instanceof Error ? err.message : 'unknown error'}`,
      raw,
    )
  }
  const validated = classificationSchema.safeParse(parsed)
  if (!validated.success) {
    throw new OllamaParseError(
      `Ollama response did not match the classification schema: ${validated.error.message}`,
      raw,
    )
  }

  return {
    ...validated.data,
    model_used: deps.ollamaModel,
    artifacts,
    source_bytes: sourceBytes,
  }
}

// Re-export types that callers need.
export type { ClassifyResponse } from './schema.js'

// Helpful for tests / future docs — not currently used at runtime.
export type _PrivateAttachmentRef = AttachmentRef
export type _PrivateMessage = gmail_v1.Schema$Message
