import { describe, expect, it } from 'vitest'
import { chooseDiscovery } from './discovery.js'

describe('chooseDiscovery', () => {
  const now = new Date('2026-05-09T12:00:00Z')

  it("returns range with q='after:YYYY/MM/DD' when `since` is set", () => {
    const result = chooseDiscovery({
      syncState: undefined,
      since: '2026-04-01',
      fallbackDays: 30,
      now,
    })
    expect(result).toEqual({ kind: 'range', q: 'after:2026/04/01' })
  })

  it('returns history when last_history_id is set and `since` is not', () => {
    const result = chooseDiscovery({
      syncState: {
        account_id: 1,
        last_history_id: '5000',
        last_synced_at: '2026-05-08T00:00:00Z',
      },
      since: undefined,
      fallbackDays: 30,
      now,
    })
    expect(result).toEqual({ kind: 'history', start_history_id: '5000' })
  })

  it('returns range with fallbackDays-back when neither is set', () => {
    const result = chooseDiscovery({
      syncState: undefined,
      since: undefined,
      fallbackDays: 30,
      now,
    })
    // 2026-05-09 minus 30 days = 2026-04-09
    expect(result).toEqual({ kind: 'range', q: 'after:2026/04/09' })
  })

  it('returns range with fallbackDays-back when last_history_id is null', () => {
    const result = chooseDiscovery({
      syncState: {
        account_id: 1,
        last_history_id: null,
        last_synced_at: null,
      },
      since: undefined,
      fallbackDays: 7,
      now,
    })
    // 2026-05-09 minus 7 days = 2026-05-02
    expect(result).toEqual({ kind: 'range', q: 'after:2026/05/02' })
  })

  it('lets `since` override last_history_id', () => {
    const result = chooseDiscovery({
      syncState: {
        account_id: 1,
        last_history_id: '5000',
        last_synced_at: '2026-05-08T00:00:00Z',
      },
      since: '2026-03-15',
      fallbackDays: 30,
      now,
    })
    expect(result).toEqual({ kind: 'range', q: 'after:2026/03/15' })
  })

  it('formats the fallback date in UTC slashed notation', () => {
    const result = chooseDiscovery({
      syncState: undefined,
      since: undefined,
      fallbackDays: 1,
      now: new Date('2026-01-02T00:00:00Z'),
    })
    expect(result).toEqual({ kind: 'range', q: 'after:2026/01/01' })
  })

  it('zero-pads month and day in the fallback', () => {
    const result = chooseDiscovery({
      syncState: undefined,
      since: undefined,
      fallbackDays: 5,
      now: new Date('2026-03-08T00:00:00Z'),
    })
    expect(result).toEqual({ kind: 'range', q: 'after:2026/03/03' })
  })

  it('passes `since` through verbatim if already in YYYY/MM/DD form', () => {
    const result = chooseDiscovery({
      syncState: undefined,
      since: '2026/01/15',
      fallbackDays: 30,
      now,
    })
    // Spec wording says since is `YYYY-MM-DD`; this defensive case asserts the
    // function still produces a `q` Gmail will accept either way (with slashes).
    expect(result).toEqual({ kind: 'range', q: 'after:2026/01/15' })
  })
})
