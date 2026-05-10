import type { gmail_v1 } from 'googleapis'
import { describe, expect, it } from 'vitest'
import { extractAttachmentMetadata } from './extract-attachments.js'

type Part = gmail_v1.Schema$MessagePart

function attachmentPart(
  filename: string,
  mimeType: string,
  attachmentId: string,
  size: number,
): Part {
  return {
    mimeType,
    filename,
    body: { attachmentId, size },
  }
}

function inlineImagePart(cid: string): Part {
  return {
    mimeType: 'image/png',
    filename: 'inline.png',
    body: { attachmentId: 'att-inline', size: 100 },
    headers: [
      { name: 'Content-Disposition', value: 'inline' },
      { name: 'Content-ID', value: `<${cid}>` },
    ],
  }
}

describe('extractAttachmentMetadata', () => {
  it('returns empty arrays for an undefined payload', () => {
    const result = extractAttachmentMetadata(undefined)
    expect(result.all).toEqual([])
    expect(result.receipt_eligible).toEqual([])
  })

  it('returns empty arrays for a single text/plain payload', () => {
    const result = extractAttachmentMetadata({
      mimeType: 'text/plain',
      body: { data: 'aGVsbG8' },
    })
    expect(result.all).toEqual([])
    expect(result.receipt_eligible).toEqual([])
  })

  it('collects attachments from a multipart/mixed payload', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: 'aGVsbG8' },
        },
        attachmentPart('invoice.pdf', 'application/pdf', 'att-pdf', 4096),
        attachmentPart('logo.png', 'image/png', 'att-png', 2048),
        attachmentPart('archive.zip', 'application/zip', 'att-zip', 1024),
      ],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all).toHaveLength(3)
    expect(result.receipt_eligible).toHaveLength(2)
    const eligibleFilenames = result.receipt_eligible.map((a) => a.filename)
    expect(eligibleFilenames).toEqual(['invoice.pdf', 'logo.png'])
  })

  it('exposes filename, mime_type, attachment_id, and size for each attachment', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [attachmentPart('receipt.pdf', 'application/pdf', 'att-1', 12345)],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all[0]).toEqual({
      filename: 'receipt.pdf',
      mime_type: 'application/pdf',
      attachment_id: 'att-1',
      size: 12345,
    })
  })

  it('skips inline parts even when they have a filename', () => {
    const payload: Part = {
      mimeType: 'multipart/related',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
        inlineImagePart('img1'),
      ],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all).toEqual([])
    expect(result.receipt_eligible).toEqual([])
  })

  it('skips parts without an attachmentId or filename', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGVsbG8' } }, // no filename
        {
          mimeType: 'application/pdf',
          filename: '',
          body: { attachmentId: 'a', size: 1 },
        }, // empty filename
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { size: 1 },
        }, // no attachmentId
      ],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all).toEqual([])
  })

  it('treats jpeg, gif, webp as receipt-eligible', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        attachmentPart('a.jpg', 'image/jpeg', 'a1', 1),
        attachmentPart('b.gif', 'image/gif', 'a2', 1),
        attachmentPart('c.webp', 'image/webp', 'a3', 1),
        attachmentPart('d.tiff', 'image/tiff', 'a4', 1),
      ],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all).toHaveLength(4)
    expect(result.receipt_eligible.map((a) => a.filename)).toEqual([
      'a.jpg',
      'b.gif',
      'c.webp',
    ])
  })

  it('recurses into nested multipart containers', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
            { mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } },
          ],
        },
        attachmentPart('outer.pdf', 'application/pdf', 'a1', 100),
        {
          mimeType: 'multipart/mixed',
          parts: [attachmentPart('nested.png', 'image/png', 'a2', 200)],
        },
      ],
    }
    const result = extractAttachmentMetadata(payload)
    expect(result.all.map((a) => a.filename)).toEqual(['outer.pdf', 'nested.png'])
  })

  it('lowercases the mime_type comparison so IMAGE/PNG is still eligible', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [attachmentPart('logo.PNG', 'IMAGE/PNG', 'a1', 100)],
    }
    const result = extractAttachmentMetadata(payload)
    // mime_type stored as-received; eligibility check is case-insensitive.
    expect(result.all[0]?.mime_type).toBe('IMAGE/PNG')
    expect(result.receipt_eligible).toHaveLength(1)
  })
})
