// Builds the system + user messages we hand to Ollama's chat API. The system
// prompt is a TypeScript constant in this module; tuning it is a code change
// (see ADR-005 — "Classification prompt as a TypeScript constant").
//
// The user message packs everything the model needs in plain text — subject,
// sender, date, inline-image count, attachments list, and the body — followed
// by an optional `images` array of base64-encoded PNG / image bytes. Ollama's
// wire format puts `images` as a sibling field of `content` on the message,
// not as multimodal content blocks.

export type AttachmentMetadata = {
  filename: string
  mime_type: string
  size: number
  included: boolean
  skipped_reason?: string
}

export type BuildClassificationInput = {
  subject: string
  from: string
  date: string
  body_text: string
  inline_image_count: number
  attachments_metadata: AttachmentMetadata[]
  images: string[] // base64-encoded image bytes, no data URL prefix
}

export type ClassificationMessages = {
  system: string
  user: {
    content: string
    images: string[]
  }
}

const SYSTEM_PROMPT = `You are a classifier for business receipts and invoices arriving by email.

Your job: read the email's metadata, body, and any attached images, then return a single JSON object that classifies the message.

The JSON object must have exactly these fields:
- "classification": one of "invoice", "receipt", or "other".
- "confidence": one of "high", "medium", or "low".
- "reason": a short string (1-2 sentences) explaining why you chose that classification.
- "vendor": optional string. The merchant or company billing the user. Omit if unclear.
- "amount": optional non-negative number. The total charged. Omit if unclear.
- "currency": optional 3-letter ISO 4217 code (e.g. "USD", "EUR"). Omit if unclear.
- "transaction_date": optional string in YYYY-MM-DD format — the date the receipt is for. Omit if unclear.

Rules:
- Return ONLY the JSON object — no markdown fences, no commentary, no preamble.
- If you are unsure whether the message is a receipt or invoice, return "confidence": "low" and "classification": "other". Conservative confidence is preferred over false positives.
- "receipt" means a confirmation of money already paid. "invoice" means a request for payment not yet settled. "other" covers everything else (newsletters, personal mail, meeting notices, shipping notifications without a price, account alerts, etc.).
- Do not invent fields the user did not ask for. Do not add nested objects.`

export function buildClassificationMessages(
  input: BuildClassificationInput,
): ClassificationMessages {
  const attachmentsBlock = formatAttachments(input.attachments_metadata)
  const userContent = [
    `Subject: ${input.subject}`,
    `From: ${input.from}`,
    `Date: ${input.date}`,
    `Inline images: ${input.inline_image_count}`,
    `Attachments: ${attachmentsBlock}`,
    '',
    'Body:',
    input.body_text,
  ].join('\n')
  return {
    system: SYSTEM_PROMPT,
    user: {
      content: userContent,
      images: input.images,
    },
  }
}

function formatAttachments(items: AttachmentMetadata[]): string {
  if (items.length === 0) return 'none'
  // One-line-per-attachment list; the model reads it as a bulleted block.
  const lines = items.map((a) => {
    const status = a.included
      ? 'included as image input'
      : `skipped (${a.skipped_reason ?? 'unknown reason'})`
    return `  - ${a.filename} (${a.mime_type}, ${a.size} bytes) — ${status}`
  })
  return `\n${lines.join('\n')}`
}
