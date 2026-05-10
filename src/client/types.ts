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

// Mirrors `DocumentListRow` from src/server/db/repositories/documents.ts
// — the row shape returned by GET /api/accounts/:id/documents. The
// classification / confidence / subject / sender_domain columns come from a
// LEFT JOIN onto the latest `processed_messages` row for the same
// (account_id, message_id) and may be null when no row exists.
export type DocumentKind = 'attachment' | 'rendered_body'
export type DocumentReviewStatus = 'pending' | 'approved' | 'rejected'

export type Document = {
  id: number
  account_id: number
  message_id: string
  kind: DocumentKind
  filename: string
  mime_type: string
  size: number
  content_hash: string
  file_path: string
  vendor: string | null
  amount: number | null
  currency: string | null
  transaction_date: string | null
  review_status: DocumentReviewStatus
  created_at: string
  updated_at: string
  classification: ProcessedMessageClassification | null
  confidence: ProcessedMessageConfidence | null
  subject: string | null
  sender_domain: string | null
}

// Mirrors GET /api/sync/status. When `active` is false, only that field is set.
export type SyncAccountSnapshot = {
  account_id: number
  processed: number
  receipts: number
  failed: number
  in_progress: boolean
}

export type SyncStatus =
  | { active: false }
  | {
      active: true
      job_id: string
      started_at: string
      accounts: SyncAccountSnapshot[]
    }

// Mirrors the events the orchestrator emits over GET /api/sync/events. Names
// match `src/server/sync/orchestrator.ts`. Discriminated on `event` so
// reducers can switch exhaustively.
export type SyncMessageStatus = 'success' | 'failed' | 'skipped'

export type SyncEvent =
  | {
      event: 'sync.start'
      payload: { job_id: string; account_ids: number[]; started_at: string }
    }
  | { event: 'sync.account.start'; payload: { account_id: number } }
  | {
      event: 'sync.message'
      payload: {
        account_id: number
        message_id: string
        status: SyncMessageStatus
        document_ids: number[]
        classification?: ProcessedMessageClassification
        confidence?: ProcessedMessageConfidence
        error_message?: string
      }
    }
  | {
      event: 'sync.account.done'
      payload: { account_id: number; processed: number; receipts: number; failed: number }
    }
  | { event: 'sync.error'; payload: { account_id: number; message: string } }
  | { event: 'sync.done'; payload: { job_id: string } }
