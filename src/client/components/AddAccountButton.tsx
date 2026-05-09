import { useState } from 'react'
import { postJson } from '../api.js'
import { useAccountsPoll } from '../hooks/useAccountsPoll.js'
import type { Account } from '../types.js'

type Status = 'idle' | 'polling' | 'error'

export type AddAccountButtonProps = {
  baselineIds: number[]
  onAdded: (account: Account) => void
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export function AddAccountButton({
  baselineIds,
  onAdded,
  pollIntervalMs,
  pollTimeoutMs,
}: AddAccountButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleClick() {
    setErrorMsg(null)
    try {
      const { consent_url } = await postJson<{ consent_url: string; state: string }>(
        '/api/oauth/start',
      )
      window.open(consent_url, '_blank', 'noopener,noreferrer')
      setStatus('polling')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start the OAuth flow.')
    }
  }

  useAccountsPoll({
    enabled: status === 'polling',
    done: (accounts) => {
      const baseline = new Set(baselineIds)
      const newOne = accounts.find((a) => !baseline.has(a.id))
      if (newOne !== undefined) {
        onAdded(newOne)
        setStatus('idle')
        return true
      }
      return false
    },
    onTimeout: () => {
      setStatus('error')
      setErrorMsg('Took too long — click Add Gmail account to try again.')
    },
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
  })

  return (
    <div>
      <button onClick={handleClick} disabled={status === 'polling'}>
        Add Gmail account
      </button>
      {status === 'polling' && <p>Waiting for OAuth consent…</p>}
      {status === 'error' && errorMsg !== null && <p role="alert">{errorMsg}</p>}
    </div>
  )
}
