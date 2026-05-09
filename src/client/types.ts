export type AccountStatus = 'connected' | 'needs_reauth'

export type Account = {
  id: number
  email: string
  display_name: string | null
  slug: string
  connected_at: string
  last_seen_at: string | null
  status: AccountStatus
}

export type Message = {
  id: string
  thread_id: string
  subject: string
  from: string
  date: string
  internal_date: string
}
