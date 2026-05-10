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

export type ClassificationVerdict = 'invoice' | 'receipt' | 'other'
export type ClassificationConfidence = 'high' | 'medium' | 'low'

export type ClassificationArtifact = {
  kind: 'body' | 'attachment'
  filename?: string
  mime_type: string
}

// Mirrors `classifyResponseSchema` from src/server/classify/schema.ts.
export type ClassificationResult = {
  classification: ClassificationVerdict
  confidence: ClassificationConfidence
  reason: string
  vendor?: string
  amount?: number
  currency?: string
  transaction_date?: string
  model_used: string
  artifacts: ClassificationArtifact[]
}

// Mirrors the body of GET /api/ollama/health.
export type OllamaHealth = {
  reachable: boolean
  model: string
  model_available: boolean
  error?: string
}
