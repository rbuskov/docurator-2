# Slice 006: Sync and store receipts — Plan

**Spec:** `docs/specs/006-sync-and-store-receipts.md`
**Research:** `docs/research/006-sync-and-store-receipts.md`

## Steps

Each step is small enough to fit in one loop iteration. Each step ends with a concrete verification — a named test passing, or a specific command's output. Per-step refactor is folded into the priority-3 action. The research doc identified two ADRs the slice should produce; each is attached to the step that triggers the decision.

- [x] **Step 1: Install `playwright` runtime dep + postinstall script.** Edit `package.json` to add `playwright ^1.x` to `dependencies` and a `postinstall: playwright install chromium` script that runs `playwright install chromium` (no `--with-deps`; users running on Linux without Docker may need apt deps separately, documented under "Risks"). Run `npm install`. Verification: `npm install` exits 0; `package-lock.json` shows the new entry; `npx playwright --version` works; `npm run check:gmail-readonly` exits 0; `npm run typecheck` exits 0; `npx vitest run` continues to pass (no new tests yet). If the postinstall fails inside the devcontainer due to missing apt deps, document the actual failure and either run `npx playwright install --with-deps chromium` once with sudo or add the apt deps to the devcontainer's `Dockerfile`.

  _Done: installed `playwright@1.59.1` (the latest 1.x). Postinstall script `playwright install chromium` added to `package.json`. `npx playwright install chromium` fetched both `chromium-1217` and `chromium_headless_shell-1217` to `~/.cache/ms-playwright/`. **Devcontainer apt-deps are not installed** (libnspr4, libnss3, libatk*, libcups2, libxkbcommon0, libasound2, libgbm1, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libatspi2.0-0); chromium-1217 fails to launch with `error while loading shared libraries: libnspr4.so`. Sudo in this devcontainer requires a password (no passwordless config), so the agent cannot apt-install during the loop run. **Flagging for the review**: Step 11's `render-html-pdf.test.ts` will fail in this environment until the user runs `sudo npx playwright install-deps chromium` once on the host, or the devcontainer's Dockerfile is updated to bake those libs in. Same shape as Slice 005's smoke deferred-AC pattern. **Test-harness ripple:** the inflated node_modules (~250 MB after Playwright + chromium) pushed `api/classify.test.ts`'s first-test cold-start past the 15s timeout Slice 004 set. Bumped `vitest.config.ts` `testTimeout` from 15000 to 30000 with an inline comment naming the cause. Real assertion failures still surface within seconds. Full suite: 43 files / 382 tests / 0 failures in 40.30s post-bump (was 23.03s in Slice 005's final test run; the difference is dominated by Playwright's resolution chain, not test work). `npm run check:gmail-readonly` OK; `npm run typecheck` clean._

- [x] **Step 2: Add `syncDefaultWindowDays`, `maxConcurrentClassify`, `invoicesDir` to `src/server/config.ts`.** Extend `src/server/config.test.ts` with three default cases + three env-override cases + a NaN-fallback case for `MAX_CONCURRENT_CLASSIFY`. Run vitest — **red**. Implement: defaults `30`, `1`, `'./invoices'`; env vars `SYNC_DEFAULT_WINDOW_DAYS`, `MAX_CONCURRENT_CLASSIFY`. `invoicesDir` has no env override (path is implicit; tests inject a different path via a private setter or `vi.resetModules` + temp config file). Re-run **green**. Verification: `npx vitest run src/server/config.test.ts` passes.

  _Done: 7 new tests (3 default + 3 env-override + 1 NaN-fallback for `MAX_CONCURRENT_CLASSIFY`; same shape as the Slice 005 timeout test). The window-days parser also rejects zero/negative + NaN, matching the timeout-parser convention from Slice 005. `invoicesDir` has no env override, only a constant default — tests reach for it via the imported `config` object. 27/27 green in 37ms._

- [x] **Step 3: Plumbing — `.env.example` + `invoices/.gitkeep` + startup `mkdirSync` for invoices dir.** Append two commented sections to `.env.example` for `SYNC_DEFAULT_WINDOW_DAYS` and `MAX_CONCURRENT_CLASSIFY`. Create `invoices/.gitkeep`. Edit `src/server/index.ts` to add `mkdirSync(resolve(config.invoicesDir), { recursive: true })` next to the existing data-dir mkdirSync. No test framework covers this directly; verification is `git diff` shows the three changes and the existing `app.test.ts` continues to pass after a fresh boot.

  _Done: three edits as planned. `.env.example` now documents `SYNC_DEFAULT_WINDOW_DAYS` and `MAX_CONCURRENT_CLASSIFY` next to the OLLAMA block. `invoices/.gitkeep` created (empty file). `src/server/index.ts` has `mkdirSync(resolve(config.invoicesDir), { recursive: true })` immediately after the data-dir mkdirSync, so first-run on a fresh host creates `./invoices/` before migrations run. `npm run typecheck` clean; `app.test.ts` 3/3 passes._

- [ ] **Step 4: Migration `0005_create_documents.sql` + tests.** Extend `src/server/db/migrations.test.ts` with a `describe('0005_create_documents.sql', …)` block (mirrors Slice 004's per-table blocks):
  - `PRAGMA table_info(documents)` returns the spec's columns with the right NOT NULL / nullable distribution.
  - `id` has `pk: 1`; INTEGER PRIMARY KEY AUTOINCREMENT (verified via `sqlite_sequence` presence after an insert).
  - `kind` CHECK enforces `attachment` / `rendered_body`.
  - `review_status` CHECK enforces `pending` / `approved` / `rejected`; default is `pending`.
  - `PRAGMA foreign_key_list` shows one FK row referencing `accounts(id)`.
  - `(account_id, content_hash)` UNIQUE: two inserts with the same pair throws on the second.
  - Same `content_hash` across two different `account_id` values both insert successfully (cross-account dedup is intentionally absent).
  - `(account_id, review_status, created_at)` and `(account_id, message_id)` indices via `PRAGMA index_list` + `index_xinfo` (column composition, not name guessing).

  Run vitest — **red**. Implement the SQL file (one CREATE TABLE + two CREATE INDEX statements). Re-run **green**. Verification: `npx vitest run src/server/db/migrations.test.ts` passes; the four prior describe blocks (0001-0004) stay green.

- [ ] **Step 5: `src/server/db/repositories/documents.ts` + tests.** Mirror the shape of `processed_messages.ts`. New test file `src/server/db/repositories/documents.test.ts` covering:
  - `existsByHash` false / true.
  - `insert` returns the surrogate id; `findById(id)` returns the row.
  - `listForAccount({ account_id, limit, offset })` orders `created_at DESC`, respects limit + offset, returns `{ rows, total }`.
  - `listForAccount({ ..., review_status: 'pending' })` filters.
  - FK constraint: insert with non-existent `account_id` throws.
  - UNIQUE constraint: second insert with the same `(account_id, content_hash)` throws.
  - Latest-attempt JOIN test: insert two `processed_messages` rows for the same `(account_id, message_id)` (different `processed_at`); `listForAccount` returns the latest attempt's classification + subject + sender_domain.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/db/repositories/documents.test.ts` passes (≥ 7 cases).

- [ ] **Step 6: `src/server/files.ts` (writeReceiptFile) + tests.** New test file `src/server/files.test.ts` using a `mkdtempSync` invoices root:
  - Writes bytes to the right path under `{slug}/{yyyy}/{mm}/...`.
  - Returns `{ file_path, content_hash, size }`; hash matches `crypto.createHash('sha256')` independently.
  - Filename sanitization: pathological inputs (`../../etc/passwd`, `foo/../bar`, `con.txt`, very long names, control chars) produce safe basenames.
  - Path-traversal guard: even after sanitization, the resolved absolute path stays inside the invoices root; if (somehow) it would escape, throws.
  - Year/month projection from `internal_date` epoch-ms is correct for known timestamps.
  - Atomic write: writes to `<final>.tmp` then renames; mid-write process death leaves no partial final file.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/files.test.ts` passes (≥ 6 cases).

- [ ] **Step 7: Refactor `classifyMessage` to return optional `source_bytes`.** This is the foundation that lets the sync orchestrator persist what the classifier saw without re-fetching. Extend `src/server/classify/index.ts`'s `ClassifyResponse` extension (or add a new outer return wrapper — see below) so the function returns `{ ...verdict, model_used, artifacts, source_bytes?: Map<string, Buffer> }` where `source_bytes` keys are stable artifact descriptors (e.g. `attachment:invoice.pdf`, `body:rendered_html_source`). The `body:rendered_html_source` slot holds the raw HTML string when html_was_used so the orchestrator can run Playwright on it; the orchestrator computes the rendered-body PDF bytes in its own step. Update Slice 005's existing tests in `src/server/classify/index.test.ts` to assert on the new field where relevant; the prior assertions stay (the field is additive).

  Run vitest — **red** (new assertion). Implement. Re-run **green**. Verification: `npx vitest run src/server/classify/index.test.ts` passes; Slice 005's other tests (`api/classify.test.ts` was deleted in step 23 below — but at this point it still exists; the route's success-path test already asserts on the spec's response shape and remains green because new optional fields don't break exact-equality checks **unless those tests use `toEqual` with the old shape** — adjust if so).

  Note: this step ships *before* the dev-seed and Slice-005 surface removal (step 23). At the point this step lands, `classify.ts` and `ClassifyRowAction.tsx` are still present; they carry through unchanged because `source_bytes` is optional and they ignore it.

- [ ] **Step 8: Add `historyList` and `getProfile` to `src/server/gmail/client.ts`.** Extend `src/server/gmail/client.test.ts` with two new describe blocks (mirrors the existing `getAttachment` block from Slice 005). Cases:
  - `historyList({ start_history_id, history_types?, page_token? })` calls `users.history.list` with the right params; returns `{ history: ..., next_page_token, history_id }`.
  - `historyList` rethrows session errors verbatim.
  - `getProfile()` calls `users.getProfile` with `userId: 'me'`; returns `{ history_id, email_address, messages_total, threads_total }`.
  - Both methods route through `withFreshTokens` with the bound `accountId`.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/gmail/client.test.ts` passes; `npm run check:gmail-readonly` still exits 0 (`history.list` and `getProfile` are read endpoints; no forbidden substring is introduced).

- [ ] **Step 9: `src/server/sync/discovery.ts` (history vs range) + tests.** Pure function `chooseDiscovery({ syncState, since, fallbackDays, now }): { kind: 'history', start_history_id } | { kind: 'range', q }`. Tests:
  - With `since` set, returns `{ kind: 'range', q: 'after:YYYY/MM/DD' }` (slashes, not dashes — Gmail's `q` syntax).
  - With `last_history_id` and no `since`, returns `{ kind: 'history', start_history_id }`.
  - Without either, returns `{ kind: 'range' }` using `fallbackDays`-back-from-`now`.
  - `since` overrides `last_history_id`.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/sync/discovery.test.ts` passes.

- [ ] **Step 10: `src/server/sync/events.ts` (typed emitter + ring buffer) + tests + write ADR-008.** Module exports a singleton `syncEvents` with typed `emit<E>(event, payload)`, `subscribe(): AsyncIterable<{event, payload}>`, `recent(): {event, payload}[]` returning the ring contents, and a `RING_CAPACITY = 200` constant. Tests:
  - Emit-then-subscribe round-trip (subscribers receive subsequent events).
  - Late subscriber receives the ring buffer's recent contents on first iteration.
  - Ring drops the oldest after `RING_CAPACITY` emits.
  - Two subscribers each receive each event.
  - Unsubscribing (returning from the iterator) does not block emit.

  Run vitest — **red**. Implement (Node `EventEmitter` underneath; `subscribe` builds an async iterator with a queue + a resolver). Re-run **green**. **Write `docs/adr/008-sse-with-ring-buffer.md`**: justify SSE over WebSocket (lighter, fits Hono's streaming API, browser native EventSource), over long-polling (more requests, harder to keep state); justify a 200-event ring buffer over a persisted event log (event content is duplicative of `processed_messages` rows; a UI-side replay is enough for late subscribers; persistence costs more without a clear read pattern). Numbering: 008 because Slice 005 shipped 005 and 006; this slice's first ADR is 007 (single-job mutex, step 12) and 008 here. Re-numbering between steps 10 and 12 is fine since no other ADRs land between them; whichever step ships first claims 007, and the other claims 008. Verification: `npx vitest run src/server/sync/events.test.ts` passes; the ADR file exists.

- [ ] **Step 11: `src/server/classify/render-html-pdf.ts` (Playwright HTML→PDF) + tests.** Pure function `renderHtmlToPdf(html: string): Promise<Buffer>`. Implementation per the research doc: launch chromium headless, `setContent` with `waitUntil: 'networkidle'`, `page.pdf({ format: 'A4', printBackground: true })`, close the browser in `finally`. Test file `src/server/classify/render-html-pdf.test.ts`:
  - Real Playwright run with a small HTML fixture; assert the buffer starts with `%PDF-1.` magic bytes. Mark as `it` (not skipped) — slow (~1-2 s) but reliable. If the devcontainer doesn't have apt deps for chromium, the test fails with a clear missing-lib message; the plan adds the apt-deps step or `--with-deps` install once.
  - Buffer is non-empty and at least a few KB.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/classify/render-html-pdf.test.ts` passes; the produced PDF is a real PDF.

  Note: this step depends on step 1's Playwright install having succeeded. If chromium can't launch in the devcontainer, the next step's orchestrator-level test stubs `renderHtmlToPdf` at the deps boundary and the smoke recipe defers visual verification of the rendered-body case to human acceptance.

- [ ] **Step 12: `src/server/sync/orchestrator.ts` skeleton + happy-path test + write ADR-007.** New file. Exports `runSync({ account_ids?, since? })` returning `Promise<{ job_id }>` (the function returns once the job is running; it does not await the orchestrator's full completion — the SSE stream is the completion channel). Internals:
  - Single-job mutex (module-level `let activeJob` + `acquireJob` / `releaseJob`).
  - Iterate `accounts.list()` filtered to `status='connected'` (intersect with `account_ids` if provided).
  - For each account, emit `sync.account.start`, run the discovery step (step 9), iterate the message ids, run the per-message pipeline (step 7's `classifyMessage`), persist via the per-message transaction, emit `sync.message`, emit `sync.account.done` at the end.
  - `runSync` returns the job_id immediately; the orchestrator runs in a fire-and-forget promise that emits `sync.done` and releases the mutex on completion or error.

  Test file `src/server/sync/orchestrator.test.ts`:
  - Happy path with one connected account, one receipt-shaped message: `processed_messages` has 1 row with `status='success', classification='receipt'`; `documents` has 1 row with the right `account_id`, `kind='attachment'`, `file_path`, `content_hash`; the file is written under the temp invoices root; SSE events fire in order (`sync.start`, `sync.account.start`, `sync.message`, `sync.account.done`, `sync.done`).
  - Mutex check: a second `runSync` call while the first is in flight rejects with a recognizable error (the API layer maps it to 409).

  Run vitest — **red**. Implement (skeleton + happy-path only). Re-run **green**. **Write `docs/adr/007-in-memory-single-job-mutex.md`**: justify the in-memory mutex over a DB-backed `jobs` table (no need for restart-recovery in v1's single-user context — a `docker compose restart` mid-sync is acceptable; the next sync resumes from `processed_messages`-based idempotency). Document the implication: container restart drops in-flight job state (acceptable). Verification: `npx vitest run src/server/sync/orchestrator.test.ts` passes; the ADR file exists.

- [ ] **Step 13: Orchestrator dedup path test + impl.** Add a test case where the same `content_hash` arrives twice in one account: the second message's `processed_messages` row inserts with `status='success'` and the dedup-hit document_id is included in the SSE event; no new `documents` row is created. Implement: the per-message transaction catches the SQLite unique-constraint violation from `documents.insert` and falls back to `existsByHash` + `findExistingDocument` to look up the prior row's id (helper added to `documents.ts` if needed). Verification: `npx vitest run src/server/sync/orchestrator.test.ts` passes (≥ 3 cases).

- [ ] **Step 14: Orchestrator needs_reauth + token-error handling.** Add tests:
  - Account in `needs_reauth` is skipped (no work done); `sync.error` event emitted naming the account.
  - Token error mid-account (`invalid_grant`) flips that account to `needs_reauth` via `accounts.updateStatus`, emits `sync.error`, and continues with the next account.
  - Generic Gmail error (e.g. rate limit 429): retried once with a short backoff; second failure → `processed_messages.status='failed'` row + `sync.message` with `status: 'failed'`; no needs_reauth flip.

  Implement. Verification: `npx vitest run src/server/sync/orchestrator.test.ts` passes (≥ 6 cases).

- [ ] **Step 15: Orchestrator incremental history + range fallback.** Add tests:
  - With `sync_state.last_history_id` set, the orchestrator calls `client.historyList({ start_history_id })` (mocked) instead of `listMessages`.
  - When `historyList` throws a 404-shaped error (`response.status === 404`), the orchestrator catches and falls back to a range search via `listMessages` + `getProfile` (the latter to refresh `last_history_id` after the range sync).
  - After a successful range or history sync, `sync_state.upsert(...)` records the new `last_history_id` (from `getProfile`) and `last_synced_at`.

  Implement. Verification: `npx vitest run src/server/sync/orchestrator.test.ts` passes (≥ 9 cases).

- [ ] **Step 16: Orchestrator body-as-receipt path.** Add tests:
  - When `body.html_was_used` is true and there's no eligible receipt-shaped attachment, the orchestrator calls `renderHtmlToPdf(source_html)` (mocked at the deps boundary), persists the resulting PDF as `kind='rendered_body'`, and references the same `processed_messages` row.
  - When both an HTML body *and* a receipt-shaped PDF attachment exist, the orchestrator skips the body rendering (prefer-attachment rule) and persists only the attachment.

  Implement. Verification: `npx vitest run src/server/sync/orchestrator.test.ts` passes (≥ 11 cases). The orchestrator is now fully covered for the slice's behaviors; subsequent steps wire it to HTTP and UI.

- [ ] **Step 17: `src/server/api/sync.ts` + wire into `app.ts`.** New file. `registerSyncRoutes(app, { runSync? })` registers:
  - `POST /api/sync` with `zValidator('json', bodySchema)` (`{ account_ids?: number[], since?: 'YYYY-MM-DD string' }`). Calls `runSync(args)`. Returns 202 `{ job_id, started_at }`. Returns 409 `{ error: 'sync_in_progress', job_id }` when the mutex is held. Returns 400 on body validation failure.
  - `GET /api/sync/events` opens an SSE stream subscribed to the events module's emitter; first replays the ring buffer.
  - `GET /api/sync/status` returns the snapshot from the events module's job-state tracker.

  Test file `src/server/api/sync.test.ts`:
  - 202 happy path with a stubbed `runSync`.
  - 400 on malformed body.
  - 409 on a second POST while the first job is in flight (stubbed mutex).
  - SSE: `app.fetch` returns a streaming Response; reading the body yields the right `data: <json>` lines.
  - `GET /api/sync/status` returns `{ active: false }` when idle and `{ active: true, job_id, ... }` during a job.

  Wire `registerSyncRoutes(app)` into `createApp()` in `src/server/app.ts`.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/api/sync.test.ts src/server/app.test.ts` all green.

- [ ] **Step 18: `src/server/api/documents.ts` + wire into `app.ts`.** New file. `registerDocumentsRoutes(app, { invoicesDir? })` registers:
  - `GET /api/accounts/:id/documents?limit=&offset=&review_status=` — uses `requireConnectedAccount` (or a relaxed variant that doesn't require an in-memory session, since reading documents doesn't need Gmail tokens). Returns `{ rows, total }` from the documents repo.
  - `GET /api/documents/:id/file` — reads the doc row, resolves the absolute path, asserts inside-invoices-root, sets `Content-Type` from the row's `mime_type`, streams the bytes.

  Test file `src/server/api/documents.test.ts`:
  - 400 on invalid `:id`, 404 on unknown account, 200 on the listing happy path.
  - `?limit=` / `?offset=` / `?review_status=` filters work and pagination math is right.
  - File streaming: 200 with correct Content-Type; 404 when the row doesn't exist; 404 when the file is missing on disk; 403 (or 404) when the resolved path would escape the invoices root.

  Note: the documents listing should *not* require an in-memory OAuth session (the prior `requireConnectedAccount` flips to `needs_reauth` when no session exists). Plan: introduce a sibling helper `requireKnownAccount(id)` in `src/server/auth/preconditions.ts` that returns 404 on unknown but does *not* require a session — pure DB lookup. Update `requireConnectedAccount` to call into the new helper so the existing handlers stay green. Decision flagged for the review.

  Wire `registerDocumentsRoutes(app)` into `createApp()` in `src/server/app.ts`.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/server/api/documents.test.ts src/server/auth/preconditions.test.ts` all green.

- [ ] **Step 19: Client types + `useSyncEvents.ts` hook + tests.** Edit `src/client/types.ts` to add `Document`, `SyncStatus`, `SyncEvent` matching the API responses. New `src/client/hooks/useSyncEvents.ts` and `useSyncEvents.test.ts`. Hook subscribes to `/api/sync/events` via `EventSource`, maintains a per-account counters object, exposes `{ active, accounts }` for components. Tests stub `EventSource` (jsdom doesn't ship it; use a small fake). Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/client/hooks/useSyncEvents.test.ts` passes.

- [ ] **Step 20: `src/client/components/SyncControls.tsx` + tests.** New file. Renders "Sync now" button when idle; disables and shows "Syncing…" while active. Hooks into `useSyncEvents` for live counters. Per-account "Sync" buttons on each account row are out of scope this step (the spec lists them but the simpler "Sync all" button covers AC #1; per-account buttons can land as a follow-up if useful — flag for the review). Test file `src/client/components/SyncControls.test.tsx`:
  - Renders Sync button when status is `{active: false}`.
  - Click → POSTs `/api/sync`; on 202 the button disables.
  - With `useSyncEvents` reporting an active job, renders per-account counters.
  - On `sync.done`, button re-enables.

  Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/client/components/SyncControls.test.tsx` passes (≥ 4 cases).

- [ ] **Step 21: Replace `src/client/views/Inbox.tsx` data source.** Wholesale rewrite of the messages-fetching flow: switch from `GET /api/accounts/:id/messages?limit=50` to `GET /api/accounts/:id/documents?limit=50&offset=0`. New columns: Vendor / Amount / Currency / Transaction Date / Subject / Sender Domain / Created At / Preview link (anchor opening `/api/documents/:id/file` in `_blank`). NULL extracted fields render as `—`. Picker scaffolding + `LAST_INBOX_ACCOUNT_KEY` localStorage behavior preserved. Drop the `<ClassifyRowAction>` import (the component is being deleted in step 23). Rewrite `src/client/views/Inbox.test.tsx` to assert on the new column shape, the empty state, the picker change refetch, and the 409 needs-reconnect path. Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/client/views/Inbox.test.tsx` passes; existing test count of 10 may shrink or grow, but all green.

- [ ] **Step 22: Dashboard wiring — remove `<DevSeedPanel />`, add `<SyncControls />`.** Edit `src/client/views/Dashboard.tsx`: remove the `DevSeedPanel` import + render; add `SyncControls` import + render between `<OllamaHealth />` and `<AccountList />`. Edit `src/client/views/Dashboard.test.tsx`: remove the dev-tools-panel test; remove the `/api/dev/enabled` mocks from the `beforeEach` and the URL-routed `mockImplementation` cases; add `/api/sync/status` mocks returning `{ active: false }`; add a new test asserting `<SyncControls />` renders. Run vitest — **red**. Implement. Re-run **green**. Verification: `npx vitest run src/client/views/Dashboard.test.tsx` passes; the existing test count drops by 1 (the dev-tools test goes) and gains 1 (the sync-controls test).

- [ ] **Step 23: Delete the dev-seed and Slice-005 surfaces.** Delete:
  - Server: `src/server/api/dev.ts`, `src/server/api/dev.test.ts`, `src/server/api/processed_messages.ts`, `src/server/api/processed_messages.test.ts`, `src/server/api/classify.ts`, `src/server/api/classify.test.ts`.
  - Client: `src/client/views/DevSeedPanel.tsx`, `src/client/views/DevSeedPanel.test.tsx`, `src/client/components/ClassifyRowAction.tsx`, `src/client/components/ClassifyRowAction.test.tsx`.
  - Edit `src/server/app.ts` to drop `registerDevRoutes`, `registerProcessedMessagesRoutes`, `registerClassifyRoutes` registrations and their imports.
  - Search for stale references (`grep -rn DevSeedPanel|ClassifyRowAction|registerDevRoutes|registerProcessedMessagesRoutes|registerClassifyRoutes src/`).

  Run `npm run typecheck` — should be clean (the orchestrator and tests don't import the deleted surfaces). Run `npx vitest run` — full suite still green. Verification: `npx vitest run` passes; `grep` finds no stale references; the deleted files no longer appear in `git ls-files`.

## Smoke test recipe

The exact sequence the loop will run after all plan steps are checked. Same shape as Slice 005's recipe — server-side gates verifiable from the agent shell, browser-driven ACs deferred to human acceptance.

1. **Setup gates.** From the devcontainer: `git status` clean (apart from the unrelated README change in the working tree from the user's mid-loop interruption — Slice 006's commit will not stage that file). `npm install` (validates Playwright postinstall succeeds; if chromium can't install, document the apt-deps fallback). `npm run check:gmail-readonly` exits 0. `npm run typecheck` exits 0. `npx vitest run` — full suite green (count noted in `## Test run`).
2. **Production build + boot.** `npm run build`. `APP_PORT=3738 NODE_ENV=production node dist/server/index.js` — boots cleanly, creates `./invoices/` if absent.
3. **Endpoint shape.** `curl http://localhost:3738/health` → `ok`. `curl http://localhost:3738/api/accounts` → 200 with the user's two real accounts. `curl http://localhost:3738/api/sync/status` → `{"active":false}`. `curl http://localhost:3738/api/dev/enabled` → 404 (route removed; not just gated).
4. **POST /api/sync without a connected session.** With the production restart having cleared in-memory tokens, `curl -X POST http://localhost:3738/api/sync -H 'Content-Type: application/json' -d '{}'` returns 202 immediately with a `job_id`. `curl -N http://localhost:3738/api/sync/events` (in another shell) shows `sync.start` event, `sync.error` events for each account (no in-memory session), and `sync.done`. The orchestrator handles the no-session case by emitting `sync.error` and continuing — no panic.
5. **Documents listing.** `curl 'http://localhost:3738/api/accounts/1/documents?limit=10'` returns `{"rows":[],"total":0}` (no documents written yet — the smoke run doesn't have real OAuth session).
6. **File-store path-traversal guard.** Construct a `documents` row by hand (via better-sqlite3) with a `file_path` that escapes the invoices root, then `curl http://localhost:3738/api/documents/<id>/file` — should 403 / 404 (defense-in-depth). *(Optional smoke step; the unit test `api/documents.test.ts` already pins this property.)*
7. **Read-only Gmail discipline (AC).** `npm run check:gmail-readonly` exits 0. `grep -E 'googleapis.com/auth/[a-z.]+' src/ -rn` returns only `userinfo.email` and `gmail.readonly`. No Gmail-write substring anywhere.
8. **Browser-driven ACs (deferred to human acceptance).**
   - Click "Sync now" with a real connected Gmail account + Ollama running with `qwen2.5vl:7b` pulled.
   - Watch the SSE stream emit per-account progress live in the Dashboard.
   - Browse `./invoices/` on the host — folders by `account_slug`, then year/month, with PDF/PNG receipts inside.
   - The `documents` table has one row per persisted file; `processed_messages` has one row per processed message.
   - Re-running "Sync now" with the same window inserts zero new rows (idempotency).
   - Inbox view at `/inbox` shows the persisted documents; "Preview" link opens the file in a new tab.
   - Stop Ollama mid-sync → `processed_messages.status='failed'` rows + `sync.message` events with `status: 'failed'`; the run continues.
   - Revoke one account's tokens (in Google account settings) → `sync.error` for that account; other accounts continue.
   - Hard dedup: an identical PDF arriving in two messages produces one `documents` row.
9. **`git status` clean** (apart from the unrelated README change). All slice-006 work committed at priority 7.

Smoke steps 1-7 cover what's verifiable from the agent shell; step 8 is the deferred-to-human-acceptance set; step 9 confirms a clean working tree before priority 6 writes the review.

## Test run

(Populated by priority-4 action.)

## Smoke run

(Populated by priority-5 action.)
