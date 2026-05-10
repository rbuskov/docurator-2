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

export type ProcessedMessageStatus = 'success' | 'failed'
export type ProcessedMessageClassification = 'invoice' | 'receipt' | 'other'
export type ProcessedMessageConfidence = 'high' | 'medium' | 'low'

export type ProcessedMessage = {
  message_id: string
  thread_id: string
  internal_date: string
  processed_at: string
  model_used: string
  status: ProcessedMessageStatus
  classification: ProcessedMessageClassification | null
  confidence: ProcessedMessageConfidence | null
  sender_domain: string | null
  subject: string | null
}
