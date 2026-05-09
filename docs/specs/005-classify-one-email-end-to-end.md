# Slice 005: Classify one email end-to-end

**Status:** ready

## Observable result

I can pick a real email from any of my connected Gmail accounts (in the Inbox view), click "Classify", and within a few seconds see Ollama's verdict — `invoice` / `receipt` / `other`, plus a confidence and a short stated reason — rendered inline on that row, with no row written to any database table.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` table (Slice 002)
- **Migrations:** —
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/accounts/:id/messages?limit=50` (Slice 003)
- **UI views / components:**
  - `Dashboard.tsx` at `/` (Slice 002) — extended with an Ollama health badge here
  - `Inbox.tsx` at `/inbox` (Slice 003) — extended with per-row Classify buttons here
  - `Nav.tsx`, `AccountPicker.tsx` (Slice 003)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Slice 002)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/auth/accounts.ts`, `src/server/auth/session.ts` (Slice 002)
  - `src/server/gmail/client.ts` (Slice 003) — extended with `getMessage(format='full')` use and a new `getAttachment` method here
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Google OAuth + Gmail API access for each connected account (Slice 002 produced the tokens; Slice 003 added the client)
- **Other:** —

## Deliverables (Produces)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:**
  - `GET /api/ollama/health` → response `{ reachable: boolean, model: string, model_available: boolean, error?: string }`. Calls Ollama's `GET /api/tags` at `OLLAMA_URL`, checks whether the configured `OLLAMA_MODEL` is among the installed models, returns the result. Used by the Dashboard health badge.
  - `POST /api/accounts/:id/messages/:message_id/classify` → no request body. Synchronously runs the full classification pipeline for one message and returns response `{ classification: 'invoice' | 'receipt' | 'other', confidence: 'high' | 'medium' | 'low', reason: string, vendor?: string, amount?: number, currency?: string, transaction_date?: string, model_used: string, artifacts: Array<{ kind: 'body' | 'attachment', filename?: string, mime_type: string }> }`. The endpoint **does not write to any DB table** — its job is to return a decision the UI displays inline. On Ollama unreachable: HTTP 503 with `{ error: 'ollama_unreachable' }`. On Ollama parse error (malformed JSON, schema violation): HTTP 502 with `{ error: 'ollama_parse_error', raw_response: string }`. On Gmail token error: HTTP 401 `{ error: 'needs_reauth', account_id }`.
- **UI views / components:**
  - `OllamaHealth.tsx` — small badge component shown in the Dashboard header. Polls `GET /api/ollama/health` every 30s. Renders one of: green "Ollama: qwen2.5vl:7b ready", yellow "Ollama reachable, model qwen2.5vl:7b not pulled — run `ollama pull qwen2.5vl:7b`", red "Ollama unreachable at http://host.docker.internal:11434".
  - `ClassifyRowAction.tsx` — per-row component added to each `Inbox.tsx` row. Renders a "Classify" button when no result yet; renders a verdict pill (`invoice` / `receipt` / `other`), a confidence label, and the model's stated reason once the call returns; renders an error chip on failure with a "Retry" affordance. Per-row state is component-local; navigating away clears it (this slice persists nothing).
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `OLLAMA_URL` (default `http://host.docker.internal:11434`) — base URL for Ollama's HTTP API. Documented in `.env.example` (modification of the Slice 002 file).
  - `OLLAMA_MODEL` (default `qwen2.5vl:7b`) — model name passed in chat requests and checked against `GET /api/tags`.
  - `OLLAMA_TIMEOUT_MS` (default `120000`) — per-request timeout. Vision-capable inference on a single message can take tens of seconds on a CPU-bound host; the default is generous.
  - `docker-compose.yml` updated to pass through `OLLAMA_URL`, `OLLAMA_MODEL`, and `OLLAMA_TIMEOUT_MS`. (`extra_hosts: host.docker.internal:host-gateway` already exists from Slice 001; this slice is the first to actually use it.)
- **Files / modules:**
  - `src/server/classify/index.ts` — pipeline orchestrator. Exports `classifyMessage({ account_id, message_id }): Promise<ClassificationResult>`. Steps: fetch full message via the Slice 003 client (format=`full`), extract body text, fetch + decode each receipt-eligible attachment, render PDFs to one image per page (capped at 5 pages), build the multimodal prompt, call Ollama, parse + Zod-validate the response.
  - `src/server/classify/ollama.ts` — Ollama HTTP client. Exports `chat({ model, messages, format, timeoutMs })` returning the parsed assistant content, and `listModels()` returning the names from `GET /api/tags`. Uses `fetch` with an `AbortController` for the timeout.
  - `src/server/classify/prompt.ts` — exports `buildClassificationMessages({ subject, from, body_text, images })`: a system message ("You are a classifier for business receipts and invoices…") and a single user message containing the email metadata, the body text, and each image as a base64-encoded `image` content block. The system message instructs strict JSON output matching the response Zod schema. The system-prompt copy lives here as a TypeScript constant; tuning it later is a one-file change.
  - `src/server/classify/extract-body.ts` — `extractBodyText(payload: gmail_v1.Schema$MessagePart): { text: string, html_was_used: boolean }`. Walks the MIME tree, prefers `text/plain` parts, falls back to converting `text/html` via a small sanitizer (e.g. `node-html-parser` reading text content). Inline images referenced via `cid:` are noted in the prompt metadata but not rendered in this slice; Slice 006's Playwright HTML→PDF path subsumes that case.
  - `src/server/classify/render-pdf.ts` — `renderPdfToImages(pdf_bytes: Uint8Array, max_pages: number): Promise<Buffer[]>`. Uses `pdfjs-dist` (legacy/Node build) plus `@napi-rs/canvas` to render each page to a PNG buffer. Returns up to `max_pages` images.
  - `src/server/classify/schema.ts` — Zod schemas for the Ollama response (`classification`, `confidence`, `reason`, optional `vendor`, `amount`, `currency`, `transaction_date`) and for any internal types. `transaction_date` is `z.string().regex(ISO_DATE_REGEX)` (YYYY-MM-DD), `amount` is `z.number().nonnegative()`, `currency` is a 3-letter `z.string().length(3)`.
  - `src/server/api/classify.ts` — registers `POST /api/accounts/:id/messages/:message_id/classify`. Validates the URL params with a Zod validator (numeric `:id`, non-empty `:message_id`).
  - `src/server/api/ollama.ts` — registers `GET /api/ollama/health`.
  - `src/server/gmail/client.ts` — modified to add `getAttachment(message_id: string, attachment_id: string): Promise<{ data: Buffer, size: number }>` (wraps `users.messages.attachments.get`). Existing `getMessage` is now also called with `format='full'` from this slice; the method signature already accepts that.
  - `src/client/components/OllamaHealth.tsx`, `src/client/components/ClassifyRowAction.tsx`
  - `src/client/views/Inbox.tsx` — modified to render a `ClassifyRowAction` in each row's last column (modification, not re-deliver).
  - `src/client/views/Dashboard.tsx` — modified to render `<OllamaHealth />` next to the Accounts list (modification, not re-deliver).
  - `package.json` updates: adds `zod`, `@hono/zod-validator`, `pdfjs-dist`, `@napi-rs/canvas`, `node-html-parser` to runtime deps. (Zod arrives now because this is the first slice that demonstrably needs it; earlier slices' API handlers can adopt it later if desired.)
- **External services:**
  - Live Ollama at `OLLAMA_URL` — receives multimodal chat requests for the configured `OLLAMA_MODEL`. Listed here so future slices can list "Ollama reachability" as a Prerequisite verbatim.
- **Other:**
  - First exercise of `extra_hosts: host.docker.internal:host-gateway` (declared in Slice 001's `docker-compose.yml`); confirms cross-platform Docker → host networking works.
  - First synchronous long-running endpoint in the codebase. Server-side timeout via `OLLAMA_TIMEOUT_MS` and `AbortController`. The UI shows a spinner during the wait.

## Out of scope

- Persisting any classification result to `processed_messages` or `documents` → Slice 006
- Persisting receipt files to disk under `./invoices/{account_slug}/...` → Slice 006
- HTML body → PDF rendering with Playwright (for "body-as-receipt" cases that need a visual artifact for accounting) → Slice 006
- Sync orchestrator that walks all messages and classifies them in batch → Slice 006
- Attachment-level dedup (`content_hash`) and document grouping → Slices 006 / 013
- Per-message reclassify action against persisted state → Slices 010 / 014
- Failure logging into `processed_messages.status='failed'` → Slice 012 (this slice surfaces failures only via the API response, not by writing them)
- Inline editable fields (`vendor`, `amount`, etc. that the model returns) — for now the API response includes them when the model produced them; an editing UI ships in Slice 008
- Tag-aware classification or sender-memory adjustments → Slices 009 / 015
- Removing the dev seed panel introduced in Slice 004 → Slice 006

## Detailed design

This slice realizes `architecture.md` § "Classification module" steps 1–4 and § "Ollama" reachability for the first time end to end, but skips step 5's persistence — that's Slice 006's responsibility. It is intentionally early in the sequence (per `initial-feature-slices.md`'s ordering note) because it answers the project's riskiest question: can a local vision model classify these emails reliably? Building it before any of the persistence/review/export machinery means we find out cheaply.

- **Per-message synchronous endpoint.** The Inbox row's "Classify" button calls a synchronous endpoint that does the whole pipeline and returns the decision. SSE/streaming progress is not needed for one message; that machinery is a Slice 006 concern when batch sync ships. Long timeouts (`OLLAMA_TIMEOUT_MS=120000`) accommodate slow CPU inference; the UI shows a spinner during the wait.
- **Body extraction.** `extractBodyText` walks the message payload. Preference order: `multipart/alternative` → `text/plain`; failing that, `text/html` is parsed and the visible text content is extracted (no JS execution, no styling). This matches `architecture.md` § "Classification module" step 1's "Convert HTML body to plain text". Inline `cid:` images are detected and counted (their existence is included in the metadata block of the prompt, e.g. "this email contains 2 inline images") but are not yet rendered into the model's input — that requires an HTML-rendering step covered by Slice 006's Playwright path.
- **Attachment fetching and rendering.** For each attachment whose MIME type is in `{image/png, image/jpeg, image/gif, image/webp, application/pdf}`, the pipeline calls `getAttachment` (read-only), decodes the base64 payload, and converts to one or more PNG buffers: images pass through; PDFs are rendered via `pdfjs-dist` + `@napi-rs/canvas`. Other MIME types are listed by name in the prompt metadata but their bytes are not sent to the model. Attachments larger than `MAX_ATTACHMENT_BYTES` (5 MB) are skipped with a metadata note; this prevents one giant scan PDF from breaking inference. Both caps are tunable in later slices.
- **PDF page cap.** A multi-page PDF is rendered up to `MAX_PDF_PAGES` (5 pages, hard-coded) — receipts are usually one page; a long PDF is almost certainly a contract or report, not a receipt. The first page alone may suffice for classification, but five gives the model more chance to see line items if the receipt is structured. The cap keeps memory and inference cost bounded.
- **Prompt and schema.** A single chat call: system message describing the task and the strict JSON schema, user message with metadata (subject, sender, date, attachment list), the body text, and the images. The system prompt explicitly states "if you are unsure, return `confidence: low`" — this is the architecture's conservative-confidence preference (`architecture.md` § "Classification module") encoded in prose. Ollama's `format: 'json'` parameter is used to constrain output; the response is then Zod-validated for type safety. A schema violation produces HTTP 502 with the raw response so the user can see what the model returned (useful while iterating on the prompt).
- **Multiple plausible documents.** `architecture.md` notes the classifier may return multiple results (body + attached invoice). For this slice we return one decision per request — a single classification covering the message as a whole. Multi-artifact decisions are deferred to Slice 006, where the persistence model needs them anyway. The `artifacts` array in the response lists what was sent to the model, so a future slice can split this into one decision per artifact without changing the prompt.
- **Ollama health.** A separate endpoint and badge keep the health check decoupled from the per-message endpoint. The badge polls every 30s and on Dashboard mount; failures are non-fatal — the user can still browse the Inbox; only the Classify button errors out if Ollama is down.
- **No persistence anywhere.** This is the constraint that keeps the slice small. The `POST .../classify` handler does not touch SQLite. The UI's per-row state is component-local; reloading the page clears it. The spec for Slice 006 will add the persistence step on top of this same pipeline by writing a `processed_messages` row plus (when applicable) `documents` rows and on-disk files, and by replacing the dev-seed panel from Slice 004.
- **Build-time guard still passes.** `getAttachment` wraps `users.messages.attachments.get` — a read endpoint. The Slice 003 substring guard does not list any of the Gmail attachment-read paths as forbidden. The new code references `attachments.get`, which is allowed.

## Acceptance criteria

- The Dashboard renders an Ollama health badge that reports `ready` when Ollama is running on the host with `qwen2.5vl:7b` pulled, `unreachable` when Ollama is stopped, and `model not pulled` when Ollama is up but the configured model is missing.
- In the Inbox, each row has a "Classify" button. Clicking it on a real receipt-shaped email returns within `OLLAMA_TIMEOUT_MS`, and the row inline-shows `receipt` (or `invoice` for clearly-invoice-shaped messages) with `high` or `medium` confidence and a short reason.
- Clicking Classify on a clearly non-receipt message (a normal personal email, a newsletter, a meeting notice) returns `other`.
- For an email with a PDF attachment, the API response's `artifacts` array includes one `{ kind: 'attachment', mime_type: 'application/pdf', filename: '…' }` entry; for an HTML-body-only receipt, `artifacts` includes one `{ kind: 'body', mime_type: 'text/html' }` entry.
- Stopping Ollama and clicking Classify returns the `ollama_unreachable` error chip; the page does not crash, and other UI continues to function.
- Returning malformed JSON from a fake Ollama (e.g. via a debugging proxy) produces the `ollama_parse_error` chip; the raw response is included in the API body for debugging.
- During and after a Classify call, no row is added to `processed_messages` or `documents`; `sqlite3 data/app.db "SELECT COUNT(*) FROM processed_messages;"` returns the same number it did before the click.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes after this slice's `gmail/client.ts` modification.
- `GET /api/ollama/health` returns within ~5s even when Ollama is unreachable (no hung requests).
- The codebase contains zero references to non-`gmail.readonly` OAuth scopes (verified by grep) and zero references to non-read Gmail API methods (verified by the build-time check).

## Implementation notes

- **`pdfjs-dist` + `@napi-rs/canvas`.** Renders PDFs in pure-Node without system dependencies. Adds tens of MB to the image but avoids a Dockerfile change. Other rendering paths can be swapped in later if the image size becomes an issue.
- **PDF page cap of 5.** Renders up to five pages per PDF. Receipts are typically one page; the cap keeps memory and inference cost bounded.
- **Attachment size cap of 5 MB.** Larger attachments are skipped with a metadata note in the prompt rather than fed to the model. Size + filename usually tell the model it isn't a typical receipt.
- **Inline `cid:` images not rendered.** The body extractor notes their existence in the prompt metadata. Slice 006's Playwright HTML→PDF rendering subsumes this case once it ships.
- **Single-decision response.** This slice returns one decision per message. The `artifacts` array lists what was sent to the model, so Slice 006 can split into per-artifact decisions when persistence requires them.
- **Synchronous endpoint with long timeout.** Holding the HTTP connection open for up to 120s is fine for a localhost-only single-user tool. Slice 006 moves batch work to SSE; one-off classify stays synchronous.
- **Prompt copy lives in TypeScript.** Tuning the prompt is a code change. For a self-hosted single-user tool that's the right tradeoff.
- **`format=full` payload size.** No hard cap on Gmail's payload response — the client trusts Gmail's API to be robust. Outsized payloads from a single message would surface as an Ollama timeout or memory error and can be tuned in later slices if encountered.
- **Zod adopted in this slice but not retroactively.** Earlier slices' API handlers don't use `@hono/zod-validator`. Future slices can adopt it as needed; this slice does not retrofit earlier endpoints.
