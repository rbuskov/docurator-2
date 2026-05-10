import type { gmail_v1 } from 'googleapis'
import { describe, expect, it } from 'vitest'
import { extractHeader, parseFromAddressDomain } from './headers.js'

function messageWithHeaders(
  headers: Array<{ name: string; value: string }>,
): gmail_v1.Schema$Message {
  return { payload: { headers } } as gmail_v1.Schema$Message
}

describe('extractHeader', () => {
  it('returns the value of a present header', () => {
    const m = messageWithHeaders([{ name: 'Subject', value: 'Hello' }])
    expect(extractHeader(m, 'Subject')).toBe('Hello')
  })

  it('returns an empty string when the header is missing', () => {
    const m = messageWithHeaders([{ name: 'From', value: 'a@x.com' }])
    expect(extractHeader(m, 'Subject')).toBe('')
  })

  it('matches header names case-insensitively', () => {
    const m = messageWithHeaders([{ name: 'subject', value: 'lower' }])
    expect(extractHeader(m, 'Subject')).toBe('lower')
  })

  it('returns an empty string when payload.headers is undefined', () => {
    const m = { payload: {} } as gmail_v1.Schema$Message
    expect(extractHeader(m, 'Subject')).toBe('')
  })

  it('returns an empty string when payload itself is undefined', () => {
    const m = {} as gmail_v1.Schema$Message
    expect(extractHeader(m, 'Subject')).toBe('')
  })
})

describe('parseFromAddressDomain', () => {
  it('extracts the domain from a "Name <addr>" form', () => {
    expect(parseFromAddressDomain('Sender Name <sender@example.com>')).toBe('example.com')
  })

  it('extracts the domain from a bare address', () => {
    expect(parseFromAddressDomain('sender@example.com')).toBe('example.com')
  })

  it('extracts the domain from a "<addr>" form (no display name)', () => {
    expect(parseFromAddressDomain('<sender@example.com>')).toBe('example.com')
  })

  it('lowercases the returned domain', () => {
    expect(parseFromAddressDomain('Sender <SENDER@EXAMPLE.COM>')).toBe('example.com')
  })

  it('preserves subdomains', () => {
    expect(parseFromAddressDomain('Sender Name <sender@subdomain.example.com>')).toBe(
      'subdomain.example.com',
    )
  })

  it('returns null for an empty value', () => {
    expect(parseFromAddressDomain('')).toBeNull()
  })

  it('returns null for whitespace-only value', () => {
    expect(parseFromAddressDomain('   ')).toBeNull()
  })

  it('returns null when the value contains no @ sign', () => {
    expect(parseFromAddressDomain('no-at-sign')).toBeNull()
  })

  it('returns null on RFC-5322 group syntax', () => {
    expect(parseFromAddressDomain('Group: a@x.com, b@y.com;')).toBeNull()
  })

  it('handles a quoted display name containing a comma', () => {
    expect(
      parseFromAddressDomain('"Quoted, name with comma" <sender@example.com>'),
    ).toBe('example.com')
  })

  it('trims surrounding whitespace inside the angle brackets', () => {
    expect(parseFromAddressDomain('Name <  sender@example.com  >')).toBe('example.com')
  })
})
