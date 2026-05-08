# Slice 006: Sync and store receipts

**Status:** draft

## Observable result

I can click "Sync now" on the Dashboard and watch per-account progress stream in. When sync finishes, real receipts and invoices from each connected account have been captured to `./invoices/{account_slug}/{yyyy}/{mm}/...` on my host filesystem and to a `documents` table in SQLite, and the Inbox view now shows them filterable by account.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` (Slice 004) — including the `status` and `error_message` columns this slice writes into
  - `sync_state` (Slice 004)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
  - `0002_create_processed_messages.sql` (Slice 004)
  - `0003_create_sync_state.sql` (Slice 004)
  - `0004_create_app_config.sql` (Slice 004)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/accounts/:id/messages?limit=50` (Slice 003) — used here only by tests / debugging; the sync orchestrator goes through the lower-level Gmail client directly
- **UI views / components:**
  - `Dashboard.tsx` at `/` (Slice 002) — extended here with sync controls and the dev-seed panel removed
  - `Inbox.tsx` at `/inbox` (Slice 003) — its data source is replaced here
  - `Nav.tsx`, `AccountPicker.tsx` (Slice 003)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Slice 002)
  - `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` (Slice 005)
  - `NODE_ENV` (Slice 004)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/auth/accounts.ts`, `src/server/auth/session.ts` (Slice 002)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/processed_messages.ts` (Slice 004)
  - `src/server/db/repositories/sync_state.ts` (Slice 004)
  - `src/server/gmail/client.ts` — including `getMessage(format='full')` and `getAttachment` (Slices 003 / 005)
  - `src/server/classify/index.ts` (Slice 005) — the per-message classification pipeline
  - `src/server/classify/extract-body.ts`, `src/server/classify/render-pdf.ts`, `src/server/classify/prompt.ts`, `src/server/classify/ollama.ts`, `src/server/classify/schema.ts` (Slice 005)
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Google OAuth + Gmail API access per account (Slice 002 + 003)
  - Ollama at `OLLAMA_URL` (Slice 005)
- **Other:**
  - `extra_hosts: host.docker.internal:host-gateway` in `docker-compose.yml` (Slice 001)
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `documents` table:
    - `id` INTEGER PRIMARY KEY AUTOINCREMENT
    - `account_id` INTEGER NOT NULL REFERENCES `accounts`(`id`)
    - `message_id` TEXT NOT NULL
    - `kind` TEXT NOT NULL CHECK (`kind` IN ('attachment','rendered_body'))
    - `filename` TEXT NOT NULL — the on-disk filename (relative basename, no directories)
    - `mime_type` TEXT NOT NULL
    - `size` INTEGER NOT NULL — bytes
    - `content_hash` TEXT NOT NULL — SHA-256 hex
    - `file_path` TEXT NOT NULL — relative path under `./invoices/`, e.g. `business/2026/05/abc123_0_stripe-receipt.pdf`
    - `vendor` TEXT NULL — extracted by classifier
    - `amount` REAL NULL — extracted by classifier
    - `currency` TEXT NULL — 3-letter code, extracted by classifier
    - `transaction_date` TEXT NULL — ISO 8601 date (YYYY-MM-DD), extracted by classifier
    - `review_status` TEXT NOT NULL DEFAULT 'pending' CHECK (`review_status` IN ('pending','approved','rejected'))
    - `created_at` TEXT NOT NULL — ISO 8601 timestamp
    - `updated_at` TEXT NOT NULL — ISO 8601 timestamp
    - UNIQUE (`account_id`, `content_hash`) — hard dedup, scoped per account
    - FOREIGN KEY (`account_id`, `message_id`) REFERENCES `processed_messages`(`account_id`, `message_id`)
    - INDEX on `(account_id, review_status, created_at)` for the Inbox listing
- **Migrations:**
  - `0005_create_documents.sql` — creates the `documents` table above
- **API endpoints:**
  - `POST /api/sync` — request body Zod-validated as `{ account_ids?: number[], since?: string (ISO date, YYYY-MM-DD) }`. Defaults: all accounts in `status='connected'`, last 30 days. Starts the in-process sync job and returns HTTP 202 with `{ job_id: string, started_at: string }`. Returns HTTP 409 with `{ error: 'sync_in_progress', job_id }` if a sync is already running (single-user, single-job).
  - `GET /api/sync/events` → Server-Sent Events stream. Emits `sync.start` (`{ job_id, account_ids }`), `sync.account.start` (`{ account_id }`), `sync.message` (`{ account_id, message_id, status: 'success'|'failed', classification?, confidence?, document_ids: number[] }`), `sync.account.done` (`{ account_id, processed: N, receipts: M, failed: K }`), `sync.done` (`{ job_id, totals }`), and `sync.error` (`{ account_id?, message }`). The UI subscribes when a job is active and replays a small in-memory ring buffer (~last 200 events) for late subscribers.
  - `GET /api/sync/status` → `{ active: boolean, job_id?: string, started_at?: string, accounts?: Array<{ account_id, processed, receipts, failed, in_progress: boolean }> }`. For the Dashboard to render current state on page load without depending on SSE replay.
  - `GET /api/accounts/:id/documents?limit=&offset=&review_status=` → response `{ rows: Array<DocumentRow>, total: number }`. The default `review_status` filter is unset (returns all). Used by the Inbox view.
  - `GET /api/documents/:id/file` → streams the file bytes from disk with the appropriate `Content-Type` and `Content-Disposition: inline`. Authorizes implicitly (single user; no auth gate yet) but verifies the document row exists and the file path is inside `./invoices/`.
- **UI views / components:**
  - `SyncControls.tsx` — rendered on the Dashboard. Shows a "Sync now" button (syncs all `connected` accounts) and a per-account "Sync" button on each row in the accounts list. Disabled while a sync is in progress. While active, displays per-account progress (`processed N`, `receipts M`, `failed K`) sourced from the SSE stream + `GET /api/sync/status` snapshot.
  - `Inbox.tsx` (data source replacement) — instead of `GET /api/accounts/:id/messages` (Slice 003 — the live-Gmail read-through), it now calls `GET /api/accounts/:id/documents?limit=50&offset=0` and renders columns: thumbnail (placeholder for now), Vendor, Amount + Currency, Transaction Date, Subject (from joined `processed_messages`), Sender Domain, Created At, plus a "Preview" link that opens `GET /api/documents/:id/file` in a new tab. The account picker is unchanged.
- **Background jobs / orchestrators:**
  - Sync orchestrator (`src/server/sync/orchestrator.ts`). Triggered by `POST /api/sync`; runs to completion in the same Node process; emits SSE events to a shared event emitter that `GET /api/sync/events` subscribes to. Single-job-at-a-time enforced by an in-memory mutex.
- **Env vars / configuration:**
  - `SYNC_DEFAULT_WINDOW_DAYS` (default `30`) — used when `POST /api/sync` request omits `since`.
  - `MAX_CONCURRENT_CLASSIFY` (default `1`) — how many classify calls run in parallel against Ollama. Default is 1 because Ollama is the bottleneck and overlapping doesn't help (`architecture.md` § "Sync (manual trigger)").
  - `docker-compose.yml` updated:
    - Adds bind mount `./invoices:/app/invoices`
    - Passes through `SYNC_DEFAULT_WINDOW_DAYS` and `MAX_CONCURRENT_CLASSIFY`
- **Files / modules:**
  - `src/server/db/migrations/0005_create_documents.sql`
  - `src/server/db/repositories/documents.ts` — `insert`, `existsByHash({ account_id, content_hash })`, `listForAccount({ account_id, limit, offset, review_status? })`, `findById`. All methods take `account_id` explicitly except `findById`, which still scopes the lookup to a single id (used only by `GET /api/documents/:id/file`).
  - `src/server/sync/orchestrator.ts` — exports `runSync({ account_ids, since })`. Holds the per-job state and the SSE emitter.
  - `src/server/sync/events.ts` — typed event emitter wrapping Node's `EventEmitter` with the event shapes above plus the ring buffer for late subscribers.
  - `src/server/files.ts` — file store wrapper. `writeReceiptFile({ account_slug, internal_date, message_id, seq, suggested_filename, bytes })` returns `{ file_path, content_hash, size }`. Sanitizes the filename (no `/`, `\`, `:`, `..`; truncates to a safe length; preserves extension). Computes `yyyy`/`mm` from `internal_date`. Creates parent directories as needed. Throws if the resolved absolute path is outside the configured `./invoices` root.
  - `src/server/classify/render-html-pdf.ts` — `renderHtmlToPdf(html: string): Promise<Buffer>` using Playwright (`@playwright/test`'s headless chromium, but really just `playwright` core — see Risks). Used for the `kind='rendered_body'` case where the receipt *is* the email body. Different file from Slice 005's `render-pdf.ts`, which goes the *other* direction (PDF → image for the vision model input).
  - `src/server/api/sync.ts` — registers `POST /api/sync`, `GET /api/sync/events`, `GET /api/sync/status`.
  - `src/server/api/documents.ts` — registers `GET /api/accounts/:id/documents`, `GET /api/documents/:id/file`.
  - `src/client/components/SyncControls.tsx`
  - `src/client/hooks/useSyncEvents.ts` — subscribes to `GET /api/sync/events`, exposes the latest per-account counts.
  - `src/client/views/Inbox.tsx` — modified data source (modification of Slice 003 file)
  - `src/client/views/Dashboard.tsx` — modified to render `<SyncControls />` and to remove `<DevSeedPanel />` (modification of Slice 004 surface)
  - `Dockerfile` — modified to install Playwright browser binaries (e.g. `RUN npx playwright install --with-deps chromium` in the build stage; the chromium binary is copied into the runtime stage). Modification of the Slice 001 file.
  - `invoices/.gitkeep` — keeps the bind-mount target present in the repo (parallel to `data/.gitkeep` from Slice 002; the path itself is gitignored from Slice 001's `.gitignore`).
  - **Removed:** `src/client/views/DevSeedPanel.tsx`, `src/server/api/dev.ts` — the dev seed surface from Slice 004 is deleted in this slice (per Slice 004's Risks note). `src/server/api/processed_messages.ts` (Slice 004's `GET /api/accounts/:id/processed-messages`) is **kept** because Slice 010's Audit view will use it.
  - `package.json` updates: adds `playwright` to runtime deps; adds a `postinstall` script `playwright install chromium` so local dev installs the browser, mirroring what the Dockerfile does for the image.
- **External services:**
  - Bind-mounted `./invoices` directory for the on-disk file store
  - Playwright headless chromium (bundled inside the container) — the only third-party browser dependency in the project; used solely for HTML body → PDF rendering
- **Other:**
  - **First slice that produces files on disk** under `./invoices/{account_slug}/{yyyy}/{mm}/...`. Filenames sanitized; paths confined to the `./invoices` root.
  - **First slice with a long-running orchestrator.** Single in-memory job state; no persisted job table. A container restart mid-sync drops the job; partial work survives (already-written rows stay), and the next sync resumes naturally because `processed_messages` is the idempotency anchor.
  - **Idempotency under re-sync.** Re-running sync on the same date range over the same accounts produces zero new rows in `processed_messages` or `documents`, because the orchestrator skips `(account_id, message_id)` already present.
  - **Hard dedup across messages within an account.** When the same exact PDF arrives twice (e.g. body + attachment, or two threads with the same attachment) inside one account, `documents` stores it once due to the `(account_id, content_hash)` unique constraint; the second encounter is logged in `processed_messages` (with status='success') but no `documents` row is created.

## Out of scope

- Approve / reject UI, `review_actions` table, side-by-side review view, keyboard shortcuts → Slice 007
- Inline editable fields (`vendor`, `amount`, `currency`, `transaction_date` editing UI) and the `*_edited` boolean columns → Slice 008
- `tags`, `document_tags` tables and the tag picker → Slice 009
- Cross-account Audit view, "Open in Gmail" deep links, Reclassify-from-audit button → Slice 010
- Export (zip + manifest) → Slice 011
- Failed-classification UI surfaces (filter, retry button, color/icon indicators) → Slice 012. Note: this slice **does** write `processed_messages.status='failed'` rows when classification raises; what's deferred is the dedicated UI for surfacing them.
- `document_groups` / `document_group_members` (soft dedup grouping) → Slice 013
- Batch reclassification → Slice 014
- Sender allowlist/blocklist informing classification → Slice 015
- First-sync-window UI (date picker for "since when") → Slice 016 polish; this slice ships only the env-var default + an HTTP request body knob
- Pause / cancel a running sync → not planned for v1; if the user really needs to stop they can `docker compose restart`
- Multi-job concurrency → not planned for v1; one user, one sync at a time

## Detailed design

This slice realizes `architecture.md` § "Sync (manual trigger)", § "High-level architecture" (the file store), and § "Deduplication strategy" (hard dedup, soft dedup deferred). It composes the per-message pipeline from Slice 005 with persistence and a streaming progress channel; it also flips the Inbox from a live read-through view to a DB-backed view, fulfilling the "Slice 003 gets superseded by Slice 6" note in `initial-feature-slices.md`.

- **Sync trigger and lifecycle.** A single in-memory mutex enforces "one sync at a time" — adequate for a single-user tool. `POST /api/sync` starts the job and returns a `job_id`; the orchestrator runs in the same Node process and emits events to a shared `EventEmitter`. `GET /api/sync/events` is the SSE subscription; `GET /api/sync/status` is the snapshot lookup for clients who connect after work has begun. A ring buffer of recent events (~200) lets a late SSE subscriber catch up without missing the early per-account starts.
- **Account selection and message discovery.** Accounts in `status='needs_reauth'` are skipped (and a `sync.error` event is emitted for each, naming the account). For `status='connected'` accounts:
  - If `sync_state.last_history_id` exists and the request omits `since`, use the Gmail History API (`users.history.list`, read-only) to fetch only changed messages since that history id. The Slice 003 client wrapper is extended in this slice with `historyList({ start_history_id })` and `getProfile()` (the latter for fetching the current `historyId` after the first non-incremental sync).
  - Otherwise, search by date range using `users.messages.list` with `q='after:YYYY/MM/DD'`. The default range is `SYNC_DEFAULT_WINDOW_DAYS` days back from now.
  - After the first non-incremental sync completes for an account, `sync_state.last_history_id` is set so subsequent syncs can run incrementally.
- **Per-message processing.** For each message id from the discovery step (in the order Gmail returns):
  1. If `(account_id, message_id)` already exists in `processed_messages`, emit `sync.message` with the prior status and skip — strict idempotency.
  2. Fetch the full message via the Slice 003 client (`format='full'`, the same path Slice 005 already uses).
  3. Run the classification pipeline (Slice 005's `classifyMessage`). If it raises (Ollama unreachable, timeout, schema-violation), insert a `processed_messages` row with `status='failed'` and the error message; emit `sync.message` with `status: 'failed'` and continue with the next message.
  4. On success, decide which artifacts to persist:
     - If the model classified the message as `receipt` or `invoice`, persist all eligible artifacts: each receipt-shaped attachment (PDFs and images that the model identified as part of the receipt) and, when the body itself was the receipt and there is no equivalent attachment, the rendered body. This slice keeps the per-message decision simple — a single `classification` and `confidence` shared by all artifacts of that message — by trusting Slice 005's response. Per-artifact decisions are deferred to a later refinement (see Risks).
     - For each artifact: compute `content_hash = SHA-256(bytes)`. If `(account_id, content_hash)` is already in `documents`, skip with no `documents` row but include the artifact id in the `sync.message` event (so the UI can show "deduped"). Otherwise: write the file to disk via `files.ts`, insert the `documents` row.
     - Body-as-receipt: render the HTML via `renderHtmlToPdf` (Playwright) and persist the resulting PDF as `kind='rendered_body'`. **Skip rendering** when the same message also has a receipt-shaped PDF attachment (architecture's "prefer attachment" rule).
  5. Insert one `processed_messages` row per message (regardless of classification or artifact count), tagged with `account_id`, `model_used`, `classification`, `confidence`, `reason`, `sender_domain`, `subject`, `internal_date`, `processed_at=now`. Re-using the Slice 005 classifier means `model_used` is whatever Ollama reported.
  6. Emit `sync.message` with the document ids written.
- **File store layout.** `./invoices/{account_slug}/{yyyy}/{mm}/{message_id}_{seq}_{safe_filename}` — exactly the path documented in `architecture.md` § "Storage" and confirmed by Slice 002's `slug` column. `seq` disambiguates multiple artifacts from the same message. The orchestrator is the only writer; every write goes through `files.ts`, which validates that the resolved absolute path stays within the configured `./invoices/` root (path-traversal guard).
- **Inbox view replacement.** The Inbox's row component changes from "Subject + From + Date" (Slice 003) to "Vendor / Amount / Currency / Transaction Date / Subject / Sender / Preview link". When `vendor`, `amount`, `currency`, or `transaction_date` are NULL (the model didn't extract them), the columns render `—`. Editing these inline is a Slice 008 concern; for now they're read-only.
- **`processed_messages` JOIN cost.** Slice 004's `processed_messages` carries `subject` and `sender_domain` per row. The Inbox listing benefits from joining `documents` and `processed_messages` on `(account_id, message_id)` to surface those fields. The repository's `listForAccount` does this JOIN in a single query.
- **Per-account isolation.** A token error on one account during sync emits a `sync.error` event for that account, marks the account `status='needs_reauth'` (existing Slice 002 behavior), and continues with the remaining accounts. Other Gmail errors (rate limit, transient 5xx) are retried once with a short backoff per message; a second failure is recorded as `status='failed'` in `processed_messages`. Ollama unreachable errors are *not* retried per-message — they fail the message and continue; the user can re-run sync after fixing Ollama and the failed messages will be retried because they're recorded as `status='failed'` and the Slice 014 reclassification flow (or a future "retry failed" mechanism) handles re-attempting them.
- **Removing the dev seed panel.** Slice 004 introduced `DevSeedPanel.tsx`, `src/server/api/dev.ts`, and `GET /api/dev/enabled` as a temporary dev surface. This slice deletes them; the equivalent observable result ("rows in `processed_messages` for an account") is now produced by real sync. The Slice 004 endpoint `GET /api/accounts/:id/processed-messages` is **kept** — it has no real consumer until Slice 010, but it's a stable read endpoint and removing it would force Slice 010 to recreate it.
- **Playwright in Docker.** The Dockerfile build stage runs `npx playwright install --with-deps chromium`. The runtime stage copies the browser binary path so the executable is available at runtime. This adds significantly to image size; Slice 016 may revisit. The `postinstall` script in `package.json` mirrors this for local-dev `npm install`.
- **No notes column yet.** `architecture.md` § "Storage" lists a `notes` column on `documents`. This slice does not include it; it will land alongside the inline-editing UI in Slice 008 (or 016 polish if the team prefers minimal write surface in 008). Flag.

## Acceptance criteria

- With at least one connected Gmail account and Ollama reachable with `qwen2.5vl:7b` pulled, clicking "Sync now" on the Dashboard returns within ~1s and the SSE stream begins emitting `sync.start` and `sync.account.start` events.
- During the run, the Dashboard's per-account counters (`processed`, `receipts`, `failed`) increment as `sync.message` events arrive.
- After `sync.done`, browsing `./invoices/` on the host shows folders by `account_slug`, then by year and month, with one or more receipt files inside each populated month directory.
- For each persisted file, there is exactly one `documents` row whose `file_path` matches the on-disk relative path and whose `account_id` matches the slug.
- For every message processed, there is exactly one row in `processed_messages` for `(account_id, message_id)`. Receipt rows have `status='success'`, `classification IN ('receipt','invoice')`, and one or more `documents` rows. Non-receipt rows have `status='success'`, `classification='other'`, and zero `documents` rows. Errored rows have `status='failed'` and a populated `error_message`.
- Re-running "Sync now" with the same date range immediately afterwards processes zero new messages — `sync.account.done` reports `processed: 0` for each account (or `processed: N, receipts: 0` if the events include skipped messages, depending on how the SSE schema counts skips; the spec is `processed = newly inserted rows`).
- Stopping Ollama mid-sync produces `status='failed'` rows for the in-flight messages and `sync.message` events with `status: 'failed'`; the run continues until the discovery list is exhausted (or the user cancels by restarting the container).
- Disconnecting Wi-Fi mid-sync (or revoking one account's tokens) flips that account to `needs_reauth` and emits a `sync.error` event for it; the sync continues for the other connected accounts.
- The Inbox view at `/inbox`, after sync completes, lists the persisted `documents` rows for the picked account, ordered by `created_at DESC` by default. The "Preview" link opens the PDF or image in a new tab.
- An identical PDF arriving as both an attachment in message A and an attachment in message B inside the same account produces **one** row in `documents` (the second message's `processed_messages` row references the same `content_hash` but creates no second `documents` row).
- The dev seed panel from Slice 004 no longer renders on the Dashboard, and `GET /api/dev/enabled` returns 404.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes — the new `historyList` and `getProfile` calls go through `users.history.list` and `users.getProfile`, both read endpoints.
- The codebase contains no Gmail write API references and no OAuth scope strings beyond `gmail.readonly`, `userinfo.email`, `openid`.

## Risks / open questions

- **Single shared classification across artifacts.** When a message has both a receipt-shaped body and an unrelated promotional attachment, this slice's "trust the message-level classification" rule could persist the wrong artifact. The `classifyMessage` response from Slice 005 includes an `artifacts` array but only one decision; supporting per-artifact decisions requires changing the prompt. Provisional choice: ship message-level classification now, refine in a follow-up if false positives are common. Flag.
- **Playwright image size.** Adding chromium to the Docker image increases it by ~300 MB. Acceptable for a self-hosted tool; `architecture.md` § "Tech stack" already lists Playwright. Alternatives (e.g. `puppeteer-core` + a smaller chromium fork, or `chrome-aws-lambda`) save little for a non-serverless deployment. Flag.
- **History API correctness.** The Gmail History API has surprising edge cases (history records expire after ~7 days, IDs can become stale). The orchestrator's "fall back to date-range search if `historyList` returns 404" path is correct but worth confirming during implementation. Flag.
- **No first-sync-window UI.** The user can override the default 30-day window only via the `since` field in the `POST /api/sync` body — there is no Dashboard date picker. For initial bring-up this is fine (default is reasonable; testing can use `curl`); a real polish iteration in Slice 016 should add it. Flag.
- **`notes` column not added.** Architecture sketches it; this slice doesn't include it. If Slice 008 doesn't pick it up, Slice 016 should. Flag.
- **No retry for failed messages without reclassify.** Failed rows stay failed until Slice 012 ships the retry button (or Slice 014's batch reclassify is used). If many messages fail because Ollama was briefly down, the user has to wait for one of those slices to land. Acceptable tradeoff.
- **In-memory ring buffer for SSE.** A user who reloads mid-sync sees only the last ~200 events; the snapshot endpoint covers the gap. If sync involves thousands of messages this could miss events between the snapshot and the resubscribe. For correctness this doesn't matter (the persisted state is the source of truth); for UI smoothness it might. Flag.
- **Path-traversal guard in `files.ts`.** The implementation must resolve the destination path with `path.resolve` and verify it has the configured `./invoices/` directory as a prefix before writing. Filename sanitization alone isn't sufficient because `account_slug` could in principle be malicious — but slugs are derived from email addresses by Slice 002's slugifier, so this is defense in depth. Flag.
- **`ATTENTION: large attachments`.** Slice 005's 5 MB attachment cap and 5-page PDF cap apply to the *classifier input*. Persisting an attachment to `documents` does **not** apply those caps — a real 50-MB PDF receipt should be stored as-is. The orchestrator's "fetch full message → run classifier → persist artifacts" loop fetches each attachment once via `getAttachment` and uses the original bytes for both the classifier input (potentially after PDF→image rendering with caps) and disk storage (no caps). Worth flagging because it implies storing something the classifier may not have fully seen.
