# Slice 010: Audit view with deep links

**Status:** ready

## Observable result

I can open an Audit page that lists every email the classifier has processed across all my connected accounts (paginated, filterable by account / classification / confidence / sender / date range / free-text subject search), see a status column showing success vs failed, click "Open in Gmail" on any row to land in the correct inbox even when several Gmail accounts are signed into the same browser, and click "Reclassify" on a single row to re-run the classifier on that one message and append a new decision to the audit log.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` — including `email` (used to build the `authuser` parameter for Gmail deep links) (Slice 002)
  - `processed_messages` — append-only with multiple rows per `(account_id, message_id)` permitted (Slice 004 ships a surrogate `id` primary key with no unique constraint on the message tuple, so reclassify can append).
  - `documents` — for the audit row's "produced N documents" indicator and for tag chips (Slice 006)
  - `tags`, `document_tags` — for rendering tag chips on receipt rows (Slice 009)
- **Migrations:**
  - `0001`–`0008` (Slices 002–008)
  - `0009_create_tags.sql`, `0010_create_document_tags.sql` (Slice 009)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002) — populates the account filter dropdown
  - `GET /api/tags` (Slice 009) — used to resolve tag chips when rendering rows
- **UI views / components:**
  - `Nav.tsx` (Slice 003) — extended here with an "Audit" link
  - `AccountPicker.tsx` (Slice 003) — reused inside the audit filters
  - `TagChip.tsx` (Slice 009) — reused for tag chips on receipt rows
  - `Settings.tsx` (Slice 009) — unchanged here
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006) — the source of the rows this view shows
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` (Slice 005) — reclassify reuses the same configuration
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/processed_messages.ts` (Slice 004) — extended here with a cross-account list method
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008) — used to count documents per row
  - `src/server/auth/accounts.ts`, `src/server/auth/session.ts` (Slice 002)
  - `src/server/gmail/client.ts` (Slices 003 / 005) — used by reclassify to fetch the message
  - `src/server/classify/index.ts` (Slice 005) — `classifyMessage` is the per-message pipeline reclassify reuses
  - `src/server/files.ts` (Slice 006) — used by reclassify to persist any new artifacts
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
  - `GET /api/audit` → cross-account paginated audit listing. Query params (all optional, all combined as AND): `limit` (default 50, max 200), `offset` (default 0), `account_id` (numeric, single account; default all), `classification` (`'invoice' | 'receipt' | 'other'`; default all), `confidence` (`'high' | 'medium' | 'low'`; default all), `sender_domain` (exact-match), `since` (ISO date YYYY-MM-DD; matches on `internal_date`), `until` (ISO date), `q` (free-text subject substring; case-insensitive). Default sort: `processed_at DESC` (most recently processed first). Response: `{ rows: Array<AuditRow>, total: number, limit, offset }`. `AuditRow` includes `processed_message_id` (the row's surrogate key from Slice 004), `account_id`, `account_email`, `account_slug`, `account_display_name`, `message_id`, `thread_id`, `internal_date`, `processed_at`, `model_used`, `status` (`'success' | 'failed'`), `error_message`, `classification`, `confidence`, `reason`, `sender_domain`, `subject`, `document_count` (number of `documents` rows produced for this `(account_id, message_id)` across **all** classification attempts), and `tags` (the most-recent attempt's documents' tags, deduplicated, since tags live on documents not on `processed_messages`).
  - `POST /api/accounts/:id/messages/:message_id/reclassify` → no request body in this slice (Slice 014 will add an optional `model` override). Synchronously runs `classifyMessage({ account_id, message_id })` from Slice 005, appends one new `processed_messages` row tagged with the resulting classification + confidence + reason + sender_domain + subject + the model that ran (defaults to `OLLAMA_MODEL`), and — when the new classification is `receipt` or `invoice` and the produced artifact's `(account_id, content_hash)` is not already in `documents` — persists the new artifact via `src/server/files.ts` and inserts a `documents` row pointing at the same `message_id`. Existing `documents` rows for the same message are **not** modified (no soft-flagging, no field overwrite — that's Slice 014's job). Returns `{ processed_message_id, classification, confidence, reason, model_used, new_document_ids: number[] }`. On Ollama / Gmail / classifier errors, appends a `status='failed'` row with the error message and returns HTTP 502 / 401 with the failure detail (mirroring Slice 005's error contract).
- **UI views / components:**
  - `Audit.tsx` — at route `/audit`. Top filter bar (`AuditFilters`), then the audit table (`AuditTable`), then pagination controls. Row count and current filters are shown above the table ("Showing 1–50 of 1,247 audit rows · `business@example.com` · last 30 days"). The view loads `GET /api/audit` on mount and on any filter or pagination change, with the URL query string mirroring the active filters so reload/share preserves the view.
  - `AuditFilters.tsx` — bar with: account dropdown (reuses `AccountPicker`, with "All accounts" prepended), classification dropdown (`All / invoice / receipt / other`), confidence dropdown (`All / high / medium / low`), sender-domain text input (free text, exact match), since/until date inputs, free-text search input (`q`). A "Reset filters" button clears all of them. Filter changes are debounced 200ms before re-fetching.
  - `AuditTable.tsx` — regular table (≤200 rows per page is the default `limit`) with columns: Account (email + display_name + small slug hint), Date (`internal_date`), Sender (`sender_domain`), Subject (`subject`, truncated), Status (`success` / `failed` rendered as plain text in this slice — visual indicator deferred to Slice 012), Classification (`invoice` / `receipt` / `other` with a small color hint), Confidence (`high` / `medium` / `low`), Documents (`document_count`; click to navigate to `/inbox?message_id=…` if > 0), Tags (chips via `TagChip` for receipts), Open in Gmail, Reclassify.
  - `GmailDeepLink.tsx` — anchor that builds `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account_email)}#all/${message_id}` and opens in a new tab. The `authuser=<email>` query parameter makes Gmail honour the right account regardless of the positional `/u/N/` slot the browser is currently signed into.
  - `ReclassifyButton.tsx` — small button per row that POSTs to the reclassify endpoint and renders a transient inline state ("Re-running…", then a success chip with the new decision or a failure chip with the error). After success, the row in the table is replaced by the new audit row from the response (the table re-fetches the current page in the background to also pick up the prior decisions in their existing positions).
  - `Nav.tsx` (modified) — adds an "Audit" link between "Inbox" and "Settings" (or wherever fits the existing layout).
  - `src/client/router.tsx` (modified) — registers `/audit` → `Audit`.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/api/audit.ts` — registers `GET /api/audit` and `POST /api/accounts/:id/messages/:message_id/reclassify`. Uses `@hono/zod-validator` for query- and path-param validation.
  - `src/server/db/repositories/processed_messages.ts` (modified) — adds `listAudit({ filters, limit, offset })` returning rows + total. The query joins `accounts`, leftjoins `documents` for `document_count`, and leftjoins `document_tags`/`tags` for the tag chips on receipt rows.
  - `src/server/sync/reclassify.ts` — small wrapper around Slice 005's `classifyMessage` that handles the persistence rules above. The sync orchestrator from Slice 006 uses `classifyMessage` directly (per-message + write a single `processed_messages` row); reclassify needs slightly different handling (always append, never skip, only persist *new* artifacts), so it's a thin separate module that calls into the Slice 006 file store.
  - The reclassify endpoint is registered inside `src/server/api/audit.ts` (the action this view uses). Slice 014 can hoist it into a shared module when its Settings reclassify tool also needs the route.
  - `src/client/views/Audit.tsx`, `src/client/components/AuditFilters.tsx`, `src/client/components/AuditTable.tsx`, `src/client/components/GmailDeepLink.tsx`, `src/client/components/ReclassifyButton.tsx`
  - `src/client/router.tsx` (modified)
  - `src/client/components/Nav.tsx` (modified)
- **External services:** —
- **Other:**
  - First slice with a free-text search filter. SQL `LIKE '%' || q || '%'` on the indexed (per Slice 004) `(account_id, processed_at)` won't help; this slice does a simple unindexed substring match for now. Full-text search (FTS5) is deferred unless performance becomes a problem.
  - First slice that joins `documents` and `tags` into a row produced by a non-document table. The JOIN is constructed once in `listAudit` and reused per request.

## Out of scope

- "Show only failed" filter, the failed-row visual indicator (color/icon), and the per-row Retry action specifically for failed classifications → Slice 012 (the Reclassify button shipped here can re-run a failed message and is not a retry-only surface; the dedicated retry affordance with batch semantics is Slice 012's job)
- Batch reclassification (Settings → Reclassify tool, model override, date-range scope, decision diff calculator) → Slice 014
- "Show only `other` from senders I've previously approved (in this account)" view → Slice 015 (uses sender stats)
- Document-group display (siblings, "this also appears in N other emails") → Slice 013 (the Audit view here does not show grouping)
- Inline editing of `processed_messages` fields → not planned (the row is a snapshot of the classifier's decision; corrections happen on the produced `documents` via Slice 008)
- FTS5 full-text search over subjects/bodies → not planned for v1; substring `LIKE` is enough for the small corpora a single-user install accumulates
- Auth / access control on the Audit endpoints → not planned (single-user install)
- Saved filter presets / bookmarks → polish; the URL query string already serves this purpose

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Audit" and § "Key flows — Audit / double-check" end to end, plus the per-row reclassify mechanism described in `architecture.md` § "Key flows — Reclassification" (single-message variant; batch is Slice 014). It is the first cross-account read surface in the application — every prior list (Inbox, Review queue) was per-account or paged-per-account.

- **Cross-account listing.** `listAudit` runs a single query joining `processed_messages pm`, `accounts a` on `pm.account_id = a.id`, with optional `LEFT JOIN documents d` for the document count and `LEFT JOIN document_tags dt LEFT JOIN tags t` for tag chips, aggregated via `GROUP BY pm.id`. Filter params are bound to prepared-statement placeholders; LIKE search escapes `%` and `_` to avoid pattern surprises. Pagination is `LIMIT/OFFSET`; `total` is a separate `COUNT(*)` query against the same WHERE clauses.
- **Reclassify lifecycle.** When the user clicks Reclassify on a row:
  1. The button POSTs to `/api/accounts/:id/messages/:message_id/reclassify`.
  2. The server runs `classifyMessage` (Slice 005) — same code path as sync's per-message pipeline. The function is account-aware via `session.withFreshTokens`; a token error flips the account to `needs_reauth` (Slice 002 helper) and the reclassify call returns HTTP 401 with `{ error: 'needs_reauth', account_id }`.
  3. On success, append a new row to `processed_messages` with the new decision. **No upsert, no overwrite** — a fresh row, with a fresh surrogate `id`, capturing this run.
  4. If the new decision is a receipt or invoice, walk the artifacts: for each new `(account_id, content_hash)` not already present in `documents`, write the file via Slice 006's file store and insert a new `documents` row. Existing `documents` rows for prior attempts of the same message are untouched.
  5. Return the new audit row plus any new document ids; the UI replaces the row's display in place and refetches the current page so prior attempts remain visible above/below the new one.
- **Why a thin reclassify wrapper.** Slice 006's sync orchestrator uses `classifyMessage` and writes one `processed_messages` row per message, skipping when one already exists. Reclassify needs the inverse semantics (always append, never skip) plus selective document persistence (skip artifacts already stored by prior attempts). The wrapper keeps these rules together and lets Slice 014's batch tool reuse it without duplicating logic.
- **Open in Gmail.** The deep-link URL is `https://mail.google.com/mail/u/?authuser=${EMAIL}#all/${MESSAGE_ID}`. Gmail honors `authuser=<email>` regardless of which positional slot (`/u/0/`, `/u/1/`) the browser session is currently using, so the link lands in the correct inbox even when the user has multiple Gmail accounts signed into the same browser. The link opens in a new tab (`target="_blank"`, `rel="noopener noreferrer"`); we never proxy through our backend (it's just an outbound link) so no token leakage.
- **Account labelling on every row.** The Account column shows `account.email` plus `account.display_name` (when set) plus a smaller secondary `account.slug` hint, so a user with multiple accounts can disambiguate at a glance. This satisfies architecture's "with an account column" requirement.
- **Status column without UI emphasis.** Per the slice's note "this slice can stub", the status column shows `success` or `failed` as plain text (with no color or icon) in this slice. Slice 012 adds the visual indicator and a dedicated filter, plus the retry surface. The Reclassify button shipped here will *also* let the user retry a failed row by clicking it — that's a side effect of the button's per-row scope.
- **Performance considerations.** For up to a few thousand audit rows, a single `LIMIT 50` SQLite query with the JOINs is fine. The `(account_id, processed_at)` index from Slice 004 helps account-scoped queries; cross-account queries scan but are still fast for typical sizes. If the audit log grows to >100k rows over years of use, FTS5 + dedicated indices would help; deferred until measured.
- **Tags surfacing.** Receipt rows show their documents' tags as chips. Failed rows or `other` rows show no tag column (since they have no documents). The tag chip rendering reuses `TagChip` from Slice 009 verbatim.

## Acceptance criteria

- After Slice 010, navigating to `/audit` shows a paginated table of all `processed_messages` rows across all connected accounts, with the most recent ones first.
- Each row's Account column shows the originating account's email and (when set) display_name; the column is consistent across rows produced by sync.
- Filtering by account narrows to that account; clearing the filter restores the full listing. Same for classification, confidence, sender_domain, since/until, and `q` (free-text subject substring).
- The URL query string mirrors the active filters; reloading the page (or pasting the URL into a new tab) restores the same filtered view.
- The "Open in Gmail" link on a row opens `https://mail.google.com/mail/u/?authuser=<email>#all/<message_id>` in a new tab; switching the active Gmail-web session to a different account between clicks does not change which inbox the link opens.
- Clicking "Reclassify" on a row runs the classifier synchronously and adds a new `processed_messages` row for the same `(account_id, message_id)` with `processed_at = now()`; the audit table refetches and shows both rows (the prior attempt and the new one), most-recent-first.
- If the reclassified message produces a new artifact (e.g. the body wasn't a receipt before but is now), a new `documents` row is created. If the artifact's bytes are identical to a previously-stored one for the same account, no new file is written and no new `documents` row is inserted (the Slice 006 hard-dedup constraint catches it).
- Reclassifying a `success` row whose new decision matches the prior decision still appends a new `processed_messages` row (audit fidelity); reclassifying a `failed` row from a transient error and getting a `success` produces a fresh `success` row.
- The Status column shows `success` or `failed` as plain text; no color/icon treatment yet (Slice 012).
- The Tags column shows the receipt's tags as chips for any `receipt`/`invoice` row whose document(s) have tags applied via Slice 009; non-receipt rows show no chips.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes — reclassify uses Slice 003's `getMessage` and `getAttachment` (read endpoints); no write paths are added.

## Implementation notes

- **Schema dependencies on Slice 004 / 006.** This slice assumes `processed_messages` has a surrogate `id` PRIMARY KEY and no unique constraint on `(account_id, message_id)`, and that `documents` has no composite FK to `processed_messages` (only `account_id REFERENCES accounts(id)`). Slice 004 and Slice 006 ship those shapes.
- **Unindexed substring search.** `q LIKE '%' || ? || '%'` is fine for the few-thousand-row corpora a single-user install accumulates. FTS5 is deferred until measured.
- **Reclassify and `documents.review_status`.** A reclassify that creates a new document inserts it as `review_status='pending'` so it surfaces in Review. A reclassify that produces no new documents (hard-dedup blocked them) leaves prior documents' review state unchanged. The "model now disagrees" soft-flag is Slice 014's responsibility, not this slice's.
- **No per-row diff in this slice.** Reclassified rows show as separate audit rows ordered by `processed_at`. A summary diff for batch reclassify is Slice 014.
- **Status column with no visual.** Plain-text `success`/`failed`. Slice 012 adds the colored indicator and the dedicated retry surface.
- **`document_count` is cumulative across attempts.** `COUNT(documents WHERE account_id=? AND message_id=?)` returns all documents for the message, not just the attempt's contribution. Matches the user's mental model ("how many receipts came out of this email overall").
- **Reclassify timeout behavior.** Reuses `OLLAMA_TIMEOUT_MS` (default 120s). On timeout the endpoint returns 502 and writes a `status='failed'` row; the user can re-click.
- **No multi-tag filter, no review_status filter on Audit.** Filter set kept tight; tag/review filtering on the Audit view can ship as a polish follow-up.
- **Open in Gmail link reliability.** Uses Gmail's `authuser=<email>` URL parameter, which honours the right account regardless of positional `/u/N/` slot. If Google ever changes this URL behavior, links would fall back to the default signed-in account; no alternative without an installed-app deep-link scheme.
