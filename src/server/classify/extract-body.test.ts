import type { gmail_v1 } from 'googleapis'
import { describe, expect, it } from 'vitest'
import { extractBodyText } from './extract-body.js'

type Part = gmail_v1.Schema$MessagePart

function plainPart(text: string): Part {
  return {
    mimeType: 'text/plain',
    body: { data: Buffer.from(text, 'utf8').toString('base64url') },
  }
}

function htmlPart(html: string): Part {
  return {
    mimeType: 'text/html',
    body: { data: Buffer.from(html, 'utf8').toString('base64url') },
  }
}

function inlineImagePart(cid: string): Part {
  return {
    mimeType: 'image/png',
    body: { attachmentId: 'att-1', size: 100 },
    headers: [
      { name: 'Content-Disposition', value: 'inline' },
      { name: 'Content-ID', value: `<${cid}>` },
    ],
  }
}

describe('extractBodyText', () => {
  it('returns plain text from a single text/plain payload', () => {
    const result = extractBodyText(plainPart('Hello world'))
    expect(result.text).toBe('Hello world')
    expect(result.html_was_used).toBe(false)
    expect(result.inline_image_count).toBe(0)
  })

  it('returns text projected from a single text/html payload and flags html_was_used', () => {
    const result = extractBodyText(
      htmlPart('<p>Receipt for <b>$9.99</b></p>'),
    )
    expect(result.text).toContain('Receipt for')
    expect(result.text).toContain('$9.99')
    expect(result.html_was_used).toBe(true)
  })

  it('prefers text/plain over text/html in a multipart/alternative payload', () => {
    const payload: Part = {
      mimeType: 'multipart/alternative',
      parts: [
        plainPart('PLAIN body'),
        htmlPart('<p>HTML body</p>'),
      ],
    }
    const result = extractBodyText(payload)
    expect(result.text).toBe('PLAIN body')
    expect(result.html_was_used).toBe(false)
  })

  it('recurses into nested multipart/mixed and finds text in an inner alternative', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [plainPart('Inner plain'), htmlPart('<p>Inner html</p>')],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'a1', size: 1024 },
        },
      ],
    }
    const result = extractBodyText(payload)
    expect(result.text).toBe('Inner plain')
    expect(result.html_was_used).toBe(false)
  })

  it('counts inline images via Content-Disposition: inline', () => {
    const payload: Part = {
      mimeType: 'multipart/related',
      parts: [
        plainPart('Body text'),
        inlineImagePart('img1'),
        inlineImagePart('img2'),
      ],
    }
    const result = extractBodyText(payload)
    expect(result.text).toBe('Body text')
    expect(result.inline_image_count).toBe(2)
  })

  it('returns an empty body without throwing when no text/plain or text/html part is present', () => {
    const payload: Part = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'a1', size: 1024 },
        },
      ],
    }
    const result = extractBodyText(payload)
    expect(result.text).toBe('')
    expect(result.html_was_used).toBe(false)
  })

  it('falls back to text/html when text/plain is missing', () => {
    const payload: Part = {
      mimeType: 'multipart/alternative',
      parts: [htmlPart('<p>Only HTML</p>')],
    }
    const result = extractBodyText(payload)
    expect(result.text).toContain('Only HTML')
    expect(result.html_was_used).toBe(true)
  })

  it('handles a payload with empty body data without throwing', () => {
    const payload: Part = {
      mimeType: 'text/plain',
      body: {},
    }
    const result = extractBodyText(payload)
    expect(result.text).toBe('')
    expect(result.html_was_used).toBe(false)
  })

  it('collapses whitespace in HTML projection', () => {
    const result = extractBodyText(
      htmlPart('<div>  hello\n\n   world  </div>'),
    )
    expect(result.text).toBe('hello world')
  })
})
