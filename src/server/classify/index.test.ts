import type { gmail_v1 } from 'googleapis'
import { describe, expect, it, vi } from 'vitest'
import type { GmailClient } from '../gmail/client.js'
import { classifyMessage } from './index.js'
import type { ChatArgs } from './ollama.js'
import { OllamaParseError, OllamaUnreachableError } from './ollama.js'

type ChatFn = (args: ChatArgs) => Promise<string>

type Part = gmail_v1.Schema$MessagePart
type Message = gmail_v1.Schema$Message

function plainTextMessage(): Message {
  return {
    id: 'msg1',
    threadId: 'thr1',
    internalDate: '1735689600000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Receipt for $9.99' },
        { name: 'From', value: 'Stripe <noreply@stripe.com>' },
        { name: 'Date', value: 'Wed, 1 May 2026 10:00:00 +0000' },
      ],
      body: { data: Buffer.from('Thank you for your purchase.', 'utf8').toString('base64url') },
    },
  }
}

function htmlOnlyMessage(): Message {
  return {
    id: 'msg2',
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'Subject', value: 'Welcome' },
        { name: 'From', value: 'noreply@example.com' },
      ],
      body: { data: Buffer.from('<p>hi</p>', 'utf8').toString('base64url') },
    },
  }
}

function pdfAttachmentMessage(): Message {
  const plain: Part = {
    mimeType: 'text/plain',
    body: { data: Buffer.from('see attached', 'utf8').toString('base64url') },
  }
  const pdf: Part = {
    mimeType: 'application/pdf',
    filename: 'invoice.pdf',
    body: { attachmentId: 'pdf-att', size: 4096 },
  }
  return {
    id: 'msg3',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: 'Invoice attached' },
        { name: 'From', value: 'billing@vendor.com' },
        { name: 'Date', value: '2026-05-01' },
      ],
      parts: [plain, pdf],
    },
  }
}

function imageAttachmentMessage(): Message {
  const png: Part = {
    mimeType: 'image/png',
    filename: 'receipt.png',
    body: { attachmentId: 'png-att', size: 2048 },
  }
  return {
    id: 'msg4',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: 'Photo of receipt' },
        { name: 'From', value: 'me@example.com' },
      ],
      parts: [png],
    },
  }
}

function tooLargeAttachmentMessage(): Message {
  const big: Part = {
    mimeType: 'application/pdf',
    filename: 'huge.pdf',
    body: { attachmentId: 'big-att', size: 10 * 1024 * 1024 },
  }
  const plain: Part = {
    mimeType: 'text/plain',
    body: { data: Buffer.from('see attached', 'utf8').toString('base64url') },
  }
  return {
    id: 'msg5',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: 'Big' },
        { name: 'From', value: 'a@b.com' },
      ],
      parts: [plain, big],
    },
  }
}

function fakeGmailClient(message: Message, attachmentBytes?: Buffer): GmailClient {
  return {
    listMessages: async () => ({ messages: [] }),
    getMessage: async () => message,
    getAttachment: async () => ({
      data: attachmentBytes ?? Buffer.alloc(0),
      size: attachmentBytes?.length ?? 0,
    }),
    historyList: async () => ({ history: [] }),
    getProfile: async () => ({
      email_address: null,
      history_id: null,
      messages_total: null,
      threads_total: null,
    }),
  }
}

function validClassificationJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    classification: 'receipt',
    confidence: 'high',
    reason: 'Stripe-shaped',
    ...extra,
  })
}

describe('classifyMessage', () => {
  it('returns a verdict for a text/plain-only message with model_used and one body artifact', async () => {
    const chat = vi.fn(async () => validClassificationJson())
    const result = await classifyMessage(
      { account_id: 1, message_id: 'msg1' },
      {
        ollamaUrl: 'http://x',
        ollamaModel: 'qwen2.5vl:7b',
        ollamaTimeoutMs: 5000,
        createGmailClient: () => fakeGmailClient(plainTextMessage()),
        chat,
      },
    )
    expect(result.classification).toBe('receipt')
    expect(result.confidence).toBe('high')
    expect(result.reason).toBe('Stripe-shaped')
    expect(result.model_used).toBe('qwen2.5vl:7b')
    expect(result.artifacts).toEqual([{ kind: 'body', mime_type: 'text/plain' }])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('reports html_was_used as a text/html body artifact', async () => {
    const chat = vi.fn(async () => validClassificationJson({ classification: 'other' }))
    const result = await classifyMessage(
      { account_id: 1, message_id: 'msg2' },
      {
        ollamaUrl: 'http://x',
        ollamaModel: 'm',
        ollamaTimeoutMs: 5000,
        createGmailClient: () => fakeGmailClient(htmlOnlyMessage()),
        chat,
      },
    )
    expect(result.artifacts).toEqual([{ kind: 'body', mime_type: 'text/html' }])
  })

  it('fetches a PDF attachment, renders it, and lists it in artifacts', async () => {
    const renderPdfToImages = vi.fn(async () => [Buffer.from('png-page-1'), Buffer.from('png-page-2')])
    const chat = vi.fn<ChatFn>(async () => validClassificationJson())
    const pdfBytes = Buffer.from('%PDF-1.4\n...')
    const result = await classifyMessage(
      { account_id: 1, message_id: 'msg3' },
      {
        ollamaUrl: 'http://x',
        ollamaModel: 'm',
        ollamaTimeoutMs: 5000,
        createGmailClient: () => fakeGmailClient(pdfAttachmentMessage(), pdfBytes),
        chat,
        renderPdfToImages,
      },
    )
    expect(renderPdfToImages).toHaveBeenCalledTimes(1)
    expect(result.artifacts).toEqual([
      { kind: 'body', mime_type: 'text/plain' },
      { kind: 'attachment', mime_type: 'application/pdf', filename: 'invoice.pdf' },
    ])
    // The chat call should have received both PDF page images.
    const chatArgs = chat.mock.calls[0]?.[0]
    const userMsg = chatArgs?.messages?.[1]
    if (userMsg?.role !== 'user') throw new Error('expected user message')
    expect(userMsg.images).toHaveLength(2)
  })

  it('passes image attachments through as base64-encoded images without rendering', async () => {
    const renderPdfToImages = vi.fn(async () => [])
    const chat = vi.fn<ChatFn>(async () => validClassificationJson())
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = await classifyMessage(
      { account_id: 1, message_id: 'msg4' },
      {
        ollamaUrl: 'http://x',
        ollamaModel: 'm',
        ollamaTimeoutMs: 5000,
        createGmailClient: () => fakeGmailClient(imageAttachmentMessage(), pngBytes),
        chat,
        renderPdfToImages,
      },
    )
    expect(renderPdfToImages).not.toHaveBeenCalled()
    expect(result.artifacts).toEqual([
      { kind: 'attachment', mime_type: 'image/png', filename: 'receipt.png' },
    ])
    const chatArgs = chat.mock.calls[0]?.[0]
    const userMsg = chatArgs?.messages?.[1]
    if (userMsg?.role !== 'user') throw new Error('expected user message')
    expect(userMsg.images).toEqual([pngBytes.toString('base64')])
  })

  it('skips an attachment over MAX_ATTACHMENT_BYTES (5 MB) without fetching it', async () => {
    const getAttachment = vi.fn(async () => ({ data: Buffer.alloc(0), size: 0 }))
    const chat = vi.fn(async () => validClassificationJson({ classification: 'other' }))
    const client: GmailClient = {
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => tooLargeAttachmentMessage(),
      getAttachment,
      historyList: async () => ({ history: [] }),
      getProfile: async () => ({
        email_address: null,
        history_id: null,
        messages_total: null,
        threads_total: null,
      }),
    }
    const result = await classifyMessage(
      { account_id: 1, message_id: 'msg5' },
      {
        ollamaUrl: 'http://x',
        ollamaModel: 'm',
        ollamaTimeoutMs: 5000,
        createGmailClient: () => client,
        chat,
      },
    )
    expect(getAttachment).not.toHaveBeenCalled()
    // Body still considered; the too-large PDF is not in artifacts.
    expect(result.artifacts).toEqual([{ kind: 'body', mime_type: 'text/plain' }])
  })

  it('propagates an OllamaUnreachableError from chat', async () => {
    const chat = vi.fn(async () => {
      throw new OllamaUnreachableError('down')
    })
    await expect(
      classifyMessage(
        { account_id: 1, message_id: 'msg1' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(plainTextMessage()),
          chat,
        },
      ),
    ).rejects.toBeInstanceOf(OllamaUnreachableError)
  })

  it('throws OllamaParseError when chat returns malformed JSON', async () => {
    const chat = vi.fn(async () => 'this is not JSON {')
    try {
      await classifyMessage(
        { account_id: 1, message_id: 'msg1' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(plainTextMessage()),
          chat,
        },
      )
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaParseError)
      expect((err as OllamaParseError).rawResponse).toBe('this is not JSON {')
    }
  })

  it('throws OllamaParseError when chat returns JSON that fails the Zod schema', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({ classification: 'spam', confidence: 'high', reason: 'r' }),
    )
    try {
      await classifyMessage(
        { account_id: 1, message_id: 'msg1' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(plainTextMessage()),
          chat,
        },
      )
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaParseError)
      expect((err as OllamaParseError).rawResponse).toContain('"classification":"spam"')
    }
  })

  describe('source_bytes', () => {
    it('returns raw attachment bytes keyed by attachment:<filename> for an included PDF', async () => {
      const renderPdfToImages = vi.fn(async () => [Buffer.from('img')])
      const chat = vi.fn<ChatFn>(async () => validClassificationJson())
      const pdfBytes = Buffer.from('%PDF-1.4\nfake-pdf-bytes')
      const result = await classifyMessage(
        { account_id: 1, message_id: 'msg3' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(pdfAttachmentMessage(), pdfBytes),
          chat,
          renderPdfToImages,
        },
      )
      expect(result.source_bytes).toBeInstanceOf(Map)
      const entry = result.source_bytes?.get('attachment:invoice.pdf')
      expect(entry).toBeInstanceOf(Buffer)
      expect(entry?.equals(pdfBytes)).toBe(true)
    })

    it('returns raw image bytes keyed by attachment:<filename> for an image attachment', async () => {
      const chat = vi.fn<ChatFn>(async () => validClassificationJson())
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const result = await classifyMessage(
        { account_id: 1, message_id: 'msg4' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(imageAttachmentMessage(), pngBytes),
          chat,
        },
      )
      const entry = result.source_bytes?.get('attachment:receipt.png')
      expect(entry?.equals(pngBytes)).toBe(true)
    })

    it("returns body HTML keyed by 'body:rendered_html_source' when html_was_used", async () => {
      const chat = vi.fn(async () => validClassificationJson({ classification: 'other' }))
      const result = await classifyMessage(
        { account_id: 1, message_id: 'msg2' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(htmlOnlyMessage()),
          chat,
        },
      )
      const html = result.source_bytes?.get('body:rendered_html_source')
      expect(html).toBeInstanceOf(Buffer)
      expect(html?.toString('utf8')).toBe('<p>hi</p>')
    })

    it('does NOT include body:rendered_html_source when the body was plain text', async () => {
      const chat = vi.fn(async () => validClassificationJson())
      const result = await classifyMessage(
        { account_id: 1, message_id: 'msg1' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => fakeGmailClient(plainTextMessage()),
          chat,
        },
      )
      expect(result.source_bytes?.has('body:rendered_html_source')).toBe(false)
    })

    it('does NOT include skipped (over-size) attachments in source_bytes', async () => {
      const chat = vi.fn(async () => validClassificationJson({ classification: 'other' }))
      const client: GmailClient = {
        listMessages: async () => ({ messages: [] }),
        getMessage: async () => tooLargeAttachmentMessage(),
        getAttachment: async () => ({ data: Buffer.alloc(0), size: 0 }),
        historyList: async () => ({ history: [] }),
        getProfile: async () => ({
          email_address: null,
          history_id: null,
          messages_total: null,
          threads_total: null,
        }),
      }
      const result = await classifyMessage(
        { account_id: 1, message_id: 'msg5' },
        {
          ollamaUrl: 'http://x',
          ollamaModel: 'm',
          ollamaTimeoutMs: 5000,
          createGmailClient: () => client,
          chat,
        },
      )
      expect(result.source_bytes?.has('attachment:huge.pdf')).toBe(false)
    })
  })
})
