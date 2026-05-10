# Slice 006: Sync and store receipts — Research

**Spec:** `docs/specs/006-sync-and-store-receipts.md`

## Summary of what the spec asks for

Slice 006 turns Slice 005's per-message classify pipeline into a real sync orchestrator: `POST /api/sync` discovers messages (Gmail History API or date-range search), classifies each one through `classifyMessage`, and persists receipt/invoice artifacts both as files under `./invoices/{account_slug}/{yyyy}/{mm}/...` and as rows in a new `documents` table. Headline deliverables: a new SQLite migration (`0005_create_documents.sql`) with `(account_id, content_hash)` unique constraint for hard dedup; five new API endpoints (`POST /api/sync`, `GET /api/sync/events` SSE, `GET /api/sync/status`, `GET /api/accounts/:id/documents`, `GET /api/documents/:id/file`); a new sync orchestrator with in-memory mutex and SSE event emitter (~200-event ring buffer); a `files.ts` write wrapper with path-traversal guard and filename sanitization; HTML→PDF rendering via Playwright (the slice's first browser dep); two new Gmail client methods (`historyList`, `getProfile`); a `<SyncControls />` Dashboard component; and a wholesale data-source replacement of the Inbox view (DB-backed `documents` instead of live Gmail metadata read-through). Removes Slice 004's dev seed surface (`DevSeedPanel.tsx`, `dev.ts`, `processed_messages.ts` route) and Slice 005's per-row classify surface (`ClassifyRowAction.tsx`, `classify.ts` route).

## Existing code that this spec touches

Post-Slice-005 state:

- `src/server/db/migrations/` — Slices 002 / 004 produced 0001-0004. **Add 0005**. The bare-SQL runner from ADR-002 picks up the new file unchanged. The migration introduces `documents`, two indices, and the `(account_id, content_hash)` UNIQUE constraint.
- `src/server/db/index.ts` — WAL + foreign-keys-on (Slice 004). **No change.**
- `src/server/db/repositories/processed_messages.ts` — `existsForMessage`, `insert`, `listForAccount`, `countForAccount`. **Reused as-is**: the orchestrator's per-message transaction calls `existsForMessage` for idempotency and `insert` for the audit row. The "latest attempt per message" JOIN in the Inbox listing wants a method like `findLatestForMessages(account_id, message_ids[])`; the cleanest path is a SQL query in `documents.ts`'s listing rather than extending `processed_messages.ts`. **Decision flagged.**
- `src/server/db/repositories/sync_state.ts` — `get(account_id)` and `upsert(...)`. **Reused as-is** for `last_history_id` / `last_synced_at`.
- `src/server/auth/accounts.ts` — `findById`, `list`, `findBySlug`, `updateStatus`, `touchLastSeen`. **Reused as-is**. The orchestrator iterates `list()` filtered to `status='connected'`, looks up `slug` per account for the file-store path, and flips `status='needs_reauth'` on token errors via `updateStatus`.
- `src/server/auth/preconditions.ts` (Slice 005) — `requireConnectedAccount`. **Reused** by `GET /api/accounts/:id/documents` for the path-param/account check.
- `src/server/auth/invalid-grant.ts` (Slice 005) — `isInvalidGrantError`. **Reused** by the orchestrator's per-account error mapping.
- `src/server/gmail/client.ts` — `listMessages`, `getMessage`, `getAttachment` (Slice 005). **Modify here** to add `historyList({ start_history_id, history_types?, page_token? })` (wraps `users.history.list`) and `getProfile()` (wraps `users.getProfile`). Both endpoints are read-only; the substring guard's forbidden list does not include either. The `listMessages` method already accepts a `q` parameter; the orchestrator passes `q='after:YYYY/MM/DD'` for the date-range fallback path. Slice 005's `getAttachment` is reused for re-fetching attachment bytes during persistence (see "Risks" — the bytes need to flow from the Slice 005 pipeline into the orchestrator's file-write step, which means either re-fetching or extending `classifyMessage`'s return type).
- `src/server/classify/index.ts` (Slice 005) — `classifyMessage(args, deps): Promise<ClassifyResponse>`. **The orchestrator must reuse this** but also needs the source bytes to write to disk after a positive verdict. Two paths: (a) call `classifyMessage` then re-fetch attachments via `getAttachment` for persisted artifacts (one extra round-trip per artifact); (b) refactor `classifyMessage` to also return the source bytes per artifact. The spec says "Run the classification pipeline (Slice 005's `classifyMessage`)" — implying black-box reuse. But re-fetching costs Gmail quota and an extra second per attachment. **Decision flagged**: prefer extending `classifyMessage`'s return type with an optional `source_bytes: Map<key, Buffer>` field that tests/Slice 010 can ignore. This keeps the API additive (Slice 005's tests stay green) and avoids re-fetching.
- `src/server/classify/extract-body.ts`, `extract-attachments.ts`, `prompt.ts`, `ollama.ts`, `render-pdf.ts`, `schema.ts` — Slice 005's pipeline pieces. **Reused unchanged** through `classifyMessage`. The body extractor's `html_was_used` flag is what the orchestrator checks to decide whether to render the body to PDF (Slice 005 only counted inline images; this slice acts on the projection).
- `src/server/classify/__fixtures__/sample.pdf` (Slice 005) — small 2-page PDF; **reusable** for any sync orchestrator test that needs an attachment fixture.
- `src/server/api/messages.ts` (Slice 003) — `GET /api/accounts/:id/messages`. **No change** the spec calls for; this endpoint stays alive even though the Inbox no longer uses it (it remains useful for debugging and may be retained as a dev helper or removed later — the spec doesn't say). Net: leave it.
- `src/server/api/dev.ts`, `src/server/api/processed_messages.ts` (Slice 004) — both **removed** by this slice along with their tests, `src/client/views/DevSeedPanel.tsx`, and `src/client/views/DevSeedPanel.test.tsx`. The corresponding URL-routed `/api/dev/enabled` mock in `Dashboard.test.tsx` also goes away.
- `src/server/api/classify.ts`, `src/client/components/ClassifyRowAction.tsx` (Slice 005) — both **removed**. `src/server/classify/index.ts` (the orchestrator's `classifyMessage`) stays — sync orchestrator uses it; Slice 010 will also use it for single-row reclassify. The `classify.test.ts` and `ClassifyRowAction.test.tsx` files go too.
- `src/server/api/ollama.ts` — Slice 005's health endpoint. **No change**.
- `src/server/app.ts` — `createApp()` registers the route chain. **Edit here** to register `registerSyncRoutes(app, deps)` and `registerDocumentsRoutes(app, deps)`, and to remove `registerDevRoutes`, `registerProcessedMessagesRoutes`, `registerClassifyRoutes`. Five lines of register-calls churn.
- `src/server/config.ts` — frozen config. **Add** `syncDefaultWindowDays` (default 30, env `SYNC_DEFAULT_WINDOW_DAYS`), `maxConcurrentClassify` (default 1, env `MAX_CONCURRENT_CLASSIFY`), and `invoicesDir` (default `./invoices`, no env override planned but useful for tests). Five new lines + tests in `config.test.ts`.
- `src/server/index.ts` — server entrypoint. **Edit here** to ensure `./invoices/` (resolved from `config.invoicesDir`) exists at startup; mirrors the existing `mkdirSync(dirname(resolve(config.dbPath)), { recursive: true })` pattern.
- `src/client/views/Inbox.tsx` — Slice 003's live-Gmail Inbox extended with the Slice-005 Classify column. **Wholesale data-source replacement**: switch from `GET /api/accounts/:id/messages` to `GET /api/accounts/:id/documents?limit=50&offset=0`; columns become Vendor / Amount + Currency / Transaction Date / Subject / Sender Domain / Created At / Preview link. The account-picker scaffolding stays. The localStorage-keyed last-account selection (`LAST_INBOX_ACCOUNT_KEY`) stays. The `<ClassifyRowAction>` in the Classify column is dropped (the component is being deleted).
- `src/client/views/Inbox.test.tsx` — every test rewrites because the data source changed; the existing tests' assertions on subjects / senders / Classify buttons no longer apply. The localStorage-based picker behaviors are still meaningful and re-tested against the new data shape.
- `src/client/views/Dashboard.tsx` — Slice 004 added DevSeedPanel; Slice 005 added the Ollama badge. **Edit here** to remove `<DevSeedPanel />` and add `<SyncControls />`. The `<OllamaHealth />` placement stays.
- `src/client/views/Dashboard.test.tsx` — every URL-routed `mockImplementation` that includes `/api/dev/enabled` updates: the dev-enabled fall-through case goes away, replaced by a `/api/sync/status` mock returning `{ active: false }`. The "renders DevSeedPanel" test is deleted.
- `src/client/components/AccountList.tsx`, `AccountPicker.tsx`, `Nav.tsx`, `AddAccountButton.tsx` — **No change.**
- `src/client/components/OllamaHealth.tsx` (Slice 005) — **No change.**
- `src/client/components/ClassifyRowAction.tsx` (Slice 005) — **deleted** (its endpoint is also deleted). The Inbox no longer references it.
- `src/client/types.ts` — extends with `Document`, `SyncStatus`, `SyncEvent` types matching the new API responses. The Slice 005 `ClassificationResult` type stays (unused this slice but Slice 010 will reuse it via reclassify).
- `src/client/api.ts` — `getJson<T>` and `postJson<T>` reused. SSE consumption uses native `EventSource`.
- `package.json` — adds `playwright` to runtime deps. Adds a `postinstall` script `playwright install chromium` so local-dev `npm install` pulls the browser. Removes nothing (Slice 005's deps stay; the deleted code's deps overlap with what's still needed).
- `vitest.workspace.ts` / `vitest.config.ts` — **No change**. New tests slot into the existing `pool: 'forks'` server config.
- `scripts/check-gmail-readonly.ts` — **No change**. The new `history.list` and `getProfile` substrings are not on the forbidden list.
- `.env.example` — adds two commented entries for `SYNC_DEFAULT_WINDOW_DAYS` and `MAX_CONCURRENT_CLASSIFY` next to the existing `OLLAMA_*` block.
- `tsconfig.server.json` — Slice 005 added `DOM` to lib for pdfjs-dist's type cast. **No further change** — Playwright's Node API does not require DOM types.
- `Dockerfile` / `docker-compose.yml` — historically the spec calls for Dockerfile updates (Playwright install) and docker-compose mounts (`./invoices:/app/invoices`). The Dec 9 devcontainer migration deleted both files (Slice 004's review documented this). Like Slice 005's smoke recipe, the dev-shape substitutes the devcontainer; production-mode is `npm run build && NODE_ENV=production node dist/server/index.js` with a host-mounted `./invoices/`. **The Playwright install** still happens — via the `postinstall` script — so the devcontainer also gets the browser. Restoring `Dockerfile` / `docker-compose.yml` is a separate question Slice 004 declined to answer; this slice continues to defer it.

Files / modules created from scratch:

- `src/server/db/migrations/0005_create_documents.sql`
- `src/server/db/repositories/documents.ts` (+ test)
- `src/server/sync/orchestrator.ts` (+ test)
- `src/server/sync/events.ts` (typed event emitter + ring buffer; + test)
- `src/server/sync/discovery.ts` (history vs date-range selection; + test) — *optional split; could live inside orchestrator.ts but tests are easier if it's a pure function module*
- `src/server/files.ts` (+ test)
- `src/server/classify/render-html-pdf.ts` (Playwright wrapper; + test)
- `src/server/api/sync.ts` (+ test)
- `src/server/api/documents.ts` (+ test)
- `src/client/components/SyncControls.tsx` (+ test)
- `src/client/hooks/useSyncEvents.ts` (+ test)
- `invoices/.gitkeep`

## Patterns to follow

- **Append-only migrations.** ADR-002 pins the rule: never edit a shipped migration. `0005_create_documents.sql` joins the four existing migrations with the same shape (CREATE TABLE + CHECK constraints + indices in one file, transactional via the runner). The `(account_id, content_hash)` UNIQUE is declared inline alongside the column constraints.
- **Repository under `src/server/db/repositories/`.** Same shape as `processed_messages.ts`: `WeakMap` statement cache, `stmt(db, key, sql)` helper, plain functions that take `account_id` explicitly. `documents.ts` exports `insert(input): number`, `existsByHash({ account_id, content_hash }): boolean`, `listForAccount({ account_id, limit, offset, review_status? }): { rows, total }`, `findById(id): Document | undefined` (no account scoping — the only caller is `GET /api/documents/:id/file` and the file path constrains access).
- **API factory pattern.** Slice 003's `registerXxxRoutes(app, deps?)` shape is established. `registerSyncRoutes(app, { runSync? })` and `registerDocumentsRoutes(app, { invoicesDir? })` follow it.
- **Zod path-param validation.** Slice 005's pattern in `api/classify.ts` (`zValidator('param', schema, hook)` with a custom 400 handler returning `{error: 'invalid_params'}`) is reused.
- **Body validation with `@hono/zod-validator`.** `POST /api/sync` validates the request body via `zValidator('json', bodySchema, hook)`. The body schema accepts `account_ids?: number[]` and `since?: string` (ISO YYYY-MM-DD). Non-conforming → 400 `{error: 'invalid_body'}`.
- **SSE via `@hono/streaming` or hand-rolled.** Hono exposes SSE primitives via `streamSSE`. `GET /api/sync/events` opens a stream, subscribes to the typed event emitter, writes one `data: <json>` line per event, and on subscriber connect first replays the ring buffer's remaining contents. The endpoint never closes proactively; it ends when the client disconnects or `sync.done` fires (the orchestrator can choose).
- **Typed event emitter with ring buffer.** `events.ts` wraps Node's `EventEmitter` with an explicit event-name → payload-shape mapping. Pattern:
  ```ts
  type Events = {
    'sync.start': { job_id: string; account_ids: number[] }
    'sync.account.start': { account_id: number }
    'sync.message': { account_id: number; message_id: string; status: 'success' | 'failed'; classification?: 'invoice' | 'receipt' | 'other'; confidence?: 'high' | 'medium' | 'low'; document_ids: number[] }
    'sync.account.done': { account_id: number; processed: number; receipts: number; failed: number }
    'sync.done': { job_id: string; totals: { processed: number; receipts: number; failed: number } }
    'sync.error': { account_id?: number; message: string }
  }
  ```
  Emit method appends to a ring buffer (cap 200 events) and emits to the underlying `EventEmitter`. Subscribe method returns an iterator that first yields the current ring contents, then yields new events as they arrive. The shape lets `GET /api/sync/events` resume cleanly even if the SSE client connects mid-job.
- **Single-job mutex.** A module-level `let activeJob: { job_id, started_at, ... } | null = null` plus `acquireJob()` / `releaseJob()` functions. `POST /api/sync` calls `acquireJob`; if it returns `null` (already held), respond 409. The orchestrator releases the job in a `finally` block so a thrown error doesn't leak the mutex.
- **File store discipline.** `src/server/files.ts` exports `writeReceiptFile({ account_slug, internal_date, message_id, seq, suggested_filename, bytes }): Promise<{ file_path, content_hash, size }>`. Internals:
  - Compute `yyyy` and `mm` from `internal_date` (epoch-ms string) — local-time projection (Node `new Date(...).getFullYear()` / `getMonth()`).
  - Sanitize the suggested filename: strip everything but `[A-Za-z0-9._-]`, collapse repeated dots/dashes/underscores, truncate to 100 chars, preserve extension.
  - Compose the relative path: `{account_slug}/{yyyy}/{mm}/{message_id}_{seq}_{safe}`.
  - Resolve to absolute via `path.resolve(invoicesRoot, relative)`. **Verify the resolved absolute path is a child of the invoices root** (`startsWith(invoicesRoot + path.sep)`). Throw if not — the path-traversal guard.
  - `mkdirSync({ recursive: true })` for parent directories.
  - Write atomically: write to `<final>.tmp` then `rename`. Compute SHA-256 with Node's `crypto` during the write (or after — for receipt-sized files in-memory hashing is fine).
  - Return the relative path (what's stored in `documents.file_path`), the hex hash, and the size.
- **HTML→PDF via Playwright.** `src/server/classify/render-html-pdf.ts`:
  ```ts
  import { chromium } from 'playwright'
  export async function renderHtmlToPdf(html: string): Promise<Buffer> {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle' })
      return await page.pdf({ format: 'A4', printBackground: true })
    } finally {
      await browser.close()
    }
  }
  ```
  The launch-and-close per call is wasteful but simple; the per-message overhead is acceptable for a single-user tool. Slice 016 may revisit. Tests stub at the deps boundary (the orchestrator's `renderHtmlToPdf?` dep) rather than driving the real browser.
- **Discovery: history vs date range.** A small pure-ish module: given `(syncState, since?, fallbackDays)`, decide between a History API call and a date-range search. Returns `{ kind: 'history', start_history_id }` or `{ kind: 'range', q }`. The orchestrator then dispatches; if `historyList` returns 404 (history records expired or `start_history_id` invalid), the orchestrator catches and falls back to a range search.
- **Per-message transaction.** Pattern matches Slice 004's dev-seed: phase 1 fetches Gmail/Ollama (no DB transaction), stages the rows in memory, then a single `db.transaction(() => { ... })` does the existsForMessage check, the `documents` inserts, and the `processed_messages` insert atomically. If Gmail or Ollama throws, no DB writes happen for that message.
- **Inbox latest-attempt JOIN.** The `documents` listing query joins on the latest `processed_messages` row per `(account_id, message_id)`:
  ```sql
  SELECT d.*, pm.subject, pm.sender_domain, pm.classification, pm.confidence, pm.model_used
  FROM documents d
  LEFT JOIN processed_messages pm ON pm.id = (
    SELECT MAX(id) FROM processed_messages
    WHERE account_id = d.account_id AND message_id = d.message_id
  )
  WHERE d.account_id = ?
    [AND d.review_status = ?]
  ORDER BY d.created_at DESC
  LIMIT ? OFFSET ?
  ```
  The correlated subquery is fine for the small per-account row counts in v1; if it ever becomes a hotspot, an index on `processed_messages(account_id, message_id, id)` helps (which we already have via Slice 004's `(account_id, message_id, processed_at DESC)` index).
- **`classifyMessage` extension for source bytes.** Add an optional return field `source_bytes?: Map<{ kind: 'attachment' | 'rendered_body'; key: string }, Buffer>`. The map's keys are the artifact descriptors; the orchestrator looks up bytes by artifact when persisting. Keeps `classifyMessage`'s signature additive — Slice 005's existing tests assert on `classification`, `confidence`, etc. and don't care about a new field. The reclassify path (Slice 010 single-row) ignores `source_bytes`. **Decision flagged.**
- **Account-status precondition.** `requireConnectedAccount` from Slice 005 is reused by `GET /api/accounts/:id/documents`. The route 404s on unknown account, 409s on `needs_reauth`. The Inbox view handles 409 the same way as Slice 003 did — show a "needs reconnect" message.
- **`GET /api/documents/:id/file` security.** Validate the document row exists; resolve the absolute path via `path.resolve(invoicesRoot, doc.file_path)`; verify it stays inside `invoicesRoot` (defense in depth even though the path was sanitized at write time); stream via `Bun`-style `ReadableStream` from the file or via Node's `fs.createReadStream`. Set `Content-Type: doc.mime_type` and `Content-Disposition: inline; filename="{sanitized}"`. Return 404 on not found, 403 on path-traversal (would only happen if the DB row was tampered with).
- **Removed-file cleanup.** When deleting `dev.ts` / `processed_messages.ts` / `classify.ts` / `ClassifyRowAction.tsx` / `DevSeedPanel.tsx`, also delete their tests. The Inbox test file gets rewritten (not deleted). The Dashboard test file gets edited to drop the dev-seed-panel test and replace `/api/dev/enabled` mocks with `/api/sync/status` mocks.

## Refactors needed before adding the new feature

Three small ones:

- **Extend `classifyMessage` to return `source_bytes` for persisted artifacts.** Without this, the sync orchestrator either re-fetches every attachment (Gmail quota cost + extra latency) or duplicates the per-message pipeline (broken DRY with Slice 005). Adding an optional field to the return type is the cheapest reversible change. Slice 005's tests stay green because they don't assert on absence of new fields.
- **Add `mkdirSync` for `invoicesDir` to `src/server/index.ts`.** Mirrors the existing `mkdirSync(dirname(resolve(config.dbPath)))`. One line.
- **`tsconfig.server.json` — no further change.** Slice 005 added `DOM` for pdfjs-dist. Playwright's Node API doesn't need it. Verified by reading playwright's typings.

Two refactors deliberately *not* done:

- **Promote `dirname/resolve` startup pattern to a helper.** Two callers (data dir + invoices dir) is below the abstraction bar.
- **Move `accounts.ts` from `auth/` to `db/repositories/`.** Slice 004's review queued this; Slice 005's review re-deferred it; this slice does the same. Six callers; no current functional gain.

## Risks and open questions

- **Playwright in the devcontainer.** The devcontainer's base image (`node:20`-derived) may not have all the apt deps Playwright's chromium needs (`libnss3`, `libatk-1.0-0`, `libxcomposite1`, etc.). The `--with-deps` flag normally installs them via apt; the devcontainer might need the same. The `postinstall: playwright install chromium` script doesn't run apt by default; the user may need `npx playwright install --with-deps chromium` or root access. **Plan: validate this in the first Playwright step; if apt deps are missing, add them via the devcontainer's `Dockerfile` or document the manual step.** Worst case: the smoke run defers HTML→PDF rendering verification to human acceptance, same shape as Slice 005's deferred ACs.
- **Image size inflation.** Adding chromium adds ~300 MB. ADR-004 already noted the @napi-rs/canvas size cost; Playwright is bigger. Acceptable for v1; ADR-noting is *not* necessary because `architecture.md` § "Tech stack" already names Playwright as the HTML→PDF choice.
- **`history.list` 404 / 410 handling.** Gmail's History API expires `historyId` after ~7 days or under heavy mailbox change; the response is 404. **Plan: orchestrator catches the 404 from `historyList`, logs a `sync.error` event, and falls back to the date-range search using a 30-day default.** The fallback resets `sync_state.last_history_id` to the new `historyId` from `getProfile()` after the range sync completes.
- **SSE keep-alive.** Node `@hono/node-server` + plain `Response` body works for SSE; some intermediate proxies kill idle connections. v1 is localhost-only, so this is a non-issue. If a future hosted mode is added, consider sending a heartbeat comment every 15 s.
- **Concurrent classify limit.** Spec's `MAX_CONCURRENT_CLASSIFY=1` is enforced via a small in-memory semaphore around the `classifyMessage` call. The orchestrator processes messages sequentially per account anyway; the semaphore is a safety net for cross-account parallelism if a future spec adds it. Easy to implement; right shape for the constraint.
- **Per-account vs cross-account ordering.** Spec says "Accounts are processed serially by default" (architecture.md § "Sync (manual trigger)"). Plan: the orchestrator iterates accounts in order, processing each account's full message list before moving to the next.
- **Re-fetching attachment bytes vs `source_bytes` map.** The cleanest design adds a `source_bytes` map to `classifyMessage`'s return value (see "Refactors"). Memory implications: holding all attachment + page bytes for one message is bounded by Slice 005's 5 MB cap × N attachments (small in practice). The bytes are released as soon as the per-message transaction completes. Acceptable.
- **Dedup across messages, not across runs.** The `(account_id, content_hash)` UNIQUE prevents duplicate `documents` rows but allows duplicate `processed_messages` rows for the same dedup-hit message (one per sync attempt that hit dedup). The spec calls this out: "the second message gets its own `processed_messages` row with `status='success'` … but the hard-dedup check on `documents.(account_id, content_hash)` blocks a second `documents` row". The orchestrator's per-message transaction catches the SQLite constraint violation and inserts the `processed_messages` row without a `documents` row.
- **`document_ids` event field for deduped artifacts.** Spec is ambiguous: "include the artifact id in the `sync.message` event (so the UI can show 'deduped')". A deduped artifact has no new `documents.id`. Plan: the SSE `document_ids` field includes the existing dedup-hit row id, so the UI sees a stable id even when no new row was created. Flag for the review.
- **`renderHtmlToPdf` fallback.** If Playwright fails to launch (binary missing, permissions issue), the orchestrator catches and emits `sync.error` for that account, then continues. The non-rendered-body case (PDF attachment present, prefer attachment) avoids Playwright entirely and is the most common path; rendered-body cases are the minority where Playwright matters.
- **Inbox view's account-picker default.** Slice 003's behavior preserved (localStorage `LAST_INBOX_ACCOUNT_KEY`). The picker's set of accounts comes from `GET /api/accounts`; documents come from `GET /api/accounts/:id/documents`. No change to picker UX.
- **`GET /api/documents/:id/file` and access control.** Single-user tool, no auth gate yet (per `architecture.md` § "Multi-user / multi-tenant" — out of scope). The path-traversal guard prevents serving outside `./invoices/`. The DB row's `account_id` is *not* used as an authorization gate; the assumption is the caller is authorized to see any document in their install.
- **Hono streaming body for SSE.** Hono 4.6+ supports `streamSSE` from `@hono/streaming` (or `hono/streaming`). Need to confirm the import path works under the project's Hono version. **Plan: validate during the first SSE step.**
- **Removing the dev seed panel without breaking tests.** Slice 004's tests for `dev.ts`, `processed_messages.ts`, `DevSeedPanel.tsx`, the migration assertions for the seed path — many tests need to delete or update. Plan: a single step in the slice's plan does the removal cleanly (file deletes + Dashboard test edits + the URL-routed `/api/dev/enabled` mock removals).
- **Removing Slice 005's `ClassifyRowAction` and `classify.ts` API route.** Same surface shape as the dev-panel removal. The `OllamaHealth` component stays; the orchestrator-side imports of the Slice 005 pipeline (the inner `classifyMessage` function in `src/server/classify/index.ts`) stay. Only the outermost route/component pair goes.
- **First-sync window and `since` semantics.** Spec: ISO YYYY-MM-DD. The orchestrator translates that into Gmail's `q='after:YYYY/MM/DD'` syntax (slashes, not dashes). One-line transform; flag for the review.
- **`processed_messages` JOIN over a deleted account.** A future slice may delete an account; the LEFT JOIN handles a missing `processed_messages` row by returning NULL columns. Spec doesn't address this; documents.account_id has FK→accounts.id and Slice 002's table doesn't ON DELETE CASCADE, so accounts can't be deleted today anyway. Future work.
- **ADR candidates.** Re-examining the bar from `docs/ralph-loops/spec-implementation-loop.md` § "When to write an ADR":
  - **Single-job mutex with in-memory state, no DB-backed job table.** Spec calls this out. `architecture.md` is silent. Future specs (Slice 014 batch reclassify) will need to compose with the same mutex; the design impacts what restart-recovery looks like. **Plan: write ADR-007 — "In-memory single-job mutex for sync (no jobs table)".** Justifies the choice over a DB-backed `jobs` table or a queue (Bullmq, etc.).
  - **SSE over WebSocket / polling.** The spec picks SSE; `architecture.md` § "Components — Gmail sync handler" says "Server-Sent Events or WebSocket". The choice between SSE and WebSocket is real. **Plan: write ADR-008 — "SSE for sync progress, ring-buffered for late subscribers"**. Documents why SSE over WebSocket / long-polling, and why a 200-event ring buffer over a persisted event log.
  - **File-store layout including the path-traversal guard rule.** Layout is covered by `architecture.md` § "Storage" verbatim; the guard rule is implementation detail. No ADR.
  - **Hard dedup scoped per account vs global.** Architecture explicitly chose per-account ("Across accounts: A receipt that arrives in *two different* connected inboxes … is intentionally stored as two documents"). No new decision; no ADR.
  - **`source_bytes` extension to `classifyMessage`.** Implementation choice between re-fetching and threading bytes through. Routine. No ADR.
  - **Deletion of dev seed panel + per-row classify button.** Spec calls these out; routine. No ADR.

  Net: two ADRs introduced (ADR-007 single-job mutex, ADR-008 SSE).

## Test strategy

Following the loop's "TDD where applicable" rule.

**Unit tests planned (vitest, Node env):**

- `src/server/db/migrations.test.ts` — extend with a `describe('0005_create_documents.sql', …)` block (similar shape to Slice 004's per-table blocks):
  - Column set + types via `PRAGMA table_info(documents)`.
  - `kind` CHECK constraint enforces the two values.
  - `review_status` CHECK constraint enforces the three values.
  - FK to `accounts(id)` declared via `PRAGMA foreign_key_list`.
  - `(account_id, content_hash)` UNIQUE — assert by inserting two rows with the same pair throws.
  - Same `(account_id, content_hash)` across two accounts is allowed (cross-account dedup is *not* applied — architecture decision).
  - `(account_id, review_status, created_at)` and `(account_id, message_id)` indices via `PRAGMA index_list` + `PRAGMA index_xinfo`.

- `src/server/db/repositories/documents.test.ts` — new file. Mirrors `processed_messages.test.ts` shape:
  - `existsByHash` returns false / true correctly.
  - `insert` returns the surrogate id; the row is readable via `findById`.
  - `listForAccount({ account_id, limit, offset })` returns rows in `created_at DESC` order, limited and offset correctly.
  - `listForAccount` with `review_status: 'pending'` filters.
  - `listForAccount.total` is the unfiltered (or filtered) count consistent with the rows returned.
  - FK constraint: insert with non-existent `account_id` throws.
  - UNIQUE constraint: two inserts of the same `(account_id, content_hash)` throws on the second.
  - The Inbox listing JOIN returns latest-attempt fields when multiple `processed_messages` rows exist for `(account_id, message_id)`.

- `src/server/files.test.ts` — new file:
  - `writeReceiptFile` writes bytes to the right path under a temp invoices dir; returns `{ file_path, content_hash, size }`.
  - Filename sanitization: pathological inputs (`../../etc/passwd`, `foo/../bar`, `con.txt`, very long names, names with control characters) are sanitized.
  - Path-traversal guard: a `suggested_filename` like `../../escape.txt` results in a sanitized filename and an absolute path inside the invoices root (not throws — the sanitization handles it; the guard is a final assertion).
  - `internal_date` epoch-ms is projected to year/month correctly.
  - Two writes with the same `account_slug + internal_date + message_id + seq + suggested_filename` produce the same final path; the second overwrites the first (we don't expect to call this with duplicate keys, but document the behavior).
  - SHA-256 hash matches the input bytes (compute via Node `crypto.createHash('sha256').update(bytes).digest('hex')` independently in the test).

- `src/server/classify/render-html-pdf.test.ts` — new file. Two flavors:
  - **Real Playwright run:** small HTML input, verify the output starts with `%PDF-1.` magic bytes. Slow (~1-2 s). Mark as integration; skip on CI if needed via `it.skipIf(...)`.
  - **Unit-level (with the orchestrator's deps boundary stub):** the orchestrator test stubs `renderHtmlToPdf` with `vi.fn()`, asserts the call shape, and returns a fixture buffer.

- `src/server/sync/events.test.ts` — new file:
  - Emit + subscribe roundtrip.
  - Late subscriber receives the ring buffer's contents on first read.
  - Ring buffer caps at 200; the 201st emit drops the oldest.
  - Multiple subscribers each receive each event.
  - Unsubscribe on disconnect.

- `src/server/sync/discovery.test.ts` — new file (if split out):
  - With `since` set, returns `{ kind: 'range', q: 'after:YYYY/MM/DD' }`.
  - With `last_history_id` and no `since`, returns `{ kind: 'history', start_history_id }`.
  - Without either, returns `{ kind: 'range', q }` using the configured fallback days.

- `src/server/sync/orchestrator.test.ts` — new file. Stub: `createGmailClient` (canned `Schema$Message` and attachment buffers); `classifyMessage` (returns canned verdict + source_bytes); `renderHtmlToPdf`; the events emitter (subscribed via the test). Cases:
  - Happy path with one connected account, one receipt-shaped message → `processed_messages` has 1 row, `documents` has 1 row, the file is written under `invoicesRoot/{slug}/{yyyy}/{mm}/...`, SSE events fire in order.
  - Account in `needs_reauth` is skipped; `sync.error` event fires for that account.
  - Token error mid-account flips that account to `needs_reauth`, emits `sync.error`, continues with the next account.
  - Ollama-unreachable mid-classify: `processed_messages` row inserted with `status='failed'`, no `documents` row, orchestrator continues.
  - Hard dedup: the same content_hash arrives twice; the second is logged in `processed_messages` but does not create a new `documents` row.
  - Idempotency: second sync over the same window inserts zero new `processed_messages` rows.
  - Body-as-receipt path: the body is rendered to PDF via the stubbed `renderHtmlToPdf`, persisted with `kind='rendered_body'`.
  - Body + attachment: when both exist, prefer the attachment, skip body rendering.

- `src/server/api/sync.test.ts` — new file:
  - `POST /api/sync` with empty body returns 202 with `job_id`; emits `sync.start`.
  - `POST /api/sync` with `{ account_ids: [42] }` filters; with `{ since: '2026-04-01' }` overrides the date range.
  - 409 when a sync is already in progress.
  - 400 on malformed body.
  - `GET /api/sync/status` returns `{ active: false }` when idle and `{ active: true, job_id, started_at, accounts: [...] }` during a job.
  - `GET /api/sync/events` returns a 200 SSE stream; sending `EventSource`-style line parses the events. *(Tests the wiring via `app.fetch` and reads the streamed body chunks.)*

- `src/server/api/documents.test.ts` — new file:
  - `GET /api/accounts/:id/documents` returns `{ rows, total }` with the spec's columns.
  - `?limit=` / `?offset=` / `?review_status=` filters work.
  - 400 on invalid `:id`, 404 on unknown account, 409 on `needs_reauth`.
  - `GET /api/documents/:id/file` streams bytes with the right `Content-Type` and `Content-Disposition`.
  - 404 when no document row exists for the id.
  - 403 (or 404; pick one) when the file path would resolve outside `invoicesRoot` (defense-in-depth).
  - 404 when the row exists but the file is missing on disk.

**Client tests planned (vitest, jsdom env, RTL):**

- `src/client/components/SyncControls.test.tsx` — new file:
  - Renders a "Sync now" button when no sync is in progress.
  - Click → POSTs `/api/sync`; on 202 the button disables and shows "Syncing…".
  - Subscribes to `/api/sync/events`; renders per-account counters as events arrive (mock the `EventSource` constructor in jsdom — there's a known-working stub pattern).
  - On `sync.done`, the button re-enables.
  - Initial load with an active sync (from `/api/sync/status`) shows the in-progress state without a fresh click.

- `src/client/hooks/useSyncEvents.test.ts` — new file:
  - Subscribes via mocked `EventSource`; collects events; exposes the latest snapshot.
  - Cleanup on unmount.

- `src/client/views/Inbox.test.tsx` — rewritten:
  - Picker preselects the first connected account; renders `documents` rows from a stubbed `/api/accounts/:id/documents`.
  - Columns: Vendor, Amount + Currency, Transaction Date, Subject, Sender Domain, Created At, Preview link.
  - NULL extracted fields render as `—`.
  - Picker change refetches; localStorage persists the selection.
  - Empty state when the account has no documents yet.
  - 409 → "needs reconnect" message.

- `src/client/views/Dashboard.test.tsx` — edited:
  - Drop the dev-seed-panel test.
  - Replace `/api/dev/enabled` mock with `/api/sync/status` mock returning `{ active: false }`.
  - New test: `<SyncControls />` renders.

**Smoke test outline (manual, run by priority 5):**

Same shape as Slice 005 — server-side gates verifiable from the agent shell, browser-driven ACs deferred to human acceptance.

1. Build and boot gates: `npm install` (validates Playwright postinstall succeeds), `npm run check:gmail-readonly`, `npm run typecheck`, `npx vitest run`.
2. Production build: `npm run build`. Boot `APP_PORT=3738 NODE_ENV=production node dist/server/index.js`.
3. Endpoint shape: `GET /health` 200, `GET /api/accounts` 200, `GET /api/sync/status` returns `{active: false}`.
4. `POST /api/sync` with no connected account session (devcontainer restart wiped tokens): the orchestrator emits `sync.error` for the disconnected account, and `sync.done` immediately. SSE events visible via `curl -N`.
5. **Browser-driven ACs (deferred):** clicking Sync with real Gmail + real Ollama produces real receipts on disk; the Inbox view shows them; the badge transitions correctly. Pinned at the unit layer in `sync/orchestrator.test.ts`, `api/documents.test.ts`, `client/components/SyncControls.test.tsx`, `client/views/Inbox.test.tsx`. Same shape as Slice 005's deferred ACs.
6. Read-only Gmail check: `npm run check:gmail-readonly` exits 0; `grep` confirms only `gmail.readonly + userinfo.email + openid` scopes; no Gmail-write substrings.
7. Dev-seed panel removed: `GET /api/dev/enabled` returns 404 in dev (the route is gone, not just gated).
8. `git status` clean (excluding the unrelated README change in the working tree from the user's mid-loop interruption — this slice's commit will not stage that file).
