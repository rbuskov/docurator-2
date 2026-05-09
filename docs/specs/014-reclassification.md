# Slice 014: Reclassification

**Status:** ready

## Observable result

In Settings → Reclassify, I can pick one or several connected accounts, a month range, and a model (defaulted to my currently-configured `OLLAMA_MODEL` but pickable from the list of installed Ollama models), then click "Run reclassification" and watch live per-account progress as the classifier re-runs over every message in scope. When it finishes, I get a summary like "412 messages reclassified · 3 became receipts · 1 no longer a receipt · 0 failed", broken down per account, and any documents whose latest classification disagrees with their stored classification are visually flagged in Review / Inbox / Audit.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` — append-only, with `id INTEGER PRIMARY KEY AUTOINCREMENT` (Slice 004 amendment) so reclassification can cleanly append new rows
  - `documents` — including `vendor`, `amount`, `currency`, `transaction_date`, `vendor_edited`, `amount_edited`, `date_edited` (Slices 006 / 008)
  - `review_actions` (Slice 007), `senders` (Slice 007)
  - `tags`, `document_tags` (Slice 009)
  - `document_groups`, `document_group_members` (Slice 013)
- **Migrations:**
  - `0001`–`0012` (Slices 002–013)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/ollama/health` (Slice 005) — extended here is unnecessary; this slice introduces a separate `GET /api/ollama/models` for the model dropdown
  - `POST /api/accounts/:id/messages/:message_id/reclassify` (Slice 010) — used per-message inside the batch orchestrator
  - `GET /api/audit` (Slice 010), `GET /api/audit/unresolved-failure-count` (Slice 012)
- **UI views / components:**
  - `Settings.tsx` (Slice 009) — extended here with a "Reclassify" section
  - `AccountMultiSelect.tsx`, `PeriodPicker.tsx`, `PeriodPresets.tsx` (Slice 011) — reused for account + period picking
  - `Review.tsx`, `ReviewMetadata.tsx` (Slices 007 / 008 / 009 / 013), `Inbox.tsx` (Slice 006), `AuditTable.tsx` (Slices 010 / 012) — extended here with a "model disagrees" badge on affected rows
  - `Nav.tsx`, `AccountPicker.tsx`, `TagChip.tsx`
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006), reclassify single-row orchestrator (Slice 010)
- **Env vars / configuration:**
  - `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` (Slice 005)
  - `MAX_CONCURRENT_CLASSIFY` (Slice 006)
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/processed_messages.ts` (Slices 004 / 010 / 012)
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008 / 009 / 013)
  - `src/server/auth/session.ts` (Slice 002)
  - `src/server/gmail/client.ts` (Slices 003 / 005)
  - `src/server/classify/index.ts`, `src/server/classify/ollama.ts` (Slice 005)
  - `src/server/sync/reclassify.ts` (Slices 010 / 013) — extended here with batch orchestration on top of the existing single-message logic
  - `src/server/sync/events.ts` (Slice 006) — pattern reused for the reclassify event emitter
  - `src/server/files.ts` (Slice 006)
  - `src/server/dedup/fingerprint.ts` (Slice 013)
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Google OAuth + Gmail API access per account (Slice 002 + 003)
  - Ollama at `OLLAMA_URL` (Slice 005)
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)
  - Single-job mutex from Slice 006's sync orchestrator — extended here so that **sync and batch reclassify cannot run concurrently** (one job at a time across both, single-user)

## Deliverables (Produces)

- **DB tables / columns:**
  - `documents.model_disagrees` INTEGER NOT NULL DEFAULT 0 — boolean flag (`0`/`1`). Set to `1` by the reclassify orchestrator when the message's latest `processed_messages` row classifies the message as `other` (or `failed`) but at least one `documents` row exists for `(account_id, message_id)` — i.e. the model now thinks it isn't a receipt anymore. Cleared back to `0` when a subsequent reclassify result restores `receipt`/`invoice` for the message. Also cleared when the user manually approves the document (the user has now overridden the model's disagreement). Editable `*_edited` flags from Slice 008 are unaffected by this flag.
- **Migrations:**
  - `0013_add_documents_model_disagrees.sql` — single `ALTER TABLE documents ADD COLUMN model_disagrees INTEGER NOT NULL DEFAULT 0`. No backfill: on first apply, no prior reclassify has run, so the default `0` is correct for every existing row.
- **API endpoints:**
  - `GET /api/ollama/models` → response `{ models: Array<{ name: string, size: number, family?: string, parameter_size?: string, modified_at?: string }>, current: string }`. Calls Ollama's `GET /api/tags` and returns the installed model names plus the configured `OLLAMA_MODEL`. Used by the model dropdown.
  - `POST /api/reclassify/batch` → request body Zod-validated as `{ account_ids: number[] (≥1), period: { start: string YYYY-MM, end: string YYYY-MM }, model?: string (defaults to OLLAMA_MODEL), retry_failed_only?: boolean (default false) }`. Validates that the `model` is in `GET /api/ollama/models` (when provided). Starts the in-process batch reclassify job and returns HTTP 202 with `{ job_id, started_at, total_messages: number }` (the total is computed up front by counting `processed_messages` rows that match the scope; the orchestrator iterates that set). Returns HTTP 409 with `{ error: 'job_in_progress', kind: 'sync' | 'reclassify', job_id }` when the shared mutex is held by a sync or a prior reclassify.
  - `GET /api/reclassify/events` → SSE stream. Events: `reclassify.start` (`{ job_id, account_ids, period, model, total_messages }`), `reclassify.account.start` (`{ account_id, account_messages }`), `reclassify.message` (`{ account_id, message_id, prior_classification, new_classification, prior_status, new_status, document_changes: { created: number[], model_disagreement_set: number[], model_disagreement_cleared: number[] } }`), `reclassify.account.done` (`{ account_id, processed, transitions }`), `reclassify.done` (`{ job_id, totals, transitions }`), `reclassify.error` (`{ account_id?, message }`). Same ring-buffer pattern as Slice 006's sync events for late subscribers.
  - `GET /api/reclassify/status` → `{ active: boolean, job_id?, started_at?, total_messages?, processed_messages?, transitions?: TransitionTotals, accounts?: Array<{ account_id, processed, total, transitions }> }`. Snapshot lookup. `TransitionTotals` shape: `{ became_receipt: number, no_longer_receipt: number, classification_unchanged: number, became_invoice: number, no_longer_invoice: number, recovered_from_failed: number, regressed_to_failed: number, still_failed: number }`.
  - `GET /api/reclassify/diff/:job_id` → final summary as JSON: `{ job_id, started_at, completed_at, model_used, period, totals: TransitionTotals, accounts: Array<{ account_id, account_email, transitions: TransitionTotals, sample_changes: Array<{ message_id, subject, prior_classification, new_classification }> }> }`. The summary is **kept in process memory** for the lifetime of the Node process; container restart drops it. (Persisting the diff is out of scope; users who want the data export it from the audit view.)
- **UI views / components:**
  - `ReclassifyTool.tsx` — Settings → Reclassify section. Form: `AccountMultiSelect` (defaults to all `connected` accounts), `PeriodPicker` (reused from Slice 011 — month / month_range / quarter, no fiscal-year preset since reclassify isn't accounting-period-aware), model dropdown sourced from `GET /api/ollama/models` (default current `OLLAMA_MODEL`), an optional "Only retry previously-failed messages" checkbox, a "Run reclassification" button. Disabled while a sync or a reclassify is in progress. While active: per-account progress bars + the running transition counters streamed from `GET /api/reclassify/events`.
  - `DiffSummary.tsx` — renders `GET /api/reclassify/diff/:job_id`. Headline copy: `412 messages reclassified · 3 became receipts · 1 no longer a receipt · 0 failed`. Below: per-account breakdown with sample changes (up to 5 per category per account) so the user can spot-check the diff. A "View this account's audit log" link per account opens `/audit?status=all&account_id=N&since=YYYY-MM&until=YYYY-MM` so the user can dig into specifics.
  - `ModelDisagreesBadge.tsx` — small warning chip rendered on rows in Review, Inbox, and Audit when `documents.model_disagrees === 1`. Tooltip copy: `The latest reclassification disagrees with the stored classification for this document. Open the audit log for the full history.`
  - `ReviewMetadata.tsx` (modified) — renders `<ModelDisagreesBadge />` near the classification metadata when present. Approving the document clears `model_disagrees` (the user has overridden).
  - `Inbox.tsx` (modified) — renders `<ModelDisagreesBadge />` on rows whose document has the flag.
  - `AuditTable.tsx` (modified) — renders `<ModelDisagreesBadge />` on rows whose `(account_id, message_id)` has at least one document with the flag set, alongside the existing Slice 012 status pill and Slice 010 reclassify/retry button.
  - `Settings.tsx` (modified) — fills in the previously-disabled (or, after Slice 011, partially-filled) Reclassify section.
- **Background jobs / orchestrators:**
  - Batch reclassify orchestrator (`src/server/reclassify/batch.ts`). Triggered by `POST /api/reclassify/batch`; reuses Slice 010's per-message reclassify logic in a loop scoped to `(account_ids, period, retry_failed_only)`. Single-job-at-a-time enforced via the **shared** mutex with Slice 006's sync orchestrator (the mutex moves into a shared module here — see Detailed design).
- **Env vars / configuration:**
  - `RECLASSIFY_BATCH_CHUNK_SIZE` (default `25`) — how many messages to process before yielding to the event loop / writing checkpoint counters. Tuning knob; default is fine.
- **Files / modules:**
  - `src/server/db/migrations/0013_add_documents_model_disagrees.sql`
  - `src/server/reclassify/batch.ts` — `runBatchReclassify({ account_ids, period, model, retry_failed_only })` orchestrator. Computes the message scope (a `processed_messages` query that picks the latest attempt per `(account_id, message_id)` whose `internal_date` is in the period and whose `account_id` is in scope), iterates serially per account, calls into Slice 010's `reclassify.ts` per-message wrapper for the actual classify+persist work, accumulates transitions, emits SSE events.
  - `src/server/reclassify/transitions.ts` — `computeTransition({ prior, current })` returning a `TransitionKind` string used in the totals; pure function for testing.
  - `src/server/reclassify/diff.ts` — in-memory per-job diff builder; persists nothing.
  - `src/server/reclassify/job-mutex.ts` — promotes Slice 006's in-memory single-job mutex into a shared module used by both sync and reclassify. **Modification, not re-deliver, of Slice 006's mutex placement** — the mutex itself is one Slice 006 deliverable; this slice moves it to a shared file and has both orchestrators consume it. Slice 006's `runSync` is updated to import the mutex from here instead of declaring it inline; the behavior is unchanged.
  - `src/server/sync/reclassify.ts` (modified) — Slice 010's per-message reclassify wrapper gains an option to update `documents.model_disagrees` based on the new classification (set to `1` when the message had `documents` rows but the new classification is `other`/`failed`; cleared to `0` when the new classification is back to `receipt`/`invoice`). The single-row reclassify endpoint from Slice 010 also uses this option starting now (it was previously a no-op with respect to `model_disagrees`).
  - `src/server/api/reclassify.ts` — new file; registers `POST /api/reclassify/batch`, `GET /api/reclassify/events`, `GET /api/reclassify/status`, `GET /api/reclassify/diff/:job_id`, `GET /api/ollama/models`.
  - `src/server/db/repositories/documents.ts` (modified) — adds `setModelDisagrees({ account_id, message_id, value })`, `clearModelDisagreesForDocument(document_id)`. Both used by the reclassify orchestrators and by the Slice 007 approve/reject endpoint (modified here to clear `model_disagrees` on approve).
  - `src/server/api/review.ts` (modified) — Slice 007's approve handler clears `model_disagrees` for the approved document inside its existing transaction.
  - `src/client/views/ReclassifyTool.tsx`, `src/client/components/DiffSummary.tsx`, `src/client/components/ModelDisagreesBadge.tsx`
  - `src/client/views/Settings.tsx` (modified) — mounts `ReclassifyTool`.
  - `src/client/components/ReviewMetadata.tsx` (modified)
  - `src/client/views/Inbox.tsx` (modified)
  - `src/client/components/AuditTable.tsx` (modified)
- **External services:** —
- **Other:**
  - **User-edited fields preserved across reclassification.** When the reclassify orchestrator processes a message that already has `documents` rows, it does **not** overwrite those rows' `vendor` / `amount` / `currency` / `transaction_date` (or any other field). The new model's extracted values land in the appended `processed_messages` row only. New `documents` rows (created when reclassify produces a new artifact via Slice 010's path) get the new model's values, as they always have. This satisfies architecture's "user-edited fields preserved across reclassification" rule by simply not touching existing documents — and because Slice 008's `*_edited` flags already distinguish user-edited fields from model-extracted ones, a future "reset to model values" feature can decide per-field whether to overwrite.
  - **Single shared job mutex across sync + reclassify.** A user can't accidentally start a reclassify while a sync is running, or two reclassifies at once. The Dashboard's "Sync now" button and this slice's "Run reclassification" button are mutually exclusive while either job is active.

## Out of scope

- Persisting the diff summary across container restarts → not planned for v1; in-memory only
- Per-attempt provenance for documents (`documents.processed_message_id` column linking back to the specific run that produced the doc) → not added here; flagged forward in Slice 006's spec as a future addition
- Auto-applying tags / sender hints during reclassification → Slice 015
- A "reset edited fields to model values" affordance → polish; not planned for v1
- Per-document reclassify history (showing all attempts with diffs) in the Review pane → polish; not planned for v1 (the audit view shows the full history)
- Cross-account diff comparison ("show me which accounts changed the most") → not planned for v1; the diff is per-account
- Resuming an interrupted batch reclassify → not planned; container restart drops the in-memory job and the user re-runs (already-completed messages are still in `processed_messages` but they get reclassified again unless the user picks `retry_failed_only`)
- Concurrent batch reclassifies on different accounts → forbidden by the shared mutex
- A way to preview the diff without writing rows → not planned; the run is the diff
- Auto-removing model_disagrees=1 documents (e.g. soft-delete files) → explicitly forbidden by architecture's "Recoverable, never destructive" principle

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Settings" (the Reclassify tool), § "Key flows — Reclassification" (the full batch flow), and § "Components — Frontend — Review" (the "model now disagrees" indicator). It is the first slice that introduces a long-running orchestrator beyond sync, and the first that shares the single-job mutex across two distinct flows.

- **Job lifecycle.** `POST /api/reclassify/batch` validates the inputs, computes the message-set count (so the UI can show progress), acquires the shared mutex, returns 202 with the `job_id`, and runs the orchestrator in the same Node process. SSE events stream to subscribers; the diff is built incrementally in memory and exposed via `GET /api/reclassify/diff/:job_id` after `reclassify.done`. A container restart drops the in-memory state (job id, mutex, diff); the user re-runs.
- **Message scope query.** The orchestrator queries `processed_messages` to find the messages-of-record for the requested period and accounts. The query picks the **latest attempt** per `(account_id, message_id)` (using `MAX(id)` since `id` is monotonic from Slice 004's amendment) so it doesn't iterate prior failed attempts and their now-resolved-by-success siblings as separate items. When `retry_failed_only=true`, the WHERE clause additionally filters to messages whose latest attempt has `status='failed'` — directly targeting the bulk-retry use case Slice 012 deliberately deferred.
- **Per-message processing.** For each message in scope (serially per account, accounts iterated serially per the `MAX_CONCURRENT_CLASSIFY=1` default and the Ollama-bottleneck reasoning from Slice 006):
  1. Call Slice 010's `reclassify.ts` wrapper with the requested `model` (defaulting to `OLLAMA_MODEL`).
  2. The wrapper handles the actual classify (Slice 005), the new `processed_messages` insert (always append), the new-document persistence (Slice 010 hard-dedup-aware), and the fingerprint+attach to a group (Slice 013).
  3. The batch orchestrator captures the prior classification (the latest attempt before this run) and the new classification, computes a transition kind, increments per-account totals.
  4. After the per-message transaction commits, the orchestrator calls `setModelDisagrees`/`clearModelDisagreesForDocument` for any existing `documents` rows that need their flag updated. Done outside the per-message classify transaction because the flag's value depends on the current row state of `documents` and `processed_messages`, which is now committed.
  5. Emits a `reclassify.message` event with the transition.
- **Transition kinds.**
  - `prior=success/other`, `new=success/receipt|invoice` → `became_receipt` (or `became_invoice`)
  - `prior=success/receipt|invoice`, `new=success/other` → `no_longer_receipt` (or `no_longer_invoice`); also flips affected `documents.model_disagrees=1`
  - `prior=success/receipt|invoice`, `new=success/receipt|invoice` (same kind) → `classification_unchanged`; clears `model_disagrees=0` if any flag was previously set (consistency)
  - `prior=failed`, `new=success` → `recovered_from_failed`
  - `prior=success`, `new=failed` → `regressed_to_failed`
  - `prior=failed`, `new=failed` → `still_failed`
- **`model_disagrees` lifecycle.** The flag lives on `documents`, not on `processed_messages`, because it's a UI hint about *the persisted artifact*, not about the audit row. The flag is set/cleared transactionally with each reclassify message. The Slice 007 approve handler also clears it (when the user approves a doc the model now disagrees with, the user has overridden the disagreement). The Slice 007 reject handler does **not** clear it — rejecting the doc means the user agrees with the model's new "this isn't a receipt" verdict, but the flag still describes the doc accurately until the doc is deleted (which doesn't happen automatically).
- **Sync vs reclassify mutex.** Slice 006 declared a single-job mutex inside the sync orchestrator. This slice promotes it to `src/server/reclassify/job-mutex.ts` — a tiny module exposing `acquire(kind: 'sync'|'reclassify', job_id) → boolean` and `release()`. Both orchestrators call `acquire` before starting and `release` in a `finally`. The endpoints return a clean 409 when the mutex is held, naming the holder. Slice 006's behavior is unchanged in spirit; only the mutex's location moves.
- **`GET /api/ollama/models`.** Slice 005's `GET /api/ollama/health` returns reachability + whether the configured model is installed; this slice adds a richer endpoint that returns the full installed-model list. Reusing `/api/ollama/health` would have been viable but the dropdown wants more fields than the badge does, and keeping the surfaces separate avoids each slice's UI dictating the other's payload.
- **Period semantics.** The reclassify period filters on `processed_messages.internal_date` (Gmail's `internalDate`), not on `processed_at`. The user is saying "reclassify all the *original messages* from this period," not "reclassify whatever was processed in the last sync." This matches user intent ("re-run the model over my Q2 emails") and decouples reclassification scope from when sync happened to run.
- **Diff persistence (lack thereof).** The diff lives in memory for the Node process's lifetime. `GET /api/reclassify/diff/:job_id` returns the same diff whenever it's requested while the process lives. After a container restart the diff is gone; the user can rerun reclassify or examine the audit view directly. Persisting diffs would require a `reclassify_jobs` + `reclassify_transitions` table; deferred.

## Acceptance criteria

- After Slice 014, `sqlite3 data/app.db ".schema documents" | grep model_disagrees` shows `model_disagrees INTEGER NOT NULL DEFAULT 0` and existing rows all have value `0`.
- The Settings → Reclassify section shows account multi-select, period picker, model dropdown (populated from `GET /api/ollama/models` with the configured model preselected), and a "Run reclassification" button.
- Clicking "Run reclassification" with one account selected and a period covering N messages returns within ~1s; the SSE stream begins emitting `reclassify.start` then per-message events. The UI's per-account counters increment as events arrive.
- After completion, the diff summary shows `N messages reclassified · X became receipts · Y no longer a receipt · Z became invoices · W recovered from failed · V regressed to failed · F still failed`. The breakdown adds up to N.
- For a message that was previously classified as `other` and is now classified as `receipt`: a new `processed_messages` row is appended with the new classification; if the new artifact's `(account_id, content_hash)` is not already in `documents`, a new `documents` row is inserted (review_status='pending'); the new doc gets a `document_groups` membership via Slice 013's fingerprinting.
- For a message that was previously classified as `receipt` (with one or more existing `documents` rows) and is now classified as `other`: a new `processed_messages` row is appended with `classification='other'`; the existing `documents` rows have `model_disagrees=1` set; their `vendor`/`amount`/etc. fields and `*_edited` flags are unchanged; their `review_status` is unchanged.
- For a message that was previously approved (`review_status='approved'`) and the model now says `other`, the document is flagged with `model_disagrees=1` but stays `approved`. Approving it again (or re-approving via the audit view's Reclassify+Approve flow) clears the flag.
- For a message that was previously failed and now succeeds, the diff counts it as `recovered_from_failed`; a new `processed_messages.status='success'` row is appended; if it's a receipt, a document is created (subject to hard dedup).
- The Review/Inbox/Audit views render a small `ModelDisagreesBadge` next to documents whose flag is `1`. Approving a flagged doc in Review clears the flag (next refresh confirms).
- Trying to start a reclassify while a sync is running returns HTTP 409 with `{ error: 'job_in_progress', kind: 'sync', job_id }`. Trying to start a sync while a reclassify is running returns the symmetric 409.
- Choosing "Only retry previously-failed messages" narrows the scope to messages whose latest `processed_messages.status='failed'`; the UI's `total_messages` count reflects that scope.
- Picking a model that's not in `GET /api/ollama/models` returns HTTP 400 with a clear error.
- After a `docker compose restart` mid-run, the running batch reclassify drops; the diff is gone; the user can re-run with the same params, and the orchestrator picks up the union of the messages-of-record again (already-reclassified messages get reclassified again, same as a fresh run — that's how append-only works).
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Implementation notes

- **In-memory diff lost on restart.** Diffs live in the Node process for its lifetime. Persisting diffs would require a `reclassify_jobs` table (deferred). The append-only audit log preserves the underlying data, so the diff is reconstructible offline.
- **`model_disagrees` clear semantics.** Cleared on approve (user override) and on a subsequent reclassify back to receipt/invoice. Not cleared on reject — the flag describes the document's classification history regardless of the user's intent.
- **No per-attempt linkage on documents.** Documents do not carry a pointer to the `processed_messages` row that produced them. Latest-attempt lookups via `MAX(id)` cover Review, Audit, and Export needs. A `documents.processed_message_id` column can be added later if per-attempt provenance is required.
- **Mutex placement.** This slice promotes Slice 006's in-memory single-job mutex into `src/server/reclassify/job-mutex.ts`; sync imports from there. Slice 006's behavior is unchanged; only the location moves.
- **Period filter on `internal_date`.** The reclassify period filters on the email's actual date, not when it was synced. "Reclassify January 2026" reclassifies January-arrived messages regardless of when sync first picked them up.
- **Concurrent reclassify vs fresh sync.** Mutually exclusive via the shared mutex; the second caller gets HTTP 409 with the holder's `kind` and `job_id`.
- **Long-running HTTP for `POST /api/reclassify/batch`.** Returns 202 immediately; classification happens in the background and progresses via SSE. The SSE connection can stay open for hours on slow CPUs.
- **Reclassify does not update `documents.created_at`.** Existing docs keep their original timestamp; the audit log carries the reclassify's `processed_at`.
- **No dry-run mode.** Reclassification is append-only and non-destructive, so the cost of running it for real is the same as a dry-run plus the actual writes. A preview-only mode is not planned.
