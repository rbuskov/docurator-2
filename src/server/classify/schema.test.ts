import { describe, expect, it } from 'vitest'
import {
  artifactSchema,
  classificationSchema,
  classifyResponseSchema,
} from './schema.js'

describe('classificationSchema', () => {
  it('accepts a minimal valid object (no optional fields)', () => {
    const parsed = classificationSchema.parse({
      classification: 'receipt',
      confidence: 'high',
      reason: 'Stripe receipt with line items',
    })
    expect(parsed.classification).toBe('receipt')
    expect(parsed.confidence).toBe('high')
    expect(parsed.vendor).toBeUndefined()
  })

  it('accepts a fully populated valid object', () => {
    const parsed = classificationSchema.parse({
      classification: 'invoice',
      confidence: 'medium',
      reason: 'AWS monthly invoice',
      vendor: 'Amazon Web Services',
      amount: 42.5,
      currency: 'USD',
      transaction_date: '2026-04-30',
    })
    expect(parsed.amount).toBe(42.5)
    expect(parsed.transaction_date).toBe('2026-04-30')
  })

  it('rejects a classification value outside the enum', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'spam',
        confidence: 'high',
        reason: 'r',
      }),
    ).toThrow()
  })

  it('rejects a confidence value outside the enum', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'receipt',
        confidence: 'ultra',
        reason: 'r',
      }),
    ).toThrow()
  })

  it('rejects an empty reason', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'receipt',
        confidence: 'high',
        reason: '',
      }),
    ).toThrow()
  })

  it('accepts a transaction_date that matches the regex but has impossible month/day', () => {
    // The schema only enforces YYYY-MM-DD shape, not calendar validity.
    const parsed = classificationSchema.parse({
      classification: 'receipt',
      confidence: 'low',
      reason: 'r',
      transaction_date: '2026-13-99',
    })
    expect(parsed.transaction_date).toBe('2026-13-99')
  })

  it('rejects a transaction_date with non-ISO shape', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'receipt',
        confidence: 'low',
        reason: 'r',
        transaction_date: 'tomorrow',
      }),
    ).toThrow()
  })

  it('rejects a negative amount', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'receipt',
        confidence: 'low',
        reason: 'r',
        amount: -1,
      }),
    ).toThrow()
  })

  it('accepts amount: 0', () => {
    const parsed = classificationSchema.parse({
      classification: 'receipt',
      confidence: 'low',
      reason: 'r',
      amount: 0,
    })
    expect(parsed.amount).toBe(0)
  })

  it('rejects a currency that is not exactly 3 letters', () => {
    expect(() =>
      classificationSchema.parse({
        classification: 'receipt',
        confidence: 'low',
        reason: 'r',
        currency: 'EURO',
      }),
    ).toThrow()
  })

  it('accepts a 3-letter currency', () => {
    const parsed = classificationSchema.parse({
      classification: 'receipt',
      confidence: 'low',
      reason: 'r',
      currency: 'EUR',
    })
    expect(parsed.currency).toBe('EUR')
  })
})

describe('artifactSchema', () => {
  it("accepts kind: 'body' with a mime_type and no filename", () => {
    const parsed = artifactSchema.parse({
      kind: 'body',
      mime_type: 'text/plain',
    })
    expect(parsed.kind).toBe('body')
    expect(parsed.filename).toBeUndefined()
  })

  it("accepts kind: 'attachment' with filename and mime_type", () => {
    const parsed = artifactSchema.parse({
      kind: 'attachment',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
    })
    expect(parsed.filename).toBe('invoice.pdf')
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      artifactSchema.parse({ kind: 'unknown', mime_type: 'text/plain' }),
    ).toThrow()
  })
})

describe('classifyResponseSchema', () => {
  it('accepts a full response with model_used and one artifact', () => {
    const parsed = classifyResponseSchema.parse({
      classification: 'receipt',
      confidence: 'high',
      reason: 'r',
      vendor: 'Stripe',
      amount: 9.99,
      currency: 'USD',
      transaction_date: '2026-05-01',
      model_used: 'qwen2.5vl:7b',
      artifacts: [{ kind: 'body', mime_type: 'text/plain' }],
    })
    expect(parsed.model_used).toBe('qwen2.5vl:7b')
    expect(parsed.artifacts).toHaveLength(1)
  })

  it('accepts an empty artifacts array', () => {
    const parsed = classifyResponseSchema.parse({
      classification: 'other',
      confidence: 'low',
      reason: 'r',
      model_used: 'qwen2.5vl:7b',
      artifacts: [],
    })
    expect(parsed.artifacts).toEqual([])
  })

  it('rejects when model_used is missing', () => {
    expect(() =>
      classifyResponseSchema.parse({
        classification: 'receipt',
        confidence: 'high',
        reason: 'r',
        artifacts: [],
      }),
    ).toThrow()
  })
})
