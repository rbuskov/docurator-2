import { describe, expect, it } from 'vitest'
import { slugify } from './slug.js'

describe('slugify', () => {
  it('produces the canonical example slug for alice@example.com', () => {
    expect(slugify('alice@example.com')).toBe('alice-at-example-com')
  })

  it('lowercases mixed-case email parts', () => {
    expect(slugify('Alice@Example.COM')).toBe('alice-at-example-com')
  })

  it('reduces plus-aliases to a single hyphen', () => {
    expect(slugify('bob+work@example.com')).toBe('bob-work-at-example-com')
  })

  it('replaces underscores with hyphens', () => {
    expect(slugify('a_b@x.com')).toBe('a-b-at-x-com')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--foo--@example.com')).toBe('foo-at-example-com')
  })

  it('collapses runs of hyphens into a single hyphen', () => {
    expect(slugify('foo..bar@example.com')).toBe('foo-bar-at-example-com')
  })

  it('preserves digits', () => {
    expect(slugify('user42@host9.io')).toBe('user42-at-host9-io')
  })

  it('strips characters outside [a-z0-9-]', () => {
    expect(slugify('weird!name#@host.io')).toBe('weird-name-at-host-io')
  })
})
