import { describe, expect, it } from 'vitest'
import { isInvalidGrantError } from './invalid-grant.js'

describe('isInvalidGrantError', () => {
  it('returns true for an Error whose message includes "invalid_grant"', () => {
    expect(isInvalidGrantError(new Error('invalid_grant: bad token'))).toBe(true)
  })

  it('returns true for an object with response.data.error === "invalid_grant"', () => {
    expect(
      isInvalidGrantError({ response: { data: { error: 'invalid_grant' } } }),
    ).toBe(true)
  })

  it('returns false for a generic Error', () => {
    expect(isInvalidGrantError(new Error('something else'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isInvalidGrantError(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isInvalidGrantError(undefined)).toBe(false)
  })

  it('returns false for a plain string', () => {
    expect(isInvalidGrantError('invalid_grant')).toBe(false)
  })

  it('returns false for a number', () => {
    expect(isInvalidGrantError(42)).toBe(false)
  })

  it('returns false for an object whose response.data.error is something else', () => {
    expect(
      isInvalidGrantError({ response: { data: { error: 'unauthorized' } } }),
    ).toBe(false)
  })

  it('returns false for an object missing response.data', () => {
    expect(isInvalidGrantError({ response: {} })).toBe(false)
  })
})
