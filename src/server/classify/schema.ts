import { z } from 'zod'

// YYYY-MM-DD shape only — calendar validity (impossible months/days) is
// intentionally not enforced here. The classifier is asked to extract a date
// in this format; downstream UIs render it verbatim.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

// What the model returns inside `response.message.content` once parsed as JSON.
export const classificationSchema = z.object({
  classification: z.enum(['invoice', 'receipt', 'other']),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(2000),
  vendor: z.string().min(1).max(200).optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  transaction_date: z.string().regex(ISO_DATE_REGEX).optional(),
})
export type Classification = z.infer<typeof classificationSchema>

// One per artifact the pipeline included in the prompt — the email body, an
// attached image, a rendered PDF page. The UI uses this to render an
// "artifacts considered" list inline with the verdict.
export const artifactSchema = z.object({
  kind: z.enum(['body', 'attachment']),
  filename: z.string().optional(),
  mime_type: z.string().min(1),
})
export type Artifact = z.infer<typeof artifactSchema>

// The full HTTP response shape returned by POST /api/.../classify. Composes
// the model's classification with run-time metadata the UI needs.
export const classifyResponseSchema = classificationSchema.extend({
  model_used: z.string().min(1),
  artifacts: z.array(artifactSchema),
})
export type ClassifyResponse = z.infer<typeof classifyResponseSchema>
