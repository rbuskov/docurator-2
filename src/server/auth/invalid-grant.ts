// Detects the Gmail-token-revoked / refresh-failed signal across the two shapes
// the googleapis client surfaces it as: a thrown Error whose message contains
// `invalid_grant`, or a structured `{ response: { data: { error: '...' } } }`
// payload from a non-2xx HTTP response.

export function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('invalid_grant')) return true
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } } }
    if (e.response?.data?.error === 'invalid_grant') return true
  }
  return false
}
