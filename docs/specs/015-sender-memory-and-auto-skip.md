# Slice 015: Sender memory and auto-skip

**Status:** draft

## Observable result

After approving several Stripe receipts in my business inbox, the next sync auto-approves new high-confidence Stripe receipts from that account without putting them in the review queue (with a clear "auto-approved" badge). I can also explicitly blocklist a noisy newsletter domain from one account so future syncs skip it entirely without ever calling the classifier — and these signals stay scoped per account, so trusting Stripe in business doesn't change how Stripe mail is handled in personal.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` — append-only with `id INTEGER PRIMARY KEY` (Slice 004 amendment)
  - `documents` — including `vendor`, `amount`, `currency`, `transaction_date`, `review_status`, `model_disagrees` (Slices 006 / 008 / 014), plus the `*_edited` flags (Slice 008)
  - `review_actions` (Slice 007)
  - `senders` — including `account_id`, `domain`, `approved_count`, `rejected_count`, `last_seen_at` (Slice 007); extended here with a `listing` column (see Deliverables)
  - `tags`, `document_tags` (Slice 009)
- **Migrations:**
  - `0001`–`0013` (Slices 002–014)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `POST /api/documents/:id/approve`, `POST /api/documents/:id/reject` (Slice 007) — already keep `senders` counts in sync with each user action
- **UI views / components:**
  - `Settings.tsx` (Slice 009) — extended here with a "Senders" section
  - `Review.tsx`, `ReviewMetadata.tsx` (Slices 007 / 008 / 009 / 013 / 014) — extended here with an "auto-approved" indicator on relevant rows that surface there
  - `Inbox.tsx` (Slice 006) — extended here to surface the auto-approved badge
  - `AuditTable.tsx` (Slices 010 / 012 / 014) — extended here to surface "auto-skipped" rows
  - `AccountPicker.tsx` (Slice 003), `Nav.tsx`, `TagChip.tsx`
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slices 006 / 013) — extended here to consult `senders.listing` and the auto-approve heuristic
  - Reclassify single-row + batch orchestrators (Slices 010 / 014) — extended here so reclassification respects allowlist (auto-approve) but **bypasses** blocklist (a user explicitly clicking "Reclassify" or running a batch is an override of the blocklist)
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `OLLAMA_URL`, `OLLAMA_MODEL` (Slice 005)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/senders.ts` (Slice 007)
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008 / 009 / 013 / 014)
  - `src/server/db/repositories/review_actions.ts` (Slice 007)
  - `src/server/sync/orchestrator.ts` (Slices 006 / 013) — extended here
  - `src/server/sync/reclassify.ts` (Slices 010 / 013 / 014) — extended here
  - `src/server/api/review.ts` (Slices 007 / 014)
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Google OAuth + Gmail API access per account (Slice 002 + 003)
  - Ollama at `OLLAMA_URL` (Slice 005)
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `senders.listing` TEXT NULL — `'allow'`, `'block'`, or NULL. NULL is the default (no explicit listing); the auto-approve heuristic looks at NULL-listing rows. CHECK constraint: `listing IS NULL OR listing IN ('allow','block')`.
  - `documents.auto_approved` INTEGER NOT NULL DEFAULT 0 — boolean (`0`/`1`). `1` when the document was approved by a non-user actor (allowlist or auto-approve heuristic). Cleared if the user explicitly approves or rejects the same document afterwards (the user action overrides the auto action and a fresh `review_actions` row records the override).
- **Migrations:**
  - `0014_add_senders_listing.sql` — `ALTER TABLE senders ADD COLUMN listing TEXT NULL CHECK (listing IS NULL OR listing IN ('allow','block'))`. No data migration needed; existing senders rows default to NULL.
  - `0015_add_documents_auto_approved.sql` — `ALTER TABLE documents ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0`. No backfill: pre-Slice-015 docs were either user-approved (review_status='approved' with `auto_approved=0` is the correct historical truth) or pending/rejected.
- **API endpoints:**
  - `GET /api/accounts/:id/senders?limit=&offset=&listing=&q=` → response `{ rows: Array<{ domain, approved_count, rejected_count, last_seen_at, listing, document_count }>, total: number }`. `listing` filter accepts `'all' | 'allow' | 'block' | 'none'` (default `'all'`). `q` is a free-text substring filter on `domain`. `document_count` is computed via JOIN to `documents` for the "in N receipts" hint in the manager. Default sort: `last_seen_at DESC NULLS LAST` (most recently seen senders first).
  - `PATCH /api/accounts/:id/senders/:domain` → request body `{ listing: 'allow' | 'block' | null }` (Zod-validated). Updates the row (creates it if missing — a user can pre-emptively blocklist a domain that hasn't appeared yet). Returns the updated row. Idempotent on repeats. Inserts a `review_actions` row with `action='listing_changed'` and `details = { domain, prior_listing, new_listing }` for auditability — see Risks for the `review_actions` enum extension.
  - `POST /api/accounts/:id/senders/bulk-listing` → request body `{ domains: string[], listing: 'allow' | 'block' | null }`. Convenience endpoint for the manager's multi-select. Single transaction.
- **UI views / components:**
  - `SenderManager.tsx` — Settings → Senders section. Top: account dropdown (single-select, defaults to most-recently-used). Body: a paginated table with columns `Domain`, `Approved`, `Rejected`, `Last seen`, `Documents`, `Listing` (a small select with options `auto`, `allow`, `block`); a search box at the top filters by domain substring. Multi-select checkboxes plus a bulk-action bar ("Allowlist selected", "Blocklist selected", "Clear listing on selected") drive `POST /api/accounts/:id/senders/bulk-listing`.
  - `AutoApprovedBadge.tsx` — small label rendered next to documents with `auto_approved=1`. Tooltip: "Approved automatically by sender memory ({reason: allowlist | trust threshold})". Reused in `Review` (rare, since auto-approved docs aren't pending), `Inbox` (visible there with `review_status='approved'`), and `AuditTable`.
  - `AutoSkippedRow.tsx` — small visual variant of an `AuditTable` row for messages that were `auto-skipped` (sender on blocklist). The row's classification cell shows "skipped (sender blocked)" instead of `other`/`receipt`/`invoice`; the model_used cell shows `auto-block`.
  - `Settings.tsx` (modified) — fills in the previously-disabled (and Slice 011-partially-filled) Senders section.
  - `Review.tsx`, `ReviewMetadata.tsx` (modified) — render `<AutoApprovedBadge />` when applicable; the badge is rare in the review queue (auto-approved docs are filtered out of pending), but appears when a user navigates back via `k` to a previously auto-approved doc.
  - `Inbox.tsx` (modified) — renders `<AutoApprovedBadge />` on rows; lets the user filter to "auto-approved" via an extra checkbox in the toolbar (defaults off).
  - `AuditTable.tsx` (modified) — renders `<AutoApprovedBadge />` on relevant rows; renders auto-skipped rows with the muted styling and the special model-used cell.
- **Background jobs / orchestrators:**
  - Sync orchestrator (modified) — for each message, after extracting `sender_domain` and before calling the classifier:
    1. Look up the message's sender row via `senders.get({ account_id, domain })`. If the row's `listing='block'`, skip classification: append a `processed_messages` row with `status='success'`, `classification='other'`, `confidence='high'`, `model_used='auto-block'`, `reason='sender on blocklist'`, plus the standard `account_id`, `message_id`, `sender_domain`, `subject`, `internal_date`, `processed_at`. No `documents` row. Emit the `sync.message` event with the special status. Continue.
    2. Otherwise, run the classifier as normal.
    3. After classification, if the result is `receipt` or `invoice` AND (the sender's `listing='allow'` OR the auto-approve heuristic — see Detailed design — fires), persist the document(s) as usual but with `review_status='approved'` and `auto_approved=1`, then insert a `review_actions` row with `action='approved'` and `details = { auto: true, reason: 'allowlist' | 'trust_threshold', approved_count, rejected_count }`. The `senders.approved_count` is **not** auto-incremented for auto-approvals (see Risks: the heuristic should only learn from genuine user actions).
  - Reclassify single-row + batch (modified) — they bypass blocklist (a user-triggered reclassify is itself an override of "skip this sender"). They respect allowlist + auto-approve heuristic for newly-produced documents the same way sync does.
- **Env vars / configuration:**
  - `AUTO_APPROVE_THRESHOLD` (default `5`) — minimum `senders.approved_count` for the auto-approve heuristic to fire.
  - `AUTO_APPROVE_MAX_REJECTIONS` (default `0`) — `senders.rejected_count` must be `≤` this for the heuristic to fire. Default is strict (zero rejections).
  - `AUTO_APPROVE_REQUIRES_HIGH_CONFIDENCE` (default `true`) — if true, the heuristic only fires when the classifier's confidence is `'high'`. If false, `'medium'` and `'high'` both qualify.
  - `docker-compose.yml` updated to pass through the three new env vars.
- **Files / modules:**
  - `src/server/db/migrations/0014_add_senders_listing.sql`, `0015_add_documents_auto_approved.sql`
  - `src/server/db/repositories/senders.ts` (modified) — `setListing({ account_id, domain, listing })`, `bulkSetListing({ account_id, domains, listing })`, `listForAccount({ account_id, limit, offset, listing, q })` (extended). The Slice 007 increment methods are unchanged.
  - `src/server/db/repositories/documents.ts` (modified) — `insertWithAutoApproval` variant returning the new id along with `auto_approved` set as appropriate; existing `insert` is unchanged. Repository methods that surface document rows (Inbox listing, Review queue, Audit JOIN, Export select) are extended to include `auto_approved` in their projections.
  - `src/server/sender-memory/listing.ts` — `lookupListing({ account_id, domain }) → 'allow' | 'block' | null` thin wrapper around `senders.get`.
  - `src/server/sender-memory/auto-approve.ts` — `shouldAutoApprove({ account_id, sender_domain, classification, confidence }): { fire: boolean, reason?: 'allowlist'|'trust_threshold', stats?: { approved_count, rejected_count } }`. Pure(-ish — reads the senders row) decision function used by both sync and reclassify orchestrators.
  - `src/server/sync/orchestrator.ts` (modified) — wires the listing pre-check and the auto-approve post-check into the existing per-message transaction.
  - `src/server/sync/reclassify.ts` (modified) — same wiring for the reclassify path; explicit comment that blocklist is bypassed for reclassify.
  - `src/server/api/senders.ts` — registers `GET /api/accounts/:id/senders`, `PATCH /api/accounts/:id/senders/:domain`, `POST /api/accounts/:id/senders/bulk-listing`.
  - `src/server/api/review.ts` (modified) — Slice 007's approve handler clears `auto_approved=0` when a user manually approves an already-auto-approved document; the reject handler likewise clears `auto_approved=0` (a manual reject overrides the auto-approval). Both inserts a corrective `review_actions` row recording the override.
  - `src/client/views/SenderManager.tsx`, `src/client/components/AutoApprovedBadge.tsx`, `src/client/components/AutoSkippedRow.tsx`
  - `src/client/views/Settings.tsx` (modified)
  - `src/client/views/Review.tsx`, `src/client/components/ReviewMetadata.tsx` (modified)
  - `src/client/views/Inbox.tsx` (modified)
  - `src/client/components/AuditTable.tsx` (modified)
- **External services:** —
- **Other:**
  - First slice that introduces a "model_used" string outside the actual model name. `'auto-block'` flags a row produced by the blocklist short-circuit. `'auto-allow'` is **not** used (allow-listed messages still go through the real classifier — see Detailed design).
  - First slice that creates `documents` rows with `review_status='approved'` and a corresponding `review_actions` row in the same transaction — without the user clicking anything. Auto-approval is auditable end-to-end via `review_actions.details.auto=true`.

## Out of scope

- Confidence boosting that changes the classifier's stated `confidence` value based on sender stats → not planned for v1; the heuristic uses sender stats to decide auto-approval, but the classifier's reported `confidence` is preserved as-is in the `processed_messages` row
- Pattern-based listings (e.g. blocklist `*.newsletter.com`) → not planned; v1 uses exact domain matches
- Sender allowlist that bypasses the classifier entirely (skip Ollama, mark as receipt without extraction) → not planned; allowlist auto-approves the *result* of classification, but classification still runs to extract vendor/amount/currency/date for the manifest
- Reverting an auto-approval to `pending` (other than via reject) → not planned; user reject is the override
- Cross-account sender memory ("trust Stripe everywhere") → explicitly forbidden by architecture
- Auto-skip notifications ("we skipped 12 newsletters this sync") in a Dashboard banner → polish; the audit view's "auto-block" rows are the canonical surface
- Mass-import a blocklist from a file → not planned; v1 ships per-row toggles + bulk multi-select
- Per-tag auto-listings ("auto-approve receipts tagged `business`") → not planned; tags are document-level, listings are sender-level
- A "trust score" UI that displays computed confidence from sender stats → not planned for v1; the badge is binary

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Settings" (the sender allowlist/blocklist editor), § "Components — Backend — Classification module" (the conservative-confidence note plus the implicit "trust learned from per-account user actions"), and `initial-feature-slices.md`'s "auto-flag high-confidence receipts from frequently-approved senders" plus "auto-skip from blocked senders". The design strictly preserves the privacy-by-architecture and per-account isolation principles: signals from one connected account do not influence behavior in another.

- **Three mechanisms, one per category.**
  - **Blocklist (explicit, hard skip).** User toggles a sender to `block`. Future sync calls for that sender's messages skip the classifier and write a synthetic `processed_messages` row with `model_used='auto-block'`. No document, no Ollama call, no email content read beyond what `users.messages.list` and the `From` header already returned. Privacy property: blocklisted messages' bodies and attachments are never fetched.
  - **Allowlist (explicit, auto-approve).** User toggles a sender to `allow`. Future sync calls still run the classifier (we need vendor/amount/etc. for the manifest), but if the result is `receipt` or `invoice`, the document is created with `review_status='approved'` and `auto_approved=1`. The user trusts this sender to be a receipt source.
  - **Auto-approve heuristic (implicit, user-history-driven).** When the user has approved many receipts from a sender (≥`AUTO_APPROVE_THRESHOLD`, default 5) and rejected none (`≤AUTO_APPROVE_MAX_REJECTIONS`, default 0), the system applies the same auto-approval as allowlist. The thresholds are conservative: the cost of a false-positive auto-approval is "user has to undo a wrong receipt"; the cost of a false-negative is "user has to manually approve". The first is worse, so the defaults err on the side of less aggressive auto-approval.
- **Per-account isolation.** Every check uses `(account_id, sender_domain)`. The Slice 007 schema's `senders` table has `(account_id, domain)` as primary key, so signals genuinely cannot cross. Architecturally, "trust" lives where the inbox-specific evidence lives.
- **Why `model_used='auto-block'` and not `model_used=''` or `NULL`.** The `processed_messages.model_used` column is NOT NULL (Slice 004). Using a sentinel value keeps the schema simple. Future analytics that ask "how often did the model run?" can filter `model_used NOT LIKE 'auto-%'` to skip auto-actions.
- **Why allowlist still classifies.** Skipping the classifier on allowlisted senders would save Ollama time, but we need vendor/amount/currency/transaction_date for the export manifest; without those fields the document row has nulls and the manifest is incomplete. Running the classifier and trusting its decision (auto-approving the result) is the right balance: no manual review, but full extraction.
- **`auto_approved` lifecycle.** Set on creation by the orchestrator. Cleared (via the Slice 007 approve/reject handlers, modified here) when the user explicitly approves or rejects the doc; the user's action wins, and a fresh `review_actions` row records the override. This means `auto_approved=1` always reflects "still auto-approved, no user override yet"; queries that want "anything ever auto-approved, including user-overridden" can JOIN `review_actions` for `details.auto=true`.
- **Sender stats are user-driven, not auto-driven.** `senders.approved_count` and `rejected_count` are incremented only by Slice 007's user approve/reject handlers. This slice's auto-approval **does not** increment `approved_count` — otherwise auto-approvals would feed back into the heuristic and lock in early biases. The heuristic only learns from genuine user actions.
- **Reclassify and listings.** Slice 014's batch reclassify already runs through Slice 010's per-message wrapper. The wrapper consults the auto-approve check in this slice for any newly-produced documents (so a previously-other message that's now a receipt and the sender is allowlisted gets auto-approved on the spot). Blocklist is **bypassed** for reclassify: a user clicking "Reclassify" or running a batch is asserting "I want this run regardless of my listings." The bypass keeps the user-control invariant: explicit user action always overrides any auto-rule.
- **Sender manager UX.** Most-recently-seen senders surface first. The user sees a list ordered by familiarity. The bulk-multi-select is the primary path for blocklisting a batch of newsletter domains in one pass; per-row toggle is the path for allowlisting a single trusted sender. Search filters help find a specific domain in long lists.
- **Audit-trail completeness.** Every state change — adding a listing, removing a listing, an auto-approval, a user-override of an auto-approval — produces a `review_actions` row. The `review_actions.action` enum was set up in Slice 007 with `('approved','rejected','edited','tagged')`. This slice adds `'listing_changed'` to that CHECK constraint via a migration update. See Risks for the migration mechanics.
- **Performance.** The blocklist pre-check is a single indexed query per message (`senders.get` on the PK `(account_id, domain)`). The auto-approve check is the same query for sender stats, plus a constant-time comparison. Both add negligible cost to the sync's per-message budget, which is dominated by the classifier.

## Acceptance criteria

- After Slice 015 migrations apply, `sqlite3 data/app.db ".schema senders" | grep listing` shows `listing TEXT NULL CHECK ...`. Existing `senders` rows have `listing=NULL`.
- `sqlite3 data/app.db ".schema documents" | grep auto_approved` shows the new column with `NOT NULL DEFAULT 0`. Existing `documents` rows have `auto_approved=0`.
- Settings → Senders shows a list of senders for the picked account with their stats and listing status. Toggling a row to `block` calls the PATCH endpoint; the `senders.listing` column updates.
- Running a fresh sync against an account with one sender blocklisted: any message from that sender produces a `processed_messages` row with `model_used='auto-block'`, `classification='other'`, `confidence='high'`, no `documents` row, no Ollama call. The Audit view shows the row with the auto-skipped styling.
- Running a fresh sync against an account with one sender allowlisted: any classifier-confirmed receipt from that sender produces a `documents` row with `review_status='approved'` and `auto_approved=1`; a `review_actions` row with `details.auto=true, reason='allowlist'` is also written; the Inbox view shows the doc with the `AutoApprovedBadge`.
- Approving 5 receipts from a sender (with no rejections) — followed by a sync that processes a 6th receipt from the same sender: the new doc lands with `review_status='approved'`, `auto_approved=1`, `review_actions.details.reason='trust_threshold'`. The 6th approval does **not** show up in `senders.approved_count` (it's auto, not user).
- Rejecting one receipt from a previously-allowlisted sender disables the auto-approve heuristic for future messages from that sender (because `rejected_count > AUTO_APPROVE_MAX_REJECTIONS=0`). The user can re-enable by either clearing rejections (manual SQL only — out of UI scope) or by raising `AUTO_APPROVE_MAX_REJECTIONS` via env var.
- A user manually rejecting an auto-approved doc updates `documents.review_status='rejected'`, `auto_approved=0`, increments `senders.rejected_count`, and writes a fresh `review_actions` row with `action='rejected'` (the override).
- Reclassify (single-row or batch) on a previously-blocked message: classification runs (the blocklist is bypassed), a new `processed_messages` row is appended; if it produces a new document, the document is auto-approved if the allowlist/heuristic conditions hold.
- The same Stripe sender allowlisted in `business@…` is unaffected in `personal@…`: a new Stripe receipt arriving in the personal account goes to the normal review queue with `review_status='pending'`, `auto_approved=0`.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.
- `GET /api/accounts/:id/senders?listing=block` returns only blocklisted senders for that account.

## Risks / open questions

- **Extending `review_actions.action` CHECK constraint.** Slice 007 created the column with `CHECK (action IN ('approved','rejected','edited','tagged'))`. SQLite doesn't support `ALTER TABLE ... DROP CONSTRAINT`, so adding `'listing_changed'` requires the standard migration dance: create new table, copy data, drop old, rename. Provisional choice: do exactly that in `0014_add_senders_listing.sql`. Alternative: skip the audit row for listing changes (less complete audit). Flag.
- **Auto-approve threshold defaults.** `5` approvals with `0` rejections is a guess. Real-world: most users will see auto-approval kick in after a few weeks of usage from common senders (Stripe, AWS, etc.). If the threshold is too aggressive, false-positive auto-approvals cause confusion; if too conservative, the feature feels useless. Tunable via env var; flag for confirmation.
- **Heuristic doesn't learn from auto-approvals.** This is intentional (avoid runaway feedback) but means a sender stays at `approved_count=N` indefinitely if the user only ever sees auto-approvals from it. New non-receipt mail from that sender (which would re-enter the review queue if the classifier disagrees) can change the picture, but in steady state the count stays put. Acceptable; flag.
- **Allowlist doesn't skip Ollama.** Some users might want "I trust this sender, don't even bother classifying — just store the attachment." Provisional choice: keep classification because manifest fields require it. Alternative: an extra `auto_extract_only` listing that runs lightweight extraction without classification — out of scope for v1. Flag.
- **Blocklist privacy property.** Blocklisted messages have their `From` header read (necessary to extract the sender domain) and their `subject` stored in `processed_messages` (Slice 004's column). Body and attachments are never fetched. Some users might want a stricter "list-only blocklist" that doesn't even store the subject — out of scope; flag.
- **Bulk listing changes audit volume.** A user blocklisting 50 newsletters at once writes 50 `review_actions` rows. Acceptable; the audit log scales linearly with operations.
- **Auto-skipped sync events.** The SSE `sync.message` event needs a discriminator so the UI can render auto-skipped progress differently from classified progress. Provisional: extend the existing `sync.message` event with a `kind: 'classified' | 'auto-skipped' | 'auto-approved'` field. Slice 006's spec doesn't pin the field set rigidly, so this is a forward-compatible additive change. Flag.
- **Auto-approval and tags.** Auto-approved docs have no tags (no user has touched them). The Slice 011 export's tag filter then excludes them. For users who export by tag, this means auto-approved docs are invisible to the export. Solution: tag rules per sender (out of scope for v1). Flag — documented behavior, may surprise.
- **`AUTO_APPROVE_MAX_REJECTIONS=0` is strict.** A single accidental reject permanently disables auto-approve for that sender (until env var change or DB tweak). UX-friendlier alternatives include time-decay on rejection counts. Flag.
- **No sender renaming.** If a domain changes (`stripe.com` becomes `payments.stripe.com`), the sender stats for the old domain don't transfer. Manual cleanup via the manager (toggle listings on the new domain). Flag.
