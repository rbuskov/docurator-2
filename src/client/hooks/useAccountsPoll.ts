import { useEffect, useRef } from 'react'
import { getJson } from '../api.js'
import type { Account } from '../types.js'

export type UseAccountsPollArgs = {
  enabled: boolean
  done: (accounts: Account[]) => boolean
  onTimeout: () => void
  intervalMs?: number
  timeoutMs?: number
}

export function useAccountsPoll(args: UseAccountsPollArgs): void {
  const doneRef = useRef(args.done)
  const onTimeoutRef = useRef(args.onTimeout)
  doneRef.current = args.done
  onTimeoutRef.current = args.onTimeout

  const intervalMs = args.intervalMs ?? 2000
  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000
  const enabled = args.enabled

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    function cleanup() {
      cancelled = true
      if (intervalId !== null) clearInterval(intervalId)
      if (timeoutId !== null) clearTimeout(timeoutId)
      intervalId = null
      timeoutId = null
    }

    async function tick() {
      if (cancelled) return
      try {
        const { accounts } = await getJson<{ accounts: Account[] }>('/api/accounts')
        if (cancelled) return
        if (doneRef.current(accounts)) {
          cleanup()
        }
      } catch {
        // Swallow poll errors and try again on the next tick.
      }
    }

    intervalId = setInterval(tick, intervalMs)
    timeoutId = setTimeout(() => {
      cleanup()
      onTimeoutRef.current()
    }, timeoutMs)

    return cleanup
  }, [enabled, intervalMs, timeoutMs])
}
