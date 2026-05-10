import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

// jsdom doesn't ship `EventSource`, but `useSyncEvents` (Slice 006) constructs
// one on mount. A no-op fake satisfies the constructor in any client test that
// renders a tree containing SyncControls without caring about events.
// `useSyncEvents.test.ts` and `SyncControls.test.tsx` install their own
// FakeEventSource over this default to drive events directly.
class NoopEventSource {
  url: string
  closed = false
  constructor(url: string) {
    this.url = url
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true
  }
}

if (typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  ;(globalThis as { EventSource?: unknown }).EventSource =
    NoopEventSource as unknown as typeof EventSource
}
