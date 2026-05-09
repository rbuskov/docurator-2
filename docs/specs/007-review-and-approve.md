# Slice 007: Review and approve

**Status:** ready

## Observable result

I can open the Review view, see captured receipts from all my connected accounts in a single confidence-ascending queue, look at each one side-by-side with its metadata, and approve or reject it (with `a` / `r` / `j` / `k` keyboard shortcuts) — finishing a session of triage in a few minutes.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` — including `confidence`, `sender_domain`, `subject`, `internal_date` (Slice 004) populated by sync (Slice 006)
  - `documents` — including `review_status`, `vendor`, `amount`, `currency`, `transaction_date`, `kind`, `file_path` (Slice 006)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
  - `0002_create_processed_messages.sql` (Slice 004)
  - `0003_create_sync_state.sql` (Slice 004)
  - `0004_create_app_config.sql` (Slice 004)
  - `0005_create_documents.sql` (Slice 006)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/documents/:id/file` (Slice 006) — drives the preview pane
- **UI views / components:**
  - `Dashboard.tsx` at `/` (Slice 002)
  - `Inbox.tsx` at `/inbox` (Slice 003, data source replaced by Slice 006) — unchanged here; this slice adds a parallel `/review` surface
  - `Nav.tsx`, `AccountPicker.tsx` (Slice 003)
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006) — produces the `documents` rows this slice triages
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/documents.ts` (Slice 006), `src/server/db/repositories/processed_messages.ts` (Slice 004)
  - `src/client/main.tsx` (Slice 001)
  - `src/client/App.tsx` (Slice 001)
  - `src/client/api.ts` (Slice 002)
  - `src/client/router.tsx` (Slice 003)
- **External services:** —
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `review_actions` table:
    - `id` INTEGER PRIMARY KEY AUTOINCREMENT
    - `document_id` INTEGER NOT NULL REFERENCES `documents`(`id`)
    - `action` TEXT NOT NULL CHECK (`action` IN ('approved','rejected','edited','tagged')) — only `approved`/`rejected` are written by this slice; `edited` and `tagged` are reserved for Slices 008 and 009
    - `details` TEXT NULL — JSON blob; this slice writes `NULL` for approve/reject (no extra detail beyond the action and timestamp)
    - `at` TEXT NOT NULL — ISO 8601 timestamp
    - INDEX on `(document_id, at)` for showing a doc's review history (used by Slice 008's edit history surfacing if any; the index is cheap to add now)
  - `senders` table:
    - `account_id` INTEGER NOT NULL REFERENCES `accounts`(`id`)
    - `domain` TEXT NOT NULL — sender domain (e.g. `stripe.com`, lowercased, no leading `@`)
    - `approved_count` INTEGER NOT NULL DEFAULT 0
    - `rejected_count` INTEGER NOT NULL DEFAULT 0
    - `last_seen_at` TEXT NULL — ISO 8601 timestamp; updated on each approve/reject
    - PRIMARY KEY (`account_id`, `domain`)
- **Migrations:**
  - `0006_create_review_actions.sql`
  - `0007_create_senders.sql`
- **API endpoints:**
  - `GET /api/review/queue?limit=&offset=&account_id=` → response `{ rows: Array<ReviewQueueRow>, total: number }`. `ReviewQueueRow` joins `documents` and `processed_messages`: `{ document_id, account_id, account_email, account_slug, message_id, kind, mime_type, file_path, vendor, amount, currency, transaction_date, subject, sender_domain, internal_date, confidence, classification, model_used, reason }`. Filters: `review_status='pending'` always (the queue is pending docs; non-pending docs live in the Inbox view); optional `account_id` narrows to one account. Order: `confidence ASC` (custom rank `low < medium < high`, NULL last), then `internal_date ASC` (oldest first within a confidence band), then `documents.id ASC` for stability.
  - `POST /api/documents/:id/approve` → no request body. Sets `review_status='approved'`, sets `updated_at=now`, increments `senders.approved_count` for the doc's `(account_id, sender_domain)`, sets `senders.last_seen_at=now`, inserts a `review_actions` row with `action='approved'`. Returns HTTP 200 `{ document_id, review_status: 'approved' }`. Returns HTTP 409 if the doc is already non-pending (with current status), letting the UI surface "this was already reviewed".
  - `POST /api/documents/:id/reject` → mirror of approve: `review_status='rejected'`, `senders.rejected_count++`, `review_actions.action='rejected'`. Same response shape and 409 behavior.
- **UI views / components:**
  - `Review.tsx` — at route `/review`. Top bar: account filter dropdown (driven by `GET /api/accounts`, default "All accounts"), counter ("23 left to review"). Main area: left ~60% preview pane, right ~40% metadata pane, bottom action bar with Approve and Reject buttons. Empty state ("Nothing pending — run Sync") and done state ("All caught up — N approved, M rejected this session"). Loads the queue (`GET /api/review/queue?limit=50&account_id=…`) on mount and prefetches the next 10 rows when the user is within 5 of the cursor end.
  - `ReviewPreview.tsx` — preview pane. Renders PDFs via `react-pdf` (architecture's choice), images via a native `<img src=…>` against `GET /api/documents/:id/file`. Other MIME types (rare; the corpus is mostly PDFs and PNGs/JPEGs from Slice 006) render a "Open file" link instead of inline preview.
  - `ReviewMetadata.tsx` — metadata pane. Read-only labels for: account email + display name (with the slug as a small grey hint), classification + confidence + model's stated reason, vendor / amount / currency / transaction_date (each "—" when null), sender domain, subject, message internal date. Inline editing of vendor/amount/currency/transaction_date is **out of scope for this slice** (Slice 008).
  - `ReviewActions.tsx` — Approve and Reject buttons + a keyboard hint footer ("`a` approve · `r` reject · `j`/`k` next/prev").
  - `useReviewKeyboard.ts` — global keyboard listener that fires `approve`, `reject`, `next`, `prev` actions. Bound while `Review.tsx` is mounted; ignored when an input/textarea is focused so it stays out of Slice 008's edit fields' way.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/db/migrations/0006_create_review_actions.sql`
  - `src/server/db/migrations/0007_create_senders.sql`
  - `src/server/db/repositories/review_actions.ts` — `insert({ document_id, action, details? })`, `listForDocument(document_id)`. Append-only.
  - `src/server/db/repositories/senders.ts` — `incrementApproved({ account_id, domain })`, `incrementRejected({ account_id, domain })` (each implemented as `INSERT … ON CONFLICT(account_id, domain) DO UPDATE SET …` so the row is created lazily on first encounter), `get({ account_id, domain })`, `listForAccount({ account_id })`.
  - `src/server/api/review.ts` — registers `GET /api/review/queue`, `POST /api/documents/:id/approve`, `POST /api/documents/:id/reject`. Approve/reject run inside a single SQLite transaction so the `documents` update, `senders` upsert, and `review_actions` insert are atomic.
  - `src/client/views/Review.tsx`
  - `src/client/components/ReviewPreview.tsx`, `src/client/components/ReviewMetadata.tsx`, `src/client/components/ReviewActions.tsx`
  - `src/client/hooks/useReviewKeyboard.ts`
  - `src/client/router.tsx` — modified to register `/review` → `Review`
  - `src/client/components/Nav.tsx` — modified to add a "Review" link with a small badge showing pending count (sourced from `GET /api/review/queue?limit=1` total, polled on Nav mount and after every approve/reject)
  - `package.json` updates: adds `react-pdf` to runtime deps (architecture choice). The Vite config already serves static assets; PDF.js worker is loaded from `react-pdf`'s bundled path.
- **External services:** —
- **Other:**
  - First slice that writes to `review_actions`. The table is append-only; no UI to delete or amend a row in this slice. Slice 008 will add `action='edited'` rows; Slice 009 will add `action='tagged'`.
  - First slice that writes to `senders`. The auto-increment counters are consumed by Slice 015's auto-skip / auto-flag logic; this slice produces the data but does not yet read from it.

## Out of scope

- Inline editing of `vendor` / `amount` / `currency` / `transaction_date` in the metadata pane → Slice 008
- The `vendor_edited` / `amount_edited` / `date_edited` boolean columns on `documents` → Slice 008
- A `notes` column on `documents` and the notes textarea in the metadata pane → Slice 016 (Slice 008 ships only the `*_edited` flags + inline editing for the model-extracted fields)
- Tag picker in the metadata pane and `tags` / `document_tags` tables → Slice 009
- Cross-account Audit view, "Open in Gmail" deep links, Reclassify-from-row → Slice 010
- Export → Slice 011
- Failed-classification visual treatment, "Show only failed" filter → Slice 012
- Document grouping display ("This also appears in N other emails in this account") → Slice 013
- Sender allowlist/blocklist UI driven by `senders` counts → Slice 015
- Undo for approve/reject (the actions are stored append-only and could be reversed by writing a new `review_actions` row plus flipping `documents.review_status`; no UI for it) → Slice 016
- Bulk approve / select-all → not planned for v1; the keyboard shortcuts plus confidence-asc ordering are the v1 ergonomics

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Review" and § "Key flows — Review" for the approve/reject path. It deliberately stops short of inline field edits (Slice 008) and tagging (Slice 009) so each behavior can be added without rewriting the surrounding view.

- **Queue semantics.** The queue is "everything still pending review across all connected accounts, ordered by confidence ascending so the riskiest items surface first." The custom rank `low=0, medium=1, high=2, NULL=3` is implemented inline in the SQL (`ORDER BY CASE confidence WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, internal_date ASC, documents.id ASC`). Confidence comes from `processed_messages` via JOIN — `documents` itself doesn't carry confidence. The JOIN is filtered to the **latest attempt** per `(account_id, message_id)` via `pm.id = (SELECT MAX(id) FROM processed_messages WHERE account_id = d.account_id AND message_id = d.message_id)`, since `processed_messages` is append-only (Slice 004) and would otherwise multiply rows once reclassification (Slices 010 / 014) appends new attempts. NULL confidence is unusual (only failed messages have NULL, and failed messages don't produce documents) but the rank covers it for completeness.
- **Account filtering.** Default scope is all `connected` accounts. The picker is the same `AccountPicker` from Slice 003, with an extra "All accounts" option at the top. Selecting a single account narrows the queue and the badge in the nav.
- **Atomicity.** Approve/reject are atomic transactions: `UPDATE documents SET review_status, updated_at`, `INSERT INTO review_actions`, `INSERT … ON CONFLICT … DO UPDATE` on `senders`. If any step fails, the transaction rolls back and the UI sees an error chip; the queue position does not advance.
- **`senders` upsert.** First time a `(account_id, domain)` pair is seen, the row is created with the relevant counter at 1 and the other at 0. Subsequent actions increment one or the other. `last_seen_at` is updated on every action. Slice 015 will read these counts to drive auto-skip/auto-flag; this slice only produces them.
- **Keyboard shortcuts.** A custom hook attaches a `keydown` listener at the document level while `Review.tsx` is mounted. Keys: `a` approve, `r` reject, `j` next, `k` previous. The handler checks `event.target instanceof HTMLInputElement || HTMLTextAreaElement || isContentEditable` and bails out — so when Slice 008's edit fields focus, the shortcuts disengage automatically. `j`/`k` advance the cursor without changing review state, useful for skimming or backing up to a previously-reviewed item.
- **Cursor and prefetching.** The view tracks a cursor index over the loaded queue. Approve/reject removes the current row from the local queue (the server-side queue no longer returns it because of the `review_status='pending'` filter, but the client still has the in-memory list) and advances the cursor. When within 5 of the end of the loaded list, fetch the next 50 with `offset = current_total`. Prev (`k`) walks backwards over the in-memory list including already-reviewed items so the user can revisit recent decisions; revisiting does not auto-approve, it just changes the displayed item.
- **Preview rendering.** `react-pdf` for `application/pdf`, native `<img>` for `image/*`. The preview pane uses the file via `GET /api/documents/:id/file` — Slice 006's endpoint already streams the bytes inline. Loading state is a spinner; load failures show "Preview unavailable" with the filename and a link to download.
- **Account labelling.** The metadata pane shows the account's email and display_name (when set), satisfying `architecture.md`'s "the originating account labeled in the metadata" requirement. A user with several accounts always knows which inbox a receipt came from before approving.
- **Session counters.** Empty/done states show "N approved, M rejected this session" — a small UX nicety. Counters are client-side ephemeral (no server table); they reset on a hard reload.
- **No undo in v1.** Approve/reject are reversible at the data level (just write another `review_actions` row and flip `review_status`) but the UI has no undo. This is acceptable because the data isn't lost — `review_actions` is append-only — and the user can re-trigger from the Inbox view's filtered listing if they realize they made a mistake. Slice 016 polish can add a 5-second undo toast.

## Acceptance criteria

- After Slice 006 sync produces ≥1 pending document, navigating to `/review` loads the queue with the lowest-confidence document showing first; the preview pane renders the PDF or image, and the metadata pane shows vendor / amount / currency / transaction_date / sender / subject / account.
- Pressing `a` (or clicking Approve) flips that document's `review_status` to `approved` in `documents`, inserts a row in `review_actions` with `action='approved'`, increments `senders.approved_count` for that `(account_id, sender_domain)`, sets `senders.last_seen_at`, and the UI advances to the next document.
- Pressing `r` does the same with `review_status='rejected'`, `action='rejected'`, `senders.rejected_count`.
- Pressing `j` advances to the next pending document without changing state; pressing `k` walks back to a previously-shown item (including already-approved/rejected ones from earlier in this session).
- Selecting a specific account in the dropdown narrows the queue to that account; a second account's documents disappear from the visible list.
- After all pending documents are reviewed, the view shows the done state with a session count (e.g. "9 approved, 3 rejected this session"). Returning to `/inbox` shows the same documents now with non-pending statuses.
- The Nav badge shows the current pending count and decrements after each approve/reject.
- Approving the same document twice (e.g. via two browser tabs racing) returns HTTP 409 from the second call; the local UI displays "already reviewed" and refetches the queue.
- The first approve/reject for a never-seen `(account_id, domain)` creates the `senders` row with the appropriate counter at 1; the second creates no new row but increments the counter.
- Focusing the account-filter dropdown's hidden combobox doesn't trigger keyboard shortcuts (the `a`/`r` letters typed there don't approve/reject; the dropdown's typeahead behavior, if any, is unaffected).
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Implementation notes

- **`react-pdf` worker.** Follow `react-pdf`'s recommended Vite recipe: import `pdfjs-dist/build/pdf.worker.min.js` and configure the worker source. No Vite plugin required.
- **Confidence rank in SQL.** Implemented as `CASE confidence WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 ELSE 3 END`. Adding a new confidence enum value would require updating this mapping.
- **Cross-tab race.** Two tabs approving the same document race resolves via HTTP 409 on the second call; the UI displays "already reviewed" and refetches.
- **No editing yet.** Inline editing of extracted fields is Slice 008. Slice 007 reviewers can still approve/reject; correcting fields waits for Slice 008.
- **Sender domain extraction.** `senders.domain` is stored as whatever string Slice 006's sync orchestrator produced from the `From` header. Edge cases (missing/malformed `From`, IDNs) produce whatever string Slice 006 emits; later cleanups can normalize without schema changes.
- **Append-only review history surfacing.** `review_actions` history is not surfaced in the UI in this slice. Slice 016 polish covers an in-pane history disclosure.
- **Keyboard shortcut letters `a`/`r`.** Bound directly while `Review.tsx` is mounted; the handler bails when an input/textarea/contentEditable is focused so Slice 008's edit fields are unaffected.
