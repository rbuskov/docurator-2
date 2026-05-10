import { describe, expect, it } from 'vitest'
import { buildClassificationMessages } from './prompt.js'

describe('buildClassificationMessages', () => {
  it('returns a system message that describes the JSON schema and the conservative-confidence rule', () => {
    const result = buildClassificationMessages({
      subject: 'Test',
      from: 'a@b.com',
      date: '2026-05-09',
      body_text: 'Body',
      inline_image_count: 0,
      attachments_metadata: [],
      images: [],
    })
    expect(result.system).toMatch(/classification/i)
    expect(result.system).toMatch(/confidence/i)
    expect(result.system).toMatch(/low/i)
    expect(result.system).toMatch(/json/i)
    // The JSON-schema description should mention each top-level field name.
    expect(result.system).toContain('classification')
    expect(result.system).toContain('confidence')
    expect(result.system).toContain('reason')
    expect(result.system).toContain('vendor')
    expect(result.system).toContain('amount')
    expect(result.system).toContain('currency')
    expect(result.system).toContain('transaction_date')
  })

  it('packs subject, from, date, and body text into the user content', () => {
    const result = buildClassificationMessages({
      subject: 'Receipt for $9.99',
      from: 'Stripe <noreply@stripe.com>',
      date: 'Wed, 1 May 2026 10:00:00 +0000',
      body_text: 'Thanks for your order.',
      inline_image_count: 0,
      attachments_metadata: [],
      images: [],
    })
    expect(result.user.content).toContain('Subject: Receipt for $9.99')
    expect(result.user.content).toContain('From: Stripe <noreply@stripe.com>')
    expect(result.user.content).toContain('Date: Wed, 1 May 2026 10:00:00 +0000')
    expect(result.user.content).toContain('Thanks for your order.')
  })

  it('reports inline_image_count in the user content metadata block', () => {
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 3,
      attachments_metadata: [],
      images: [],
    })
    expect(result.user.content).toMatch(/Inline images:\s*3/)
  })

  it('lists each attachment in the metadata block with filename, mime, size, and inclusion status', () => {
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 0,
      attachments_metadata: [
        { filename: 'invoice.pdf', mime_type: 'application/pdf', size: 12345, included: true },
        { filename: 'huge.zip', mime_type: 'application/zip', size: 6_000_000, included: false, skipped_reason: 'mime not supported' },
      ],
      images: [],
    })
    expect(result.user.content).toContain('invoice.pdf')
    expect(result.user.content).toContain('application/pdf')
    expect(result.user.content).toContain('12345')
    expect(result.user.content).toContain('huge.zip')
    expect(result.user.content).toContain('mime not supported')
  })

  it('reports an explicit "Attachments: none" line when the list is empty', () => {
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 0,
      attachments_metadata: [],
      images: [],
    })
    expect(result.user.content).toMatch(/Attachments:\s*none/i)
  })

  it('passes the supplied images array through unchanged', () => {
    const images = [
      Buffer.from('img-1').toString('base64'),
      Buffer.from('img-2').toString('base64'),
    ]
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 0,
      attachments_metadata: [],
      images,
    })
    expect(result.user.images).toEqual(images)
  })

  it('handles an empty body without throwing and still emits a Body: section', () => {
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 0,
      attachments_metadata: [],
      images: [],
    })
    expect(result.user.content).toContain('Body:')
  })

  it('returns user.images as an empty array when no images are supplied', () => {
    const result = buildClassificationMessages({
      subject: 'S',
      from: 'F',
      date: 'D',
      body_text: '',
      inline_image_count: 0,
      attachments_metadata: [],
      images: [],
    })
    expect(result.user.images).toEqual([])
  })
})
