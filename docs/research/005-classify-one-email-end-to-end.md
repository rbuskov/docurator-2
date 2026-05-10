# Slice 005: Classify one email end-to-end — Research

**Spec:** `docs/specs/005-classify-one-email-end-to-end.md`

## Summary of what the spec asks for

The slice realizes `architecture.md` § "Components — Classification module" steps 1-5 (HTML→text body extraction, multimodal prompt building, Ollama chat call, JSON response parsing, decision return) end-to-end without any DB writes. The Observable result is "click Classify on a real Inbox row → within seconds, see Ollama's verdict (`invoice` / `receipt` / `other`, plus confidence and a short reason) inline on that row". Headline deliverables are two new endpoints (`GET /api/ollama/health`, `POST /api/accounts/:id/messages/:message_id/classify`), a new server module tree under `src/server/classify/` (orchestrator, Ollama HTTP client, prompt builder, body extractor, PDF→images renderer, Zod schemas), an extension to `src/server/gmail/client.ts` (`getAttachment(...)` plus a `format='full'` call site), two new client components (`OllamaHealth.tsx`, `ClassifyRowAction.tsx`), modifications to `Dashboard.tsx` (mount the badge) and `Inbox.tsx` (mount the per-row action), three new env vars (`OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`), and five new runtime deps (`zod`, `@hono/zod-validator`, `pdfjs-dist`, `@napi-rs/canvas`, `node-html-parser`). The classify endpoint **does not write to any DB table** — that's Slice 006's job.

## Existing code that this spec touches

What's actually in the tree today (post-Slice 004):

- `src/server/gmail/client.ts` — `createGmailClient(accountId): { listMessages, getMessage }`. **Modify here** to add `getAttachment(messageId, attachmentId): Promise<{ data: Buffer; size: number }>` wrapping `users.messages.attachments.get`. The existing `getMessage` already accepts `format: 'minimal' | 'full' | 'raw' | 'metadata'`, so the classify pipeline calls it with `format: 'full'` without a signature change. The wrapper pattern (`withFreshTokens(accountId, async (sessionClient) => { ... })`) is the established shape — `getAttachment` follows it identically. Read-only Gmail discipline still holds: `users.messages.attachments.get` is a read endpoint, and the substring guard in `scripts/check-gmail-readonly.ts` does not list any of the attachment-read paths as forbidden.

- `src/server/gmail/client.test.ts` — existing tests stub `gmailFactory` via `setGmailFactoryForTest` and assert call shape. **Edit here** to add coverage for `getAttachment`: stub the factory to return `{ users: { messages: { attachments: { get: vi.fn(...) } } } }`, assert the wrapper passes the right `userId`, `messageId`, `id`, decodes base64url payload to a Buffer, and exposes `size` from the API response.

- `src/server/api/messages.ts` — Slice 003's listing endpoint. **No change** — the new classify endpoint is a separate file (`src/server/api/classify.ts`) and the new health endpoint is a separate file (`src/server/api/ollama.ts`). The error-mapping helper `isInvalidGrantError` is duplicated here, in `src/server/api/dev.ts`, and will be needed in `src/server/api/classify.ts` (third caller). Slice 004's review flagged the duplicate and queued the extract for "Slice 005 or 006 cleanup"; this slice does the extract — see "Refactors needed".

- `src/server/app.ts` — `createApp()` registers `/health`, accounts, oauth, messages, dev, processed_messages, then the optional static fallback. **Edit here** to insert `registerOllamaRoutes(app)` and `registerClassifyRoutes(app, deps?)` between the existing routes and the static fallback. The factory pattern (`registerXxxRoutes(app, deps?)`) is the established shape. Both new routes are more specific than the static catch-all `*`, so ordering matters only for sibling `/api/...` routes — appending to the chain is fine.

- `src/server/config.ts` — frozen snapshot of `port`, `googleClientId`, `googleClientSecret`, `dbPath`, `postOauthRedirectUrl`, `nodeEnv`. **Edit here** to add three frozen fields: `ollamaUrl`, `ollamaModel`, `ollamaTimeoutMs`. Defaults match the spec verbatim: `'http://host.docker.internal:11434'`, `'qwen2.5vl:7b'`, `120000`. Pattern matches Slice 004's addition of `nodeEnv`. `ollamaTimeoutMs` is a number; the parser is `Number(process.env.OLLAMA_TIMEOUT_MS)` with a NaN fallback to the default — same shape as `port`.

- `src/server/config.test.ts` — extends with three new tests (defaults applied; env overrides honored; bogus `OLLAMA_TIMEOUT_MS` falls back to default).

- `src/client/views/Inbox.tsx` — Slice 003's per-row table. **Modify here** to add a fourth `<th>Classify</th>` and a fourth `<td><ClassifyRowAction account_id={...} message_id={m.id} /></td>`. The existing useEffect / state machinery is unchanged. Per-row state lives inside `ClassifyRowAction`; navigating away to another route unmounts the rows and clears their state, which matches the spec's "navigating away clears it (this slice persists nothing)".

- `src/client/views/Inbox.test.tsx` — extends to assert that each row renders a Classify button by default; existing assertions (subject / sender / date columns) stay green because the new `<th>` and `<td>` are append-only.

- `src/client/views/Dashboard.tsx` — Slice 002 → Slice 004's account list + AddAccountButton + DevSeedPanel. **Modify here** to mount `<OllamaHealth />` between the existing `<AccountList />` and `<AddAccountButton />` (or as a sibling — placement is a UX call; the spec says "in the Dashboard header" but the Dashboard doesn't currently have a distinct header, so above the account list is the closest match). The badge is fully self-contained: it polls on mount and every 30 s, has its own state, and renders one of three pill colors. No Dashboard state needs to be lifted.

- `src/client/views/Dashboard.test.tsx` — extends to assert that `<OllamaHealth />` is rendered when the Dashboard mounts; the existing happy-path / loading / error cases continue to use URL-routed `mockImplementation` from Slice 004 and add an `/api/ollama/health` mock to the fall-through map.

- `src/client/types.ts` — exports `Account`, `Message`, `ProcessedMessage`. **Edit here** to add a `ClassificationResult` type matching the API response shape (verbatim from the spec): `{ classification, confidence, reason, vendor?, amount?, currency?, transaction_date?, model_used, artifacts }`. Plus the `OllamaHealth` type for the badge endpoint: `{ reachable, model, model_available, error? }`. Pattern matches Slice 004's choice to keep all client-side domain types in this one file.

- `src/client/api.ts` — `getJson<T>` and `postJson<T>`. **Reuse** for the Ollama health fetch and the per-row Classify POST. The error contract is "throw on non-2xx with status text"; the new components catch and inspect status codes (401, 502, 503) for the spec's error-chip behavior, so a thin `fetch(...)` is preferable to `postJson` here for fine-grained status branching — pattern matches what `Inbox.tsx` and `DevSeedPanel.tsx` already do.

- `src/client/components/AccountPicker.tsx` — disabled-on-needs-reauth `<select>` from Slice 003. **No change**.

- `package.json` — runtime deps `better-sqlite3`, `googleapis`, `react`, `react-router-dom@^6` already present. **Add five runtime deps:** `zod`, `@hono/zod-validator`, `pdfjs-dist`, `@napi-rs/canvas`, `node-html-parser`. The `check:gmail-readonly` build step runs unchanged and continues to pass (the new code references `attachments.get`, which is allowed; no forbidden substring is introduced).

- `.env.example` — already documents `APP_PORT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_PORT`, `NODE_ENV`. **Edit here** to add three commented sections for `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` with their defaults and a one-line description each.

- `vitest.workspace.ts` / `vitest.config.ts` — already cover `src/server/**/*.test.ts` and `src/client/**/*.test.{ts,tsx}` with `pool: 'forks'` and `testTimeout: 15000`. **No change** — the new tests slot in.

- `scripts/check-gmail-readonly.ts` — the build-time substring guard. **No change** — it scans for forbidden substrings; `getAttachment` calls `users.messages.attachments.get`, which contains none of them.

- `src/server/index.ts` — server entrypoint. **No change** — the new routes wire in via `createApp()` and the new modules are loaded transitively.

- The deleted root `Dockerfile` / `docker-compose.yml` — historically the spec calls out `docker compose up` and `extra_hosts: host.docker.internal:host-gateway` ("First exercise of `extra_hosts: host.docker.internal:host-gateway`"). The Dec 9 commit deleted both files in favor of the `.devcontainer/` workflow (Slice 004's review documented this). For local dev, the devcontainer reaches the host's Ollama via the same `host.docker.internal` hostname (Docker Desktop on Mac/Windows resolves it; Linux needs `--add-host` in `runArgs`, which the devcontainer does not currently set — see "Risks"). The spec's smoke recipe assumes the user runs Ollama on the host and the dev/prod process resolves `host.docker.internal:11434`. In the devcontainer's current shape on Linux, the resolution path may need a manual hosts entry or an override `OLLAMA_URL=http://172.17.0.1:11434`. This slice does **not** restore the deleted `docker-compose.yml`; it documents the env-override path as an alternative when `host.docker.internal` doesn't resolve.

Files / modules the spec creates from scratch (no existing analogue):

- `src/server/classify/index.ts` — pipeline orchestrator. Exports `classifyMessage({ account_id, message_id }): Promise<ClassificationResult>`. Steps: fetch full message via the Slice 003 client (`format='full'`), extract body text + receipt-eligible attachments via metadata walk, fetch + decode each attachment, render PDFs to PNG buffers (capped at 5 pages), build the multimodal prompt, call Ollama, parse + Zod-validate the response.
- `src/server/classify/ollama.ts` — Ollama HTTP client. Exports `chat({ model, messages, format, timeoutMs })` returning the parsed assistant content (string), and `listModels(): Promise<string[]>` returning the names from `GET /api/tags`. Uses `globalThis.fetch` with an `AbortController` for the timeout.
- `src/server/classify/prompt.ts` — exports `buildClassificationMessages({ subject, from, body_text, attachments_metadata, images })`: a system message ("You are a classifier for business receipts and invoices…") and a single user message containing the email metadata, the body text, and each image as a base64-encoded `image` content block. The system message instructs strict JSON output matching the Zod schema. The system-prompt copy lives here as a TypeScript constant.
- `src/server/classify/extract-body.ts` — `extractBodyText(payload: gmail_v1.Schema$MessagePart): { text: string; html_was_used: boolean; inline_image_count: number }`. Walks the MIME tree, prefers `text/plain` parts, falls back to converting `text/html` via `node-html-parser` (`.text` of the parsed root). Inline images referenced via `cid:` are counted (their CIDs are not resolved this slice; their existence is included in the prompt metadata).
- `src/server/classify/extract-attachments.ts` — `extractAttachmentMetadata(payload): AttachmentRef[]`. Walks the MIME tree to collect `{ part_id, attachment_id, filename, mime_type, size }` for any non-inline part with a non-empty filename. Separates "receipt-eligible" by mime type (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`). Pulled out from the orchestrator for direct unit-testability.
- `src/server/classify/render-pdf.ts` — `renderPdfToImages(pdf_bytes: Uint8Array, max_pages: number): Promise<Buffer[]>`. Uses `pdfjs-dist` (legacy/Node build) plus `@napi-rs/canvas` to render each page to a PNG buffer. Returns up to `max_pages` images.
- `src/server/classify/schema.ts` — Zod schemas for the Ollama response (`classification`, `confidence`, `reason`, optional `vendor`, `amount`, `currency`, `transaction_date`) and exported TypeScript types. `transaction_date` is `z.string().regex(ISO_DATE_REGEX)` (`/^\d{4}-\d{2}-\d{2}$/`), `amount` is `z.number().nonnegative()`, `currency` is `z.string().length(3)`.
- `src/server/api/classify.ts` — registers `POST /api/accounts/:id/messages/:message_id/classify`. Validates URL params with `@hono/zod-validator` (numeric `:id`, non-empty `:message_id`).
- `src/server/api/ollama.ts` — registers `GET /api/ollama/health`.
- `src/client/components/OllamaHealth.tsx`, `src/client/components/ClassifyRowAction.tsx` — the two new client components.
- The corresponding `*.test.ts` / `*.test.tsx` files for every module above.
- `src/server/auth/invalid-grant.ts` — extracted helper (see "Refactors").

## Patterns to follow

The slice introduces a few new patterns; most reuse what Slices 002-004 already established.

- **Hono route registration via `registerXxxRoutes(app, deps?)`.** Same shape as `registerMessagesRoutes`, `registerDevRoutes`, `registerOauthRoutes`. The deps object exists so tests can inject fakes. For `registerClassifyRoutes`, the deps object holds `createGmailClient` (faked in tests) and `chatWithOllama` (a thin wrapper around `ollama.chat` so tests don't need to stub `globalThis.fetch` for the Ollama call — they replace the chat function wholesale). For `registerOllamaRoutes`, the dep is `listOllamaModels` (similarly stubbable).

- **`@hono/zod-validator` for path-param validation.** This is the first slice that adopts Zod. Pattern for path params:
  ```ts
  const paramsSchema = z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
    message_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  app.post('/api/accounts/:id/messages/:message_id/classify', zValidator('param', paramsSchema), async (c) => { ... })
  ```
  On validation failure `zValidator` returns 400 with Zod's error envelope; the client handles a generic non-2xx as "unexpected" so the chip says "Unexpected error: 400". Existing slices' API handlers don't use `zValidator` and don't need to be retrofitted (the spec calls this out explicitly: "Earlier slices' API handlers don't use `@hono/zod-validator`. Future slices can adopt it as needed; this slice does not retrofit earlier endpoints"). The error-shape mismatch (zValidator's `{ success: false, error: ... }` vs the rest of the API's `{ error: 'kebab-case-code', ... }`) is acceptable for path-param errors because they should be unreachable from the UI (the UI builds URLs from typed inputs).

- **Account-status preconditions identical to `messages.ts` and `dev.ts`.** The classify handler does the same five-line check that those two share: `findById` → 404 / 409 / `session.get` → 409 + status flip. This is the third caller — the duplication is the trigger Slice 004's review queued for extraction. Plan: extract into `src/server/auth/preconditions.ts` exporting `requireConnectedAccount(accountId): { ok: true; account } | { ok: false; status: number; body: ... }` so all three callers go through one path. **Decision flag for the review.** A lighter-touch alternative is to leave the duplication in place and only extract `isInvalidGrantError`; this slice picks the heavier extraction because the classify handler's path is otherwise pure orchestration and inlining the preconditions clutters the read.

- **Ollama HTTP client (`src/server/classify/ollama.ts`).** Plain `fetch` against `${ollamaUrl}/api/chat` and `${ollamaUrl}/api/tags`. No SDK — the [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md) is small enough that a 60-line client is clearer than a dependency. `chat({ model, messages, format, timeoutMs })`:
  - POST `${ollamaUrl}/api/chat` with body `{ model, messages, format, stream: false }`.
  - `format` is the literal string `'json'` per Ollama's docs (constrains output to a JSON value).
  - `messages` shape per Ollama: `[{ role: 'system', content: '...' }, { role: 'user', content: '...', images: ['<base64>', ...] }]`. Note `images` is an array of base64-encoded PNG strings (no data URL prefix), attached to the *message*, not interleaved into content blocks. (This is what Ollama documents and what `qwen2.5vl` actually consumes.)
  - `AbortController` with `setTimeout(() => ctrl.abort(), timeoutMs)`; on abort the fetch rejects with `AbortError` which the orchestrator translates to 503 `ollama_unreachable` (server-side: timeout ≈ unreachable).
  - Returns `response.message.content` as a string. Caller (`classify/index.ts`) is responsible for `JSON.parse` + Zod-validate — separation lets tests target either layer.
  - Errors: a non-2xx response body is read as text and thrown as `Error('ollama_http_<status>: <body>')`; a network error (DNS, ECONNREFUSED) is the `fetch` rejection.
  - `listModels()` does GET `${ollamaUrl}/api/tags` and maps `response.models[].name` to a string array. Same timeout handling but with a tighter cap (5 s — see "Risks") since the health badge can't tolerate 120 s waits.

- **Classification response Zod schema (`src/server/classify/schema.ts`).** The spec's response shape is the contract:
  ```ts
  export const classificationSchema = z.object({
    classification: z.enum(['invoice', 'receipt', 'other']),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string().min(1).max(2000),
    vendor: z.string().min(1).max(200).optional(),
    amount: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  export type Classification = z.infer<typeof classificationSchema>
  ```
  Plus `artifactSchema` for the response's `artifacts` array (`kind: 'body' | 'attachment', filename?, mime_type`) and a top-level `classifyResponseSchema` for the API endpoint's full body.

- **Body extraction (`src/server/classify/extract-body.ts`).** Pure function — no I/O, no Gmail client. Walks `gmail_v1.Schema$MessagePart` recursively. Rules:
  - If the part has `mimeType` starting with `multipart/`, recurse into `parts`.
  - For `text/plain` with body data: decode base64url to UTF-8 string. Prefer this over any sibling `text/html` (most receipt emails ship `multipart/alternative` with both, and the plain-text part is cleaner input for the model than HTML stripped of styles).
  - For `text/html` (only used if no `text/plain` was found): parse via `node-html-parser`'s `parse(html)`, take `root.text.replace(/\s+/g, ' ').trim()` for the plain-text projection. Set `html_was_used: true`.
  - Inline images are parts with `Content-Disposition: inline` and a `Content-ID` header (CID). Count them; do not resolve. Spec: "Inline images referenced via `cid:` are noted in the prompt metadata but not rendered in this slice; Slice 006's Playwright HTML→PDF path subsumes that case."
  - Returns `{ text, html_was_used, inline_image_count }`.
  - Empty body (no `text/plain` and no `text/html`) returns `{ text: '', html_was_used: false, inline_image_count: 0 }` — the orchestrator still calls Ollama with metadata and any attached images.

- **Attachment fetching pattern.** The orchestrator iterates `extractAttachmentMetadata(payload)` and, for each receipt-eligible attachment with `size <= MAX_ATTACHMENT_BYTES` (5 MB):
  - Calls `client.getAttachment(message_id, attachment_id)` → `{ data: Buffer, size }`.
  - For images: pass through as a single PNG buffer (re-encode if needed via `@napi-rs/canvas` — JPEG/WebP/GIF → PNG so the prompt builder has one consistent format). For Slice 005, the simpler rule is "send the original bytes unchanged when mime is `image/*`, base64-encode them, attach to the user message"; Ollama's vision pipeline accepts JPEG/PNG/GIF/WebP transparently. Re-encoding is unnecessary work this slice can skip.
  - For PDFs: call `renderPdfToImages(data, MAX_PDF_PAGES=5)` to get an array of PNG buffers.
  - Each resulting buffer becomes a base64-encoded entry in the Ollama `images` array.
  - Attachments over the size cap are skipped with a metadata note (`"<filename> (<size> bytes) — too large to include"`); the metadata note ends up in the prompt's user message so the model knows the file existed.
  - Non-receipt-eligible mime types (e.g. `application/zip`) are listed by name in the prompt metadata but not fetched.

- **PDF rendering (`render-pdf.ts`).** `pdfjs-dist` exposes `getDocument(...)`'s legacy/Node build at `pdfjs-dist/legacy/build/pdf.mjs`. The standard render API needs a canvas; `@napi-rs/canvas`'s `createCanvas(w, h)` returns a `Canvas` whose 2D context is API-compatible with the browser's. Pattern:
  ```ts
  import { createCanvas } from '@napi-rs/canvas'
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjsLib.getDocument({ data: pdfBytes, isEvalSupported: false }).promise
  const pageCount = Math.min(doc.numPages, maxPages)
  const out: Buffer[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1.5 }) // 1.5× for legibility
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    out.push(canvas.toBuffer('image/png'))
  }
  return out
  ```
  `isEvalSupported: false` disables `eval`-based font handling — recommended by `pdfjs-dist` for Node. Worker setup: `pdfjs-dist`'s legacy build doesn't need a worker for synchronous Node usage; if a worker setup error appears, set `pdfjsLib.GlobalWorkerOptions.workerSrc = ''` or import the worker entry. The plan validates this in the first PDF-rendering step.

- **Prompt structure (`prompt.ts`).** Returns:
  ```ts
  type OllamaMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string; images?: string[] }
  ```
  System content (TypeScript constant): describes the task, the strict JSON schema, the conservative-confidence preference ("if you are unsure, return `confidence: low`"), and the artifact list. User content: a multi-line string with metadata block (`Subject: ...`, `From: ...`, `Date: ...`, `Inline images: <count>`, `Attachments: <list with filename, mime, size, included/skipped>`, blank line, `Body:` then the extracted text). User images: array of base64-encoded PNG strings (one per attachment image, one per PDF page).

- **`POST /api/accounts/:id/messages/:message_id/classify` handler.** Sequence:
  1. Validate `:id` and `:message_id` via `zValidator('param', paramsSchema)`.
  2. Account/session preconditions via the new `requireConnectedAccount` helper.
  3. Wrap the entire pipeline in a try/catch.
  4. Call `classifyMessage({ account_id, message_id })` (the orchestrator).
  5. On success: respond 200 with `{ classification, confidence, reason, vendor?, amount?, currency?, transaction_date?, model_used, artifacts }`.
  6. On orchestrator-thrown errors: map to HTTP per spec. Custom error classes in `classify/errors.ts` (`OllamaUnreachableError`, `OllamaParseError`, `OllamaHttpError`) let the API layer pattern-match without inspecting messages.
  7. On invalid_grant from Gmail (caught via `isInvalidGrantError`): 401 `{ error: 'needs_reauth', account_id }`.
  8. On any other Gmail error: 502 `{ error: 'gmail_error', message }`.

  Error mapping table (spec-driven):
  - `OllamaUnreachableError` (network failure or AbortError) → 503 `{ error: 'ollama_unreachable' }`.
  - `OllamaParseError` (Zod validation failure or JSON.parse throw) → 502 `{ error: 'ollama_parse_error', raw_response: string }`.
  - `OllamaHttpError` (non-2xx from Ollama) → 502 `{ error: 'ollama_http_error', status: number, body: string }`.
  - `isInvalidGrantError(err)` → 401 `{ error: 'needs_reauth', account_id: id }`.
  - Other → 502 `{ error: 'gmail_error', message }`.

- **`GET /api/ollama/health` handler.** Calls `listOllamaModels()` with a tight timeout (5 s):
  - Network failure: respond 200 with `{ reachable: false, model: ollamaModel, model_available: false, error: 'unreachable: <message>' }`. Spec AC #8: returns within ~5 s even when Ollama is unreachable. The endpoint never returns non-200 — the badge needs a structured payload, not an HTTP error.
  - HTTP error from Ollama: respond 200 with `{ reachable: true, model: ollamaModel, model_available: false, error: 'http_<status>' }`.
  - Success: respond 200 with `{ reachable: true, model: ollamaModel, model_available: <names.includes(ollamaModel)> }`.

- **Account-status preconditions reuse.** `requireConnectedAccount(accountId): { ok: true; account: Account } | { ok: false; response: Response }` returns either the account row or a pre-built JSON response (the same 404 / 409 shapes that `messages.ts` and `dev.ts` produce today). The handler does `const result = requireConnectedAccount(id); if (!result.ok) return result.response`. **Decision flag for the review:** alternative is a Hono middleware via `app.use('/api/accounts/:id/*', ...)`, but the middleware would need to handle both the `:id` cast and route ordering carefully and the per-handler call site is two lines — middleware is overkill for two callers (after the extract, three).

- **Test seam for the orchestrator.** The orchestrator's external collaborators are: (a) the Gmail client (faked via the existing `setGmailFactoryForTest` machinery or via the deps-object pattern at the API layer), (b) the Ollama HTTP client (faked at the deps boundary in `registerClassifyRoutes`; or, for orchestrator unit tests, by injecting a `chat` function), (c) the PDF renderer (pure function — easy to test against a bundled tiny PDF fixture; alternatively stub at the orchestrator's deps boundary for handler-level tests).

- **Classify endpoint tests (`src/server/api/classify.test.ts`).** Pattern matches `messages.test.ts` and `dev.test.ts`: `mkdtempSync` + `setDbPathForTest` + `migrate` + `seedConnectedWithSession` + build the app with injected fake Gmail client and fake Ollama chat function. Cases:
  - 400 on non-numeric `:id`.
  - 400 on `:message_id` that fails the regex (forbidden char, too long).
  - 404 on unknown account.
  - 409 on `needs_reauth`.
  - 409 on connected-but-no-session (with the status flip).
  - 401 on `invalid_grant` from Gmail.
  - 502 on a generic Gmail error.
  - 503 when Ollama chat throws `OllamaUnreachableError`.
  - 502 on `OllamaParseError` (raw response in the body).
  - 200 happy path: fake Gmail returns a `text/plain`-only message with a known body; fake Ollama returns valid JSON; response is `{ classification: 'receipt', confidence: 'high', reason, model_used: 'qwen2.5vl:7b', artifacts: [{ kind: 'body', mime_type: 'text/plain' }] }`.
  - 200 happy path with PDF attachment: fake Gmail returns a message with a PDF attachment; fake `getAttachment` returns a 4 KB PDF fixture; fake Ollama returns valid JSON; response `artifacts` includes one `{ kind: 'attachment', mime_type: 'application/pdf', filename: 'invoice.pdf' }`.
  - 200 happy path with HTML-only body: response `artifacts` includes `{ kind: 'body', mime_type: 'text/html' }`.
  - **No DB writes:** before and after each test, `processed_messages.countForAccount({ account_id: id }) === 0`. AC #6 verified at the unit-test layer.

- **Orchestrator tests (`src/server/classify/index.test.ts`).** Direct unit tests against `classifyMessage(...)` with stubbed Gmail + Ollama. Same shape as the API tests minus the HTTP layer; one or two cases overlap intentionally to keep both layers honest.

- **Ollama client tests (`src/server/classify/ollama.test.ts`).** Stub `globalThis.fetch` with a `vi.spyOn(globalThis, 'fetch').mockImplementation(...)`. Cases:
  - `chat` POSTs the right URL, body, headers; returns `response.message.content`.
  - `chat` aborts on timeout; the rejection propagates.
  - `chat` throws `OllamaHttpError` on non-2xx with the body payload attached.
  - `listModels` returns names from `response.models[].name`.
  - `listModels` returns `[]` on an empty `models` array.

- **Schema tests (`src/server/classify/schema.test.ts`).** `parse` accepts the spec's documented shape; rejects out-of-enum values; `transaction_date` rejects non-ISO; `amount` rejects negative; `currency` rejects 4-letter strings.

- **Body extractor tests (`src/server/classify/extract-body.test.ts`).** Fixtures: pure `text/plain` payload; pure `text/html` payload; `multipart/alternative` (text + html — text wins); nested `multipart/mixed` containing `multipart/alternative` plus an attachment; payload with inline image (`Content-Disposition: inline`, `Content-ID: <foo>`) — count goes up.

- **Attachment-extractor tests (`src/server/classify/extract-attachments.test.ts`).** Fixture: `multipart/mixed` with one `application/pdf`, one `image/png`, one `application/zip` (non-eligible), one inline image (skipped — has Content-Disposition: inline). Assert the eligible list.

- **PDF render tests (`src/server/classify/render-pdf.test.ts`).** Use a tiny PDF fixture (one or two pages, generated once and committed under `src/server/classify/__fixtures__/sample.pdf`). Assert: `renderPdfToImages` returns N PNG buffers; each buffer starts with the PNG magic bytes (`\x89PNG\r\n\x1a\n`); `max_pages: 1` returns one buffer even from a 2-page PDF. **Risk-flagged below:** `pdfjs-dist`'s legacy/Node build sometimes needs `eval` disabled and `standardFontDataUrl` set; the plan iterates if the first import fails.

- **Prompt tests (`src/server/classify/prompt.test.ts`).** Pure-function output: assert the system message contains the JSON-schema description and the conservative-confidence instruction; the user message contains `Subject: ...`, `From: ...`, the body text, and a "Inline images: N" line; the `images` array has the right length.

- **Ollama health endpoint tests (`src/server/api/ollama.test.ts`).** Three cases — reachable + model present, reachable + model absent, unreachable — each with the corresponding response body and 200 status.

- **Client tests (`OllamaHealth.test.tsx` and `ClassifyRowAction.test.tsx`).** Stub `fetch`. Cases for health:
  - Initial load shows "loading…" then renders ready / not-pulled / unreachable.
  - 30 s polling: spec calls for it; tested via `vi.useFakeTimers` and advancing 30 s, asserting a second fetch.
  - The component uses `setInterval`; cleanup on unmount.

  Cases for classify-row-action:
  - Initial render: shows "Classify" button.
  - Click → POST → spinner → renders verdict pill + confidence + reason.
  - Click → POST → 503 → renders "Ollama unreachable" chip + Retry button.
  - Click → POST → 502 with `ollama_parse_error` → renders parse-error chip with the raw response in a `<details>` block.
  - Click → POST → 401 → renders "Account needs reconnect" chip.
  - Retry click after error: re-issues POST.

- **Inbox + Dashboard view tests.** Extend `Inbox.test.tsx` to assert each row's last column contains a Classify button. Extend `Dashboard.test.tsx` to assert `<OllamaHealth />` renders (the badge text is fine to assert via a substring match on "Ollama").

## Refactors needed before adding the new feature

Three small ones, none big enough to be a separate slice:

- **Extract `isInvalidGrantError` to `src/server/auth/invalid-grant.ts`.** Slice 003's review flagged this; Slice 004's review flagged it again ("Slice 005 or 006 cleanup"). This slice is the third caller (`messages.ts`, `dev.ts`, the new `classify.ts`). Move the helper, add one test file (`invalid-grant.test.ts`) covering the message-substring path and the response.data.error path, replace the in-file definitions with imports. Existing tests stay green.

- **Extract account-status preconditions to `src/server/auth/preconditions.ts`.** The `findById` → 404 / 409 / `session.get` → 409-with-status-flip dance is duplicated in `messages.ts` and `dev.ts`. The classify handler is the third caller. Export `requireConnectedAccount(id): { ok: true; account } | { ok: false; status: number; body: object }`. Update the two existing call sites; add a new test file covering all five branches; remove the duplication in the existing handlers' tests (they still test the 404 / 409 paths via the API surface, which is the right level). **Decision flag:** alternative is to leave the duplication and only do the `isInvalidGrantError` extract. Plan picks the heavier extract because three duplications is the conventional bar for promoting a helper, and the classify handler's body is otherwise long enough that inlining the preconditions hurts readability.

- **Add `ollamaUrl`, `ollamaModel`, `ollamaTimeoutMs` to `src/server/config.ts`.** Three new frozen fields with defaults from the spec. Tests via `config.test.ts` cover defaults + env overrides + NaN fallback for the timeout. Justification: same reason `nodeEnv` lives in `config.ts` rather than being read inline — the handlers stay testable via `vi.resetModules()` + mutating `process.env` in `beforeEach`.

Two refactors deliberately *not* done in this slice:

- **Promote the `gmailFactory` test seam to a deps-object pattern.** `src/server/gmail/client.ts` currently uses module-level state (`setGmailFactoryForTest`). The pattern is established and Slice 005 doesn't substantially benefit from changing it — the new `getAttachment` method uses the same factory. Flagged as a follow-up.

- **Move `accounts.ts` from `src/server/auth/` to `src/server/db/repositories/`.** Slice 004's review queued this; this slice continues to defer it because moving touches every importer for no current functional gain.

## Risks and open questions

- **`pdfjs-dist` Node import path.** The package exposes multiple builds: `pdfjs-dist/build/pdf.mjs` (browser-only), `pdfjs-dist/legacy/build/pdf.mjs` (cross-env, what the orchestrator imports). Some versions split the Node entry differently. The plan validates the import in the first PDF step; if the legacy entry doesn't load under our Node version, fall back to the package's documented Node bootstrap. There's also a worker concern — without `GlobalWorkerOptions.workerSrc` set, recent pdfjs-dist versions warn but still render synchronously; the plan suppresses the warning by setting it to a no-op string. **Risk-mitigation:** the first PDF-render test is a smoke gate; if `pdfjs-dist` requires structural setup beyond what's described here, the plan documents the actual incantation.

- **`@napi-rs/canvas` native-binary support.** Ships prebuilt binaries for `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`. The devcontainer's base image is `linux-x64-gnu` (Debian-based), supported. On apple-silicon hosts the user runs the devcontainer under Rosetta or the `arm64` variant — both are supported. **Risk:** if the install pulls a binary mismatched with the container's libc (musl vs glibc), the import fails. Plan: `npm install` in step 1 of the plan validates this; if it fails, switch to a sibling package or a pure-JS fallback. The package is the project's first native binary beyond `better-sqlite3`, which already builds against the same platform set.

- **Ollama reachability from the devcontainer.** The spec says `OLLAMA_URL=http://host.docker.internal:11434` and notes this is the first slice that exercises the `extra_hosts` entry from Slice 001's `docker-compose.yml`. That `docker-compose.yml` was deleted in the Dec 9 devcontainer migration. The devcontainer's `runArgs` does **not** include `--add-host=host.docker.internal:host-gateway` — meaning `host.docker.internal` may not resolve inside the devcontainer on Linux hosts. On Mac/Windows Docker Desktop resolves it natively; on Linux the user falls back to `OLLAMA_URL=http://172.17.0.1:11434` (the default Docker bridge gateway) or an explicit `--add-host`. The smoke test step that exercises Ollama documents both options. **Open question:** restore a `docker-compose.yml` for the smoke step, or document the `OLLAMA_URL` override? The slice picks "document the override" — restoring `docker-compose.yml` is a separate concern (and Slice 004 already declined to restore it). Flag for the review.

- **Synchronous endpoint with 120 s timeout.** First in the codebase. Hono runs on `@hono/node-server`'s default keep-alive; a single connection held for 2 minutes should be fine for a localhost single-user tool. If the browser's default fetch timeout (varies by browser, often unlimited but spinner ergonomics suffer) becomes a UX issue, the spec's followup is "Slice 006 moves batch work to SSE; one-off classify stays synchronous." Not a Slice 005 concern.

- **Vision model variance.** `qwen2.5vl:7b` is the spec's default. The model's adherence to the strict JSON schema is empirically good but not guaranteed; the spec accounts for parse errors via the 502 path. The acceptance criteria require receipt-shaped emails to return `receipt` with `high`/`medium` confidence — this depends on the model's quality on the user's actual messages and is verified at smoke time, not at unit-test time. **Risk-mitigation:** the prompt's "if unsure, return low" instruction shifts the failure mode from "false confident classification" to "human review needed", which matches `architecture.md` § "Classification module"'s conservative-confidence preference.

- **`size` from `users.messages.attachments.get`.** The Gmail API returns `size` in the attachment-fetch response (it's also present in the message metadata). The wrapper exposes it from the GET response. The orchestrator's pre-fetch size check uses the metadata-side `size` (so we skip without paying the bandwidth); the post-fetch `size` is a sanity check that should equal the metadata.

- **Base64url decoding.** Gmail's API returns attachment data as base64url (RFC 4648 §5: `-` and `_` instead of `+` and `/`, no padding). `Buffer.from(data, 'base64url')` (Node ≥ 16) handles this directly — no manual replace needed. Plan uses the canonical form.

- **Memory pressure.** A 5 MB PDF rendered at 1.5× scale to 5 PNGs can occupy tens of MB in heap. The orchestrator processes one message at a time and the PNG buffers are in-scope only for the duration of the chat call; GC collects them between requests. Concurrent classify clicks would multiply the footprint. The spec doesn't ask for a concurrency limit; this is acceptable for a single-user localhost tool. Flag for the review if memory becomes an issue.

- **`format='full'` payload size.** Gmail returns the full message (headers + body parts + attachment metadata, but not attachment bytes). Sizes are typically <1 MB; large messages (multi-MB inline images, very long bodies) can be larger. The spec's implementation note: "No hard cap on Gmail's payload response — the client trusts Gmail's API to be robust." Plan honors this; outsized payloads surface as Ollama timeout / memory errors and are tunable later.

- **Ollama chat API shape: `images` on the message vs as content blocks.** The Ollama chat API ([docs](https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-images)) takes `images: [base64, ...]` as a sibling field of `content` on the message, not as multimodal content blocks. The plan honors this. (The spec text "each image as a base64-encoded `image` content block" reads as content-block style; in implementation it's the message-level `images` array — Ollama's wire format. The semantic is identical: the model sees the images alongside the text. Flag for the review as a wording-vs-implementation mismatch.)

- **`@hono/zod-validator` version compatibility.** Hono 4.6 + `@hono/zod-validator` ≥ 0.4 + `zod` ≥ 3.23. The plan pins compatible versions in `package.json`; CI catches a mismatch via the typecheck step.

- **Build-time check still passes.** `getAttachment` calls `users.messages.attachments.get`. The substring guard's forbidden list does not include `attachments.get`. The plan's first verification is `npm run check:gmail-readonly` after the wrapper edit. No code change to the guard.

- **No ADR needed?** Re-checking the bar:
  - **Library choices (`pdfjs-dist`, `@napi-rs/canvas`, `node-html-parser`, `zod`, `@hono/zod-validator`):** the spec explicitly names them as deliverables. `architecture.md` § "Tech stack" already names Zod + `@hono/zod-validator` and PDF preview via `react-pdf` (client-side). The server-side PDF→images choice (`pdfjs-dist` + `@napi-rs/canvas`) is a real cross-roads that future specs / future-you may want to revisit. **Plan: write ADR-004 — "Server-side PDF rendering via pdfjs-dist + @napi-rs/canvas".** Justifies the no-system-deps tradeoff vs alternatives (poppler/pdftocairo, mupdf, GraphicsMagick) and the Slice 006 successor (Playwright, used for HTML→PDF, could in principle also do PDF→images).
  - **Synchronous classify endpoint:** spec calls it out as the design choice ("First synchronous long-running endpoint in the codebase"). `architecture.md` § "Components — Gmail sync handler" mentions SSE for batch progress. The synchronous-vs-streaming choice for the per-message endpoint is real. **Plan: write ADR-005 — "Synchronous per-message classify endpoint with long timeout".** Documents why the one-message case skips SSE and the consequences (browser keep-alive, blocked-row UX).
  - **Ollama HTTP client without an SDK:** routine implementation choice. No ADR.
  - **Prompt copy in TypeScript:** a trade-off the spec calls out. `architecture.md` is silent on prompt management. **Plan: write ADR-006 — "Classification prompt as a TypeScript constant".** Documents why the prompt isn't a separate file / DB row / env var, and the consequences for tuning iterations.
  - **Conservative-confidence prompt instruction:** spec restates `architecture.md`'s preference. No ADR — it's a re-statement.
  - **No persistence in this slice:** spec's Out-of-scope. No ADR.
  - **`isInvalidGrantError` extract / `requireConnectedAccount` extract:** routine refactors. No ADR.

  Net: three ADRs introduced (PDF rendering, synchronous endpoint, prompt-in-TypeScript). Each is one or two pages.

- **Browser keep-alive on a 120 s response.** Modern browsers typically don't time out, but corporate network appliances might cut idle TCP after ~60 s. Localhost-only deployments don't pass through such proxies; this is a non-issue for v1.

- **`AbortController` cleanup.** The 120 s `setTimeout` must be cleared when the fetch resolves (otherwise a pending timer keeps the event loop alive briefly). The plan's Ollama client uses `try { ... } finally { clearTimeout(t) }`.

- **Gmail attachment-id stability.** `attachment_id` is per-message and not stable across messages. The orchestrator extracts it from the metadata walk and immediately uses it; no caching. Standard usage; no risk.

- **MIME tree edge cases.** `multipart/related` (HTML + inline images), `multipart/signed` (S/MIME), `multipart/encrypted` (S/MIME) — the body extractor's recursion handles `multipart/*` uniformly (recurse into `parts`). For `multipart/signed`, the body is the first part; for `multipart/encrypted`, the body is opaque (no plaintext). The classifier sees an empty body for encrypted messages and returns `other` based on metadata alone — acceptable for v1.

- **`subject` and `from` extraction for the prompt.** Reuse `extractHeader` from `src/server/gmail/headers.ts` (Slice 004 promoted it). The orchestrator uses `extractHeader(message, 'Subject')`, `extractHeader(message, 'From')`, `extractHeader(message, 'Date')`. No new helper needed.

- **PDF page cap interpretation.** "5 pages" means up to 5 PNG buffers per PDF. If a PDF has 50 pages, the model sees pages 1-5. The spec accepts this for receipt-classification purposes.

- **Test fixture for PDFs.** Generating a real PDF inside a test would require pulling in `pdfkit` or similar — adding test-time deps for one fixture is overkill. The plan commits a tiny pre-generated PDF (`__fixtures__/sample.pdf`, ~3 KB, two pages) under the test directory. Justification matches the spec's "the fixture is the test contract" approach.

- **Zod adoption breadth.** This slice adds Zod to runtime deps and uses it for path-param validation and Ollama response parsing. It does **not** retrofit existing endpoints (per spec). The follow-up (audit / replay endpoints in Slice 010 / 014) can adopt Zod incrementally.

## Test strategy

Following the loop's "TDD where applicable" rule. Server tests under `src/server/...` (vitest workspace `server`, Node env), client tests under `src/client/...` (vitest workspace `client`, jsdom + RTL). New tests slot into the existing vitest setup with no harness changes.

**Unit tests planned (vitest, Node env):**

- `src/server/config.test.ts` — three new cases:
  - `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` defaults applied when env unset.
  - Env overrides take effect.
  - `OLLAMA_TIMEOUT_MS=banana` falls back to the default 120000.

- `src/server/gmail/client.test.ts` — extend with `describe('getAttachment', …)`:
  - Calls `users.messages.attachments.get` with `{ userId: 'me', messageId, id: attachmentId }`.
  - Decodes base64url payload to a Buffer; asserts `data` is a Buffer with the expected bytes.
  - Returns `size` from the API response.
  - Surfaces network errors verbatim (no swallow).

- `src/server/auth/invalid-grant.test.ts` (new file from refactor):
  - `Error('invalid_grant: …')` returns true.
  - `{ response: { data: { error: 'invalid_grant' } } }` returns true.
  - Plain `Error('something else')` returns false.
  - `null`, `undefined`, plain string return false.

- `src/server/auth/preconditions.test.ts` (new file from refactor):
  - Unknown account → `{ ok: false, status: 404, body: { error: 'account_not_found' } }`.
  - Account in `needs_reauth` → 409 with status in body.
  - Account `connected` but no session → 409 with status flipped to `needs_reauth` in DB and in body.
  - Account `connected` with session → `{ ok: true, account }`.

- `src/server/classify/schema.test.ts`:
  - Valid spec-shape parses.
  - `classification: 'spam'` rejects.
  - `confidence: 'ultra'` rejects.
  - `transaction_date: '2026-13-99'` rejects (regex shape only — invalid month/day pass; spec says regex, not date validity).
  - Negative `amount` rejects.
  - 4-letter `currency` rejects.
  - Optional fields: omitting `vendor` / `amount` / `currency` / `transaction_date` is fine.

- `src/server/classify/extract-body.test.ts`:
  - Pure `text/plain` → text returned, `html_was_used: false`, `inline_image_count: 0`.
  - Pure `text/html` → text returned (extracted via `node-html-parser`), `html_was_used: true`.
  - `multipart/alternative` (text + html) → text wins, `html_was_used: false`.
  - Nested `multipart/mixed` → recurses into `multipart/alternative`, picks text.
  - Inline image (`Content-Disposition: inline`, `Content-ID: <foo>`) → `inline_image_count: 1`.
  - Missing body data → `text: ''`, no throw.

- `src/server/classify/extract-attachments.test.ts`:
  - `multipart/mixed` with one PDF, one PNG, one ZIP, one inline image → returns 3 attachments (PDF, PNG, ZIP) with the inline image excluded; `receipt_eligible` is `[PDF, PNG]`.
  - Empty / single-part message → `[]`.
  - Attachment without `attachmentId` (rare; e.g. zero-byte) → skipped or returned with `attachment_id: null` (TBD in plan).

- `src/server/classify/render-pdf.test.ts`:
  - `renderPdfToImages(twoPagePdf, 5)` returns 2 PNG buffers; each starts with PNG magic.
  - `renderPdfToImages(twoPagePdf, 1)` returns 1 PNG buffer.
  - `renderPdfToImages(corruptedBytes, 5)` throws (the orchestrator catches and includes a metadata note instead of crashing).

- `src/server/classify/prompt.test.ts`:
  - System message contains the JSON-schema description.
  - System message contains the "if unsure, return low" instruction.
  - User content includes `Subject: ...`, `From: ...`, `Inline images: N`, `Attachments: ...`, body text.
  - `images` array length matches the sum of attachment images + PDF pages.

- `src/server/classify/ollama.test.ts`:
  - `chat` POSTs the right URL, body shape, headers; returns `response.message.content`.
  - `chat` honors `timeoutMs` via AbortController; rejection is the AbortError.
  - `chat` throws `OllamaHttpError` on a 500 response with the body attached.
  - `chat` throws an unwrapped `fetch` rejection on network failure (orchestrator wraps it in `OllamaUnreachableError`).
  - `listModels` returns names; empty `models` → `[]`.

- `src/server/classify/index.test.ts` (orchestrator):
  - Happy path with text/plain body and no attachments → calls Ollama once with the right messages; returns the parsed response + `model_used` + `artifacts: [{ kind: 'body', mime_type: 'text/plain' }]`.
  - With one PDF attachment → calls `getAttachment` once; calls `renderPdfToImages` once; the resulting images are in the prompt; `artifacts` includes `{ kind: 'attachment', mime_type: 'application/pdf', filename }`.
  - With one too-large attachment (>5 MB) → does not fetch; metadata note in the prompt; not in `artifacts`.
  - With ZIP attachment → not fetched; metadata note in the prompt; not in `artifacts`.
  - HTML-only body → `html_was_used: true` reflected as `artifacts` `{ kind: 'body', mime_type: 'text/html' }`.
  - Ollama `OllamaUnreachableError` propagates.
  - Ollama returns malformed JSON → orchestrator throws `OllamaParseError` with the raw response.
  - Ollama returns JSON failing the Zod schema → orchestrator throws `OllamaParseError`.

- `src/server/api/classify.test.ts` (HTTP layer): cases listed under "Classify endpoint tests" above.

- `src/server/api/ollama.test.ts`:
  - Reachable + model present → 200 `{ reachable: true, model: 'qwen2.5vl:7b', model_available: true }`.
  - Reachable + model absent → 200 `{ reachable: true, model_available: false }`.
  - Unreachable → 200 `{ reachable: false, model_available: false, error: 'unreachable: ...' }`.
  - Endpoint returns within 5 s on unreachable (use `vi.useFakeTimers` or assert on the abort path).

**Client tests planned (vitest, jsdom env, `@testing-library/react`):**

- `src/client/components/OllamaHealth.test.tsx` (new):
  - Initial render: "Loading Ollama status…".
  - After fetch returns `{ reachable: true, model_available: true }` → renders "Ollama: qwen2.5vl:7b ready" with a green pill class.
  - After fetch returns `{ reachable: true, model_available: false }` → renders the yellow "model not pulled" line including the `ollama pull` hint.
  - After fetch returns `{ reachable: false }` → renders the red "Ollama unreachable" message including the URL.
  - After 30 s (`vi.useFakeTimers`), a second fetch is issued.
  - Cleanup on unmount (no warning about state set after unmount).

- `src/client/components/ClassifyRowAction.test.tsx` (new):
  - Initial render: "Classify" button enabled.
  - Click → POST issued with the right URL → spinner shown → success response renders verdict pill, confidence label, reason text.
  - Click → 503 → renders "Ollama unreachable" chip + "Retry" button. Retry click re-issues POST.
  - Click → 502 with `{ error: 'ollama_parse_error', raw_response }` → renders parse-error chip and surfaces `raw_response` in a `<details>` block.
  - Click → 401 → renders "Account needs reconnect" chip with a link to Dashboard.
  - Component-local state: navigating away (unmount) clears state — covered by cleanup test.

- `src/client/views/Inbox.test.tsx` — extend:
  - Each rendered row contains a Classify button.
  - Existing subject/sender/date assertions stay green.

- `src/client/views/Dashboard.test.tsx` — extend:
  - The Dashboard renders `<OllamaHealth />`. Use a `/api/ollama/health` mock returning the ready state; assert the pill text appears in the document.

**Integration tests:** the `app.fetch` pattern carries through. The new `classify.test.ts` and `ollama.test.ts` exercise routes against the real DB plus injected fakes; that's the integration boundary. No new harness needed.

**Smoke test outline (manual, run by priority 5):**

1. `git status` clean. From the devcontainer, ensure `npm install` has pulled the five new deps. `npm run check:gmail-readonly` exits 0. `npm run typecheck` exits 0.
2. Confirm Ollama is reachable from the devcontainer: `curl -s ${OLLAMA_URL:-http://host.docker.internal:11434}/api/tags`. If 404 or connection refused, document the override (`OLLAMA_URL=http://172.17.0.1:11434` on Linux; restart `npm run dev`).
3. `ollama pull qwen2.5vl:7b` on the host if not already pulled.
4. `npm run dev` (server + Vite). Open `http://localhost:5173/` in the host browser. The Dashboard shows the Ollama health badge as **green** ("Ollama: qwen2.5vl:7b ready").
5. **Health-badge unreachable case (AC):** stop Ollama on the host (`ollama stop` or quit the app). Within 30 s the badge flips to **red** ("Ollama unreachable at …"). The rest of the page remains usable (account list, Inbox link). `curl -s http://localhost:3737/api/ollama/health` returns 200 with `{ reachable: false, ... }` within ~5 s.
6. **Health-badge model-not-pulled case (AC):** restart Ollama; `ollama rm qwen2.5vl:7b` (carefully — only if you can re-pull); refresh Dashboard. Badge flips to **yellow** with the `ollama pull` instruction. Re-pull and refresh: badge returns to green.
7. Navigate to `/inbox` and pick a connected account with real receipts. Each row has a "Classify" button.
8. **Classify a real receipt (AC):** click Classify on a Stripe / vendor invoice row. Spinner spins for ~5-30 s. Row inline-shows `receipt` (or `invoice`) with `high` / `medium` confidence and a short reason.
9. **Classify a normal email (AC):** click Classify on a personal email or newsletter. Returns `other` with any confidence.
10. **Classify a PDF-attachment receipt (AC):** click Classify on a row whose email has a PDF attachment. The response (visible via the chip's expanded reason or via DevTools' Network panel) shows `artifacts: [{ kind: 'attachment', mime_type: 'application/pdf', filename: '...' }]`.
11. **Classify an HTML-body-only receipt (AC):** click Classify on a row whose email has only an HTML body. Response `artifacts` includes `{ kind: 'body', mime_type: 'text/html' }`.
12. **Ollama-unreachable mid-classify (AC):** stop Ollama; click Classify on any row. Within ~120 s (or sooner if AbortController fires) the chip shows `Ollama unreachable` with a Retry button. Other UI continues to function.
13. **Parse-error path (AC):** if a debugging proxy is available, route `OLLAMA_URL` through it and have it return malformed JSON. Click Classify. Chip shows the parse-error message with the raw response in a `<details>` block. (Optional smoke step — pinned at the unit-test layer regardless.)
14. **No DB writes (AC):** before clicking Classify, `sqlite3 data/app.db "SELECT COUNT(*) FROM processed_messages;"` returns N. After 5 successful Classify clicks, the count is still N.
15. **Build-time guard (AC):** `npm run check:gmail-readonly` exits 0 after the `gmail/client.ts` modification. Already verified in step 1; re-confirm.
16. **OAuth scopes unchanged (AC):** `grep -r "gmail\." src/ | grep -v ".test."` should match only `gmail.readonly`. (The slice introduces no new scope substring; this is a regression check.)
17. **Health endpoint timeout (AC):** with Ollama unreachable (step 5), `time curl -s http://localhost:3737/api/ollama/health` returns within ~5 s.
18. `git status` clean.

Smoke steps 5-13 cover the spec's nine acceptance criteria; steps 1-4 are environmental setup; steps 14-17 are the regression / property checks; step 18 confirms a clean working tree before priority 6 writes the review.
