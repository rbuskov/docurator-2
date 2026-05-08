# Slice 012: Failed-classification handling

**Status:** draft

## Observable result

When the classifier breaks on some weird email — in any of my accounts — I can spot it on the Audit view (clearly marked as failed), filter to "Show only failed" to see all such rows in one place, and click Retry on a row to re-run the classifier against the originating account. If the retry succeeds, a new audit row appears and any produced documents land in the normal review queue.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` — including `status` (`'success' | 'failed'`) and `error_message` columns, both already shipped (Slice 004)
  - `documents`, `review_actions`, `senders`, `tags`, `document_tags` (Slices 006 / 007 / 009)
- **Migrations:**
  - `0001`–`0010` (Slices 002–009)
- **API endpoints:**
  - `GET /api/audit` (Slice 010) — extended here with a `status` filter and the failed-row visual cue
  - `POST /api/accounts/:id/messages/:message_id/reclassify` (Slice 010) — reused unchanged; the per-row Retry button calls this endpoint
  - `GET /api/accounts` (Slice 002)
- **UI views / components:**
  - `Audit.tsx` at `/audit` (Slice 010) — extended here
  - `AuditFilters.tsx` (Slice 010) — extended with a status filter
  - `AuditTable.tsx` (Slice 010) — extended with the failed-row visual treatment and the Retry affordance
  - `ReclassifyButton.tsx` (Slice 010) — reused, with copy/labeling adapted via props for the "Retry" presentation
  - `Nav.tsx` (Slice 003), `AccountPicker.tsx` (Slice 003), `TagChip.tsx` (Slice 009)
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006) — already writes `status='failed'` rows on per-message errors per its existing acceptance criteria; this slice does not change sync behavior
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` (Slice 005) — used by the underlying reclassify endpoint
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/api/audit.ts` (Slice 010) — extended here
  - `src/server/db/repositories/processed_messages.ts` (Slice 004) — its `listAudit` query (added in Slice 010) is extended here with the `status` filter
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Google OAuth + Gmail API access per account (Slice 002 + 003)
  - Ollama at `OLLAMA_URL` (Slice 005)
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:**
  - `GET /api/audit` (modification of Slice 010's endpoint) — adds an optional `status` query param accepting `'success' | 'failed'`. Default unchanged: returns all statuses. Combinable with all existing filters (account, classification, confidence, sender_domain, since/until, q). The Slice 010 row shape is unchanged; this slice only extends the WHERE clause.
- **UI views / components:**
  - `AuditFilters.tsx` (modified) — adds a Status dropdown (`All / Success / Failed`) at the right end of the filter bar. Selecting "Failed" sets `?status=failed`. Selecting also disables the Classification and Confidence dropdowns (since failed rows have NULL classification and confidence) with an inline hint, so the user sees at a glance why those filters do nothing for failed rows.
  - `AuditTable.tsx` (modified) — adds a small status pill in the existing Status column: green check + "Success" for successful rows; red exclamation + "Failed" + a hover tooltip showing `error_message` for failed rows. The whole row gets a subtle red-tinted left border when `status='failed'` so a user scanning the table can spot failures at a glance even when the Status column is off-screen.
  - `RetryButton.tsx` — per-row button rendered **only on failed rows** (in place of, or alongside, Slice 010's Reclassify button — see Detailed design). Wraps Slice 010's `ReclassifyButton` with `kind='retry'` so the user-facing copy is "Retry" instead of "Reclassify". On click, POSTs to the existing `POST /api/accounts/:id/messages/:message_id/reclassify` endpoint and replaces the row in place when the new audit row arrives. On success: if the retry produced a `success` row, the new row appears below (or above, by `processed_at` order) and the original failed row remains in the audit log. On failure (still): a new failed row is appended, the user can click Retry again.
  - Failed-row badge in the Nav: when there are unresolved failed rows (defined as: a `processed_messages` row with `status='failed'` whose latest attempt for that `(account_id, message_id)` is still `failed`), the Nav's "Audit" link shows a small red dot. Polled on Nav mount and after every retry; click goes to `/audit?status=failed`.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/api/audit.ts` (modified) — adds the `status` query param to the Zod validator and threads it through `listAudit`.
  - `src/server/db/repositories/processed_messages.ts` (modified) — `listAudit` accepts an optional `status` filter and adds `WHERE pm.status = ?` when present.
  - `src/server/db/repositories/processed_messages.ts` (modified) — adds `countUnresolvedFailures()` returning the count for the Nav badge. Implementation: count distinct `(account_id, message_id)` whose latest attempt has `status='failed'`. Single query: `SELECT COUNT(*) FROM (SELECT account_id, message_id FROM processed_messages GROUP BY account_id, message_id HAVING (SELECT status FROM processed_messages p2 WHERE p2.account_id = processed_messages.account_id AND p2.message_id = processed_messages.message_id ORDER BY p2.id DESC LIMIT 1) = 'failed')`.
  - `src/server/api/audit.ts` (modified) — adds `GET /api/audit/unresolved-failure-count` returning `{ count: number }`. Used by the Nav badge.
  - `src/client/components/AuditFilters.tsx` (modified)
  - `src/client/components/AuditTable.tsx` (modified)
  - `src/client/components/RetryButton.tsx`
  - `src/client/components/Nav.tsx` (modified) — adds the failed-rows red dot.
  - `src/client/components/ReclassifyButton.tsx` (modified) — accepts a new `kind: 'reclassify' | 'retry'` prop that controls copy ("Reclassify" vs "Retry") and styling (default vs warning). The endpoint and behavior are unchanged.
- **External services:** —
- **Other:**
  - "Unresolved failure" is a derived concept introduced here: a `(account_id, message_id)` whose **latest** attempt is `status='failed'`. Counting it instead of "any failed attempt" means a successful retry clears the badge for that message, and a subsequent fresh failure (e.g. a Slice 014 batch reclassify against a model that's now unreachable) re-raises it. This concept is referenced by Slice 014 when it reports retry counts.

## Out of scope

- Batch retry of all failed rows in one click (e.g. "Retry all 17 failures") → Slice 014 (the batch reclassification tool covers this surface; until then, the per-row Retry button + the `?status=failed` filter is enough)
- Auto-retry on transient failures during sync (e.g. "if Ollama returned a timeout, retry once") → not planned for v1; the sync orchestrator already retries Gmail-side rate-limit / 5xx once per its Slice 006 design, and Ollama failures are recorded as failed and surfaced here
- Different visual treatment per failure type (Ollama unreachable vs. parse error vs. Gmail token error) → polish; for now the same red-pill + `error_message` tooltip covers all
- Email/desktop notification on failures → not planned for v1
- Bulk dismissal ("acknowledge but don't retry") → not planned; failed rows stay visible until retried successfully
- Slice 010's `ReclassifyButton` migration to `RetryButton` for non-failed rows → no change; non-failed rows still see the Reclassify button labeled "Reclassify"
- New visual treatment in Inbox or Review views → out of scope by design (failed messages produce no `documents` rows, so they don't appear in those views; the Audit view is the canonical surface for failures)
- Failure-rate metrics or "classifier accuracy" reporting → not planned for v1; can be derived from the audit log if needed

## Detailed design

This slice extends Slice 010's Audit view with the surfaces that make failed classifications legible and recoverable. It does not change the underlying error-handling in sync (Slice 006 already records failures) or in reclassify (Slice 010 already accepts retries against any row). The contribution is the user-facing affordances.

- **Status filter scope.** The dropdown is binary plus "All". Combining `status=failed` with `account_id=X` shows only that account's failures — exactly the architecture's "Show only failed" view, scoped or unscoped. Combining `status=failed` with `classification` or `confidence` is allowed but returns zero rows (failed rows have NULL for both); the UI grays out those filters when `status=failed` is active and shows a small explanatory hint, so the user isn't surprised by the empty result.
- **Failed-row visual.** A red-tinted left border on the row plus a red exclamation pill in the Status column. The pill carries the (truncated) `error_message` as a tooltip for a quick glance; clicking the pill opens a small popover with the full message, useful for debugging "why did this email break?" without leaving the table. The visual stays minimal — no full-row red background, no blink/pulse, no toast notifications. Architecture's "Visual indicator (color, icon)" line is satisfied with this restraint.
- **Retry vs. Reclassify on failed rows.** Slice 010 added a per-row Reclassify button on every audit row. This slice introduces a per-row Retry button **specifically on failed rows**, which calls the same backend endpoint but presents differently:
  - Failed rows show **only** Retry, not Reclassify. Visually it's a warning-styled button with the copy "Retry"; semantically it reflects the user's intent ("the classifier broke; let's try again").
  - Successful rows show **only** Reclassify (Slice 010's existing behavior, unchanged).
  - Both buttons hit `POST /api/accounts/:id/messages/:message_id/reclassify`. The server doesn't care which UI element invoked it.
  - The shared component is `ReclassifyButton` with a `kind` prop; the visible difference is purely UI.
- **Nav badge for unresolved failures.** A small red dot on the Audit nav link when at least one `(account_id, message_id)` has its latest attempt as `failed`. Polled on Nav mount and after every successful retry. Defining "unresolved" as "latest attempt failed" means:
  - A failed message that's been successfully retried no longer counts (its latest attempt is `success`).
  - A successfully-classified message that's later reclassified and fails counts again.
  - The badge directly reflects "do I have unfinished work?", which matches the user's mental model better than "have any errors ever happened?".
- **Concurrency with retry.** A retry click is a single HTTP call to the existing endpoint; the user can click multiple Retry buttons on different rows in succession, each fires its own request, the server processes serially against Ollama (Slice 005 has no per-account-rate gate; in practice retries are infrequent enough that ordering doesn't matter). If a retry races with the user clicking Sync, both end up appending rows to `processed_messages` for their respective messages — no constraint conflict because the table is append-only (Slice 004 amendment).
- **No batch retry yet.** The architecture's "Show only failed" + per-row Retry handles "fix one weird email" workflows. For "I just turned Ollama back on after it was down for an hour, retry the 47 messages that failed", the user would click Retry on each row — tedious but viable. Slice 014's batch reclassification ships the proper batch surface; this slice deliberately stays narrow.
- **`error_message` truncation.** Some Ollama or Gmail errors return long stack-trace-ish messages (e.g. multi-line JSON with embedded newlines). The pill tooltip truncates to 200 chars; the popover shows the full text. The DB stores the full `error_message` either way (the column is unconstrained TEXT).

## Acceptance criteria

- After Slice 012, the Audit filter bar has a Status dropdown (`All / Success / Failed`). Default is `All`; selecting `Failed` narrows the table to rows with `status='failed'`.
- Combining `?status=failed&account_id=X` narrows to that account's failures. Combining with `classification` or `confidence` while `status=failed` produces zero rows; the UI grays out those filters with the inline hint.
- Each failed row in the table renders with a red-tinted left border and a red "Failed" pill in the Status column. Hovering the pill shows the truncated `error_message`; clicking opens a popover with the full text.
- Successful rows render with a green check + "Success" pill and no border tint. The Status column visually disambiguates the two states even at a glance.
- Failed rows show a Retry button (warning-styled, "Retry" copy). Successful rows show a Reclassify button (default-styled, "Reclassify" copy). Both call the same endpoint; the server logs cannot distinguish which UI button invoked which request.
- Clicking Retry on a failed row that the classifier can now process (Ollama is back up) appends a new `processed_messages` row with `status='success'` and the new classification; the audit table refreshes and shows the new row above the old failed row (sorted by `processed_at DESC`); the original failed row stays visible.
- Clicking Retry on a failed row that's still failing appends another `status='failed'` row; the user can keep retrying.
- The Nav's "Audit" link shows a red dot when at least one message's latest attempt is `failed`. After a successful retry on the last unresolved failure, the dot disappears (next Nav poll, ≤30s).
- A successful retry that produces a new document (e.g. the message is now classified as a receipt where it previously errored) creates the document via Slice 010's reclassify-orchestrator path; the document appears in the Review queue with `review_status='pending'`.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.
- `GET /api/audit/unresolved-failure-count` returns the correct count after a fresh `docker compose up`, after a retry that resolves the failure, and after a fresh failure during sync.

## Risks / open questions

- **`countUnresolvedFailures` query cost.** The "latest attempt per `(account_id, message_id)`" subquery runs against every distinct pair in `processed_messages`. For a few thousand messages it's fast; for tens of thousands of years of audit rows it may slow down. If measured to be slow, materialize a `processed_messages_latest` view or maintain a `latest_attempt_id` column on a derived table. Flag.
- **Retry vs. Reclassify duplication.** Two buttons doing the same thing on different rows could confuse users. The labeling difference (Retry on failed, Reclassify on success) plus the styling difference is the spec's bet on intuition. If user feedback says it's confusing, consolidate to a single "Re-run" button. Flag.
- **Ollama timeouts during retry.** A retry against Ollama with a 120s `OLLAMA_TIMEOUT_MS` (Slice 005) holds the HTTP connection open for the whole duration. The Retry button shows a spinner; abandoning the tab cancels the request server-side (the AbortController in `src/server/classify/ollama.ts` is wired). On client cancellation, no row is written. Flag — should a cancelled retry write a `status='failed'` row with `error_message='cancelled'`? Provisional: no; the original failed row already represents the unresolved state.
- **No bulk retry surface here.** A user with 47 failed messages from a brief Ollama outage will click Retry 47 times. Slice 014's batch tool covers this, but the gap between Slice 012 and Slice 014 may be uncomfortable for early adopters. If pressing, a "Retry all failed" button is a small follow-on (just iterates rows + fires the same endpoint per row). Flag.
- **Truncated `error_message` in tooltip.** 200 chars covers most failures; some classifier-validation errors include the raw JSON which is long. The popover shows the full text. If errors regularly need richer formatting (line breaks, code blocks), upgrade the popover to render Markdown. Flag.
- **No status indicator on Inbox or Review.** Failed rows have no `documents` rows, so they don't appear in those views. The Audit view remains the only failure surface. This is consistent with the architecture's "the audit view is the safety net" framing. Flag if user testing finds the asymmetry confusing.
