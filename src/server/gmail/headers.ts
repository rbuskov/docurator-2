import type { gmail_v1 } from 'googleapis'

export function extractHeader(message: gmail_v1.Schema$Message, name: string): string {
  const headers = message.payload?.headers ?? []
  const target = name.toLowerCase()
  for (const h of headers) {
    if (typeof h.name === 'string' && h.name.toLowerCase() === target) {
      return h.value ?? ''
    }
  }
  return ''
}

export function parseFromAddressDomain(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null

  let address: string
  if (trimmed.includes('<')) {
    const open = trimmed.lastIndexOf('<')
    const close = trimmed.lastIndexOf('>')
    if (close <= open) return null
    address = trimmed.slice(open + 1, close).trim()
  } else if (trimmed.includes(',') || trimmed.includes(':') || trimmed.includes(';')) {
    return null
  } else {
    address = trimmed
  }

  const at = address.lastIndexOf('@')
  if (at < 0) return null
  const domain = address.slice(at + 1).trim().toLowerCase()
  if (domain === '') return null
  return domain
}
