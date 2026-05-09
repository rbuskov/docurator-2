# Slice 013: Document groups and dedup display

**Status:** ready

## Observable result

When the same Stripe receipt arrives as both an HTML body and a PDF attachment in the same inbox, I see a "This appears to also be in 1 other email in this account" panel in the Review view's metadata pane, with a quick-select button to jump to the sibling document and decide which one to approve. The same receipt arriving in two different connected inboxes (e.g. business and personal) does **not** group across accounts — each inbox keeps its own grouping.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` (Slice 004)
  - `documents` — including `vendor`, `amount`, `currency`, `transaction_date`, `account_id`, `review_status`, plus the `*_edited` flags (Slices 006 / 008)
  - `review_actions` (Slice 007), `senders` (Slice 007)
  - `tags`, `document_tags` (Slice 009)
- **Migrations:**
  - `0001`–`0010` (Slices 002–009)
- **API endpoints:**
  - `GET /api/review/queue` (Slice 007)
  - `GET /api/documents/:id/file` (Slice 006)
  - `PATCH /api/documents/:id` (Slice 008) — extended here to recompute fingerprint and group membership on relevant field edits
- **UI views / components:**
  - `Review.tsx`, `ReviewMetadata.tsx` (Slices 007 / 008 / 009) — extended here with the group panel
  - `Inbox.tsx` (Slice 006), `Audit.tsx` (Slice 010) — unchanged here; group membership is a Review-pane concern in this slice
  - `Nav.tsx`, `AccountPicker.tsx` (Slice 003), `TagChip.tsx` (Slice 009)
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006) — extended here to compute fingerprint and attach each new `documents` row to a `document_group`
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008 / 009)
  - `src/server/sync/orchestrator.ts` (Slice 006) — extended here
  - `src/server/sync/reclassify.ts` (Slice 010) — extended here so reclassification-produced documents also get fingerprinted and grouped
  - `src/server/api/documents.ts` (Slices 006 / 008 / 009) — extended here
  - `src/client/main.tsx` (Slice 001)
  - `src/client/App.tsx` (Slice 001)
  - `src/client/api.ts` (Slice 002)
  - `src/client/router.tsx` (Slice 003)
- **External services:** —
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `document_groups` table:
    - `id` INTEGER PRIMARY KEY AUTOINCREMENT
    - `account_id` INTEGER NOT NULL REFERENCES `accounts`(`id`) — groups are scoped per account; a fingerprint that matches across two connected accounts produces two separate groups
    - `fingerprint` TEXT NOT NULL — SHA-256 hex of the normalized fingerprint string (see Detailed design)
    - `created_at` TEXT NOT NULL — ISO 8601 timestamp
    - UNIQUE (`account_id`, `fingerprint`) — there is at most one group per `(account_id, fingerprint)` pair
  - `document_group_members` table:
    - `group_id` INTEGER NOT NULL REFERENCES `document_groups`(`id`) ON DELETE CASCADE
    - `document_id` INTEGER NOT NULL UNIQUE REFERENCES `documents`(`id`) ON DELETE CASCADE — a document is in at most one group at a time; on edit-driven re-fingerprinting, the row is deleted and re-inserted under the new group
    - `joined_at` TEXT NOT NULL
    - PRIMARY KEY (`group_id`, `document_id`)
- **Migrations:**
  - `0011_create_document_groups.sql`
  - `0012_create_document_group_members.sql` — also includes a one-time **backfill** at the bottom of the migration: for every existing `documents` row whose `vendor`, `amount`, `currency`, and `transaction_date` are all non-NULL, compute the normalized fingerprint and insert (or attach to) the appropriate `(account_id, fingerprint)` group. Documents missing any of the four fields are left ungrouped (no `document_group_members` row); they re-enter grouping on the first relevant edit (Slice 008's PATCH) or reclassification (Slice 014). The migration is idempotent: re-running it on an already-backfilled DB inserts no duplicate groups (because of the UNIQUE constraint) and inserts no duplicate members (because of the unique-on-`document_id` constraint).
- **API endpoints:**
  - `GET /api/documents/:id/group-members` → response `{ group_id: number | null, members: Array<{ document_id, kind, filename, mime_type, vendor, amount, currency, transaction_date, review_status, account_id }> }`. `group_id` is `null` for documents that are not in any group (missing fingerprint fields, or only-member would-be group). When non-null, `members` includes the document itself plus any siblings; the `members` array is ordered by `joined_at` ascending so the canonical "first arrival" is first. Used by the Review pane.
- **UI views / components:**
  - `DocumentGroupPanel.tsx` — small disclosure block rendered in `ReviewMetadata.tsx` below the editable fields, **only when the document has ≥1 sibling** (i.e. `members.length > 1`). Header copy: `This appears to also be in {N} other email{s} in this account`. Body: a row per sibling showing kind (`attachment` / `rendered_body`), filename, vendor (when set), and a "Go to" button that navigates the Review queue to that sibling document. When the sibling's `review_status !== 'pending'`, an inline label says `(approved)` or `(rejected)`.
  - `ReviewMetadata.tsx` (modified) — mounts `<DocumentGroupPanel />` below the tag picker.
  - `Review.tsx` (modified) — its in-memory queue navigation (Slice 007's `j`/`k` and the Slice 007 cursor) gains a small extension: when "Go to" is clicked on a sibling, the queue pre-pends or splices the sibling into the cursor history so `k` walks back to where the user was. This is purely client-side cursor management, no server change.
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slice 006) is **extended** in this slice — every newly-inserted `documents` row gets fingerprinted (when fields allow) and attached to a `document_group` in the same transaction as the document insert.
  - Reclassify orchestrator (Slice 010) is **extended** the same way — a new document produced by a reclassify call is fingerprinted and grouped.
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/db/migrations/0011_create_document_groups.sql`
  - `src/server/db/migrations/0012_create_document_group_members.sql` — includes the backfill described above
  - `src/server/db/migrate.ts` (modified, originally Slice 002) — extends the migration runner to detect a `-- BACKFILL` marker as the last non-empty line of a `.sql` migration. When the marker is present, after applying the SQL the runner runs a Node-side companion pass (resolved by filename — e.g. `0012_create_document_group_members.sql` → `migrations/0012_create_document_group_members.backfill.ts`) inside the same transaction as the migration's recording in `_migrations`. Idempotent: the companion pass relies on the migration's UNIQUE constraints to make re-application a no-op.
  - `src/server/db/migrations/0012_create_document_group_members.backfill.ts` — the Node-side companion to migration 0012. Iterates every `documents` row, computes fingerprint via `dedup/fingerprint.ts`, and inserts the appropriate `document_groups` and `document_group_members` rows.
  - `src/server/dedup/fingerprint.ts` — `computeFingerprint({ vendor, amount, currency, transaction_date }): string | null`. Returns `null` if any of the four inputs is `null` / empty; otherwise returns the SHA-256 hex of the normalized concatenation. Pure function, no DB.
  - `src/server/db/repositories/document_groups.ts` — `findOrCreate({ account_id, fingerprint })` (transaction-safe via `INSERT … ON CONFLICT DO NOTHING; SELECT id FROM document_groups WHERE …`), `attachMember({ group_id, document_id })` (uses `INSERT OR REPLACE` on `document_group_members` since each document has at most one membership), `detachMember(document_id)`, `listMembers(group_id)`, `getGroupForDocument(document_id)`. All methods are account-aware via the `document_groups.account_id` column on the parent.
  - `src/server/sync/orchestrator.ts` (modified) — after each successful `documents` insert, computes fingerprint and (when non-null) calls `findOrCreate` + `attachMember`, all inside the per-message transaction so a partial state never leaks.
  - `src/server/sync/reclassify.ts` (modified) — same extension for reclassify-produced documents.
  - `src/server/api/documents.ts` (modified) — `PATCH /api/documents/:id` (originally Slice 008) now computes the fingerprint from the post-edit values; if it differs from the document's current group's fingerprint (or from "no group" when it now has all four fields), the handler `detachMember` from the old group + `findOrCreate` + `attachMember` to the new group, all in the same transaction as the field updates and the `review_actions` writes. If the old group has no remaining members, it is left in place (orphan groups are harmless and may be reused; deleting them would race with concurrent inserts).
  - `src/server/api/documents.ts` (modified) — registers `GET /api/documents/:id/group-members`.
  - `src/client/components/DocumentGroupPanel.tsx`
  - `src/client/components/ReviewMetadata.tsx` (modified)
  - `src/client/views/Review.tsx` (modified)
- **External services:** —
- **Other:**
  - First slice that introduces a derived/maintained relationship across `documents` rows. The repository pattern keeps the maintenance localized; the sync, reclassify, and PATCH paths all funnel through `document_groups.attachMember` so a future migration that changes fingerprint normalization only needs to update `fingerprint.ts` plus a one-time backfill.
  - The architecture's "suggestions for the user's review, not silent merges" rule is preserved: this slice **only** surfaces grouping; it never auto-approves, never auto-rejects, never deletes a document because of group membership.

## Out of scope

- Cross-account grouping (a Stripe receipt arriving in both `business` and `personal` accounts intentionally stays in two separate groups) → not planned for v1; the architecture explicitly rules it out under "Across accounts" in `architecture.md` § "Deduplication strategy"
- A second-tier perceptual / image-similarity fingerprint (e.g. pHash on the rendered receipt image) → architecture's "Open questions / future work" item; not planned for v1
- A "merge group" UI action that joins two adjacent groups the heuristic split → not planned; manual edits to vendor/amount/etc. (Slice 008) cause re-grouping naturally
- An "ungroup this document" UI action → not planned; deferring until user feedback shows it's needed
- Group display in the Inbox or Audit views → not planned for v1; Review pane is the canonical surface per architecture's "review UI shows group members together" framing
- Group-aware export (e.g. "include only the canonical sibling per group" filter) → not planned for v1; Slice 011 ships sub-group-blind exports
- A `canonical_member_id` column on `document_groups` indicating "user picked this one" → polish; v1 leaves canonical-picking implicit (the user simply approves their preferred sibling and rejects the others)
- Notifications about new group members arriving from a later sync → not planned; the user encounters the grouping when they next visit the affected document in Review
- Removing a group when its last member is deleted → not planned (orphan groups are harmless; cleanup can ship later if the group count grows unmanageably)

## Detailed design

This slice realizes `architecture.md` § "Deduplication strategy" (the "Soft dedup (fingerprint)" path), § "Storage" (the `document_groups` and `document_group_members` tables), and § "Key flows — Review" step 3 ("If the document is part of a group with multiple members, show the group"). It is the second dedup mechanism in the system; Slice 006's hard dedup on `documents.(account_id, content_hash)` is the byte-identity check, and this slice adds the metadata-identity check — vendor/amount/currency/date.

- **Fingerprint normalization.** Inputs are normalized before hashing so that benign formatting differences don't break grouping:
  - `vendor` — `vendor.trim().toLowerCase()`. Trailing/leading whitespace and casing don't matter.
  - `amount` — formatted as a fixed-precision decimal string with exactly 2 decimal places (e.g. `42.50`). `42`, `42.0`, and `42.5` would split groups otherwise; the fixed-precision normalization avoids that. Negative amounts are formatted with a leading `-`. JS `Number.toFixed(2)` is the implementation.
  - `currency` — `currency.trim().toUpperCase()`. `usd`, `USD`, ` USD ` all collapse.
  - `transaction_date` — already stored as `YYYY-MM-DD`; used verbatim.
  - The four normalized strings are joined with `|` (a character that does not appear in any of them after normalization), then SHA-256 hex-encoded. The 64-char hex sits in the `fingerprint` column.
- **Grouping rules.** A document with `fingerprint` `F` is attached to the `document_groups` row whose `(account_id, fingerprint) = (doc.account_id, F)`. The row is created lazily on first encounter. Documents missing any of the four fields are left ungrouped (no `document_group_members` row, `getGroupForDocument` returns null). They re-enter grouping if a later edit (Slice 008) fills in the missing fields.
- **Sync-time grouping.** Slice 006's per-message transaction now includes a fingerprint+attach step at the very end, after the `documents` insert and the `processed_messages` insert. If the fingerprint can't be computed (NULL fields), the step is a no-op. The transaction is unchanged in scope; the only addition is one optional `findOrCreate` + `attachMember` call.
- **Reclassify-time grouping.** Slice 010's reclassify orchestrator wraps `classifyMessage` with persistence rules. When reclassify produces a *new* document (not a hard-dedup-blocked one), the same fingerprint+attach pattern runs in the same transaction. A reclassified message that produces no new documents (because the new artifacts dedup against existing ones) doesn't change group membership.
- **Edit-time re-grouping.** Slice 008's `PATCH /api/documents/:id` handler is the third entry point. After the field updates, the handler:
  1. Computes the new fingerprint from the post-edit values.
  2. Looks up the document's current group via `getGroupForDocument`.
  3. If the new fingerprint is non-null and differs from the current group's fingerprint (or the document was ungrouped), `detachMember(document_id)` then `findOrCreate({account_id, fingerprint: new_fp})` then `attachMember({group_id, document_id})`.
  4. If the new fingerprint is null and the document was previously grouped, `detachMember(document_id)`.
  All inside the existing PATCH transaction. The `review_actions.action='edited'` row is unchanged — it captures the field-level diff, not the group-membership change. (Group membership is a derived attribute; the audit trail in `review_actions` plus the deterministic fingerprint function are sufficient to reconstruct group history.)
- **Review pane integration.** `DocumentGroupPanel` calls `GET /api/documents/:id/group-members` when the user opens a document. If `members.length <= 1`, the panel doesn't render — single-member "groups" are indistinguishable from "no group" from the user's perspective. When ≥1 sibling is present, the panel lists them with quick-select buttons. Clicking "Go to" splices the sibling into the Review cursor and navigates; pressing `k` (Slice 007 keyboard shortcut) returns to the prior position.
- **Backfill scope.** The 0012 migration's backfill computes fingerprints for every existing `documents` row at apply time. Computing SHA-256 inside SQLite is awkward, so the migration runner detects the `-- BACKFILL` marker in `0012_create_document_group_members.sql` and runs a Node-side pass that iterates the rows, computes fingerprints, and inserts the appropriate `document_groups` and `document_group_members` rows. The migration is recorded as applied only after the Node pass completes; the pass is idempotent against the UNIQUE constraints so re-applying is safe.
- **Recurring monthly invoices stay separate.** Two AWS bills with `vendor='aws'`, `amount=42.50`, `currency='USD'`, but `transaction_date='2026-04-30'` and `2026-05-31` produce different fingerprints and stay in different groups. This is the architecture's intended behavior (`architecture.md` § "Deduplication strategy" — "Series vs duplicates").
- **Orphan groups.** When a document changes fingerprint via edit and was the last member of its old group, the group row is left behind with zero members. Cleaning these up would require a "did anyone else just attach?" race-free check; for now they're harmless rows costing a few bytes each. A future polish slice can vacuum them with a query like `DELETE FROM document_groups WHERE id NOT IN (SELECT DISTINCT group_id FROM document_group_members)`.

## Acceptance criteria

- After Slice 013 migrations apply, `sqlite3 data/app.db ".schema document_groups"` and `".schema document_group_members"` show the expected schemas with the cascading FKs and the `(account_id, fingerprint)` UNIQUE.
- For a fresh install, syncing a Gmail account that received the same Stripe receipt twice — say once as an HTML body in one email (no PDF attachment) and again as a PDF attachment in a separate email (e.g. a forwarded copy) — produces two `documents` rows whose `vendor`/`amount`/`currency`/`transaction_date` match. Both rows share the same fingerprint, land in the same `document_groups` row, and the `document_group_members` table has two rows for that group. (When a single message contains both a body-receipt and a receipt-shaped attachment, Slice 006's "prefer attachment, skip body" rule means only one `documents` row is created — that case is exercised by Slice 006's tests, not here.)
- The Review view's metadata pane shows "This appears to also be in 1 other email in this account" with a "Go to" button when one of the two documents is loaded; clicking the button navigates to the sibling.
- The same Stripe receipt arriving in `business@…` and `personal@…` connected accounts produces **two** `document_groups` rows (one per `account_id`), each with its own member; the Review pane on either account does **not** show the cross-account sibling.
- A monthly recurring AWS bill that produces 12 documents in 12 months — same vendor, same amount, same currency, different `transaction_date` per month — produces 12 separate `document_groups` (one per month), each with one member; no spurious grouping across months.
- A document whose `vendor` is NULL has `getGroupForDocument` return `null`; the Review pane does not render the group panel.
- Editing the vendor on a doc from `Stripe` to `Stripe Inc` (Slice 008's PATCH) recomputes the fingerprint, detaches the doc from its old group, and attaches it to the new fingerprint's group (or creates a new group). The `review_actions.action='edited'` row records the vendor change as before; no new audit row is added for the group transition.
- Reclassifying a previously-`other` message such that it produces a new `receipt` document (Slice 010) puts the new document into a group based on its newly-extracted vendor/amount/currency/date.
- Hard-dedup-blocked artifacts (Slice 006's same-content-hash skip) do not re-attach to groups (no new `documents` row → no new fingerprint computation).
- For an install upgrading from Slice 012 to Slice 013, the 0012 migration backfills fingerprints and groups for every fingerprintable existing document; pre-existing identical-fingerprint documents in the same account land in the same group post-migration.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Implementation notes

- **Amount normalization.** `Number.toFixed(2)` is the rule. Cross-currency comparison can't happen (currency is part of the fingerprint), so 2-decimal precision causing a false collision between e.g. JPY and USD is impossible. JPY-on-JPY edge cases (`1000` vs `1000.5`) are rare enough to accept.
- **Fingerprint collisions.** SHA-256 collisions are not a practical concern. The realistic risk is false matches from over-aggressive vendor lowercasing; including amount + currency + date in the fingerprint makes accidental collisions very unlikely.
- **Edit-driven re-grouping orphans.** Editing a doc out of a 2-member group leaves the other member alone in its old group; the panel hides when `members.length <= 1`, so the user just sees the panel disappear.
- **Backfill cost on first migration.** SHA-256 + INSERTs per row run sub-second for tens of thousands of documents.
- **Group display only in Review.** Inbox and Audit views don't surface group membership; per architecture, Review is the canonical surface for grouping.
- **No "canonical pick" stored.** "User picks one to keep" maps to "approve one, reject others"; no `canonical_member_id` column needed in v1.
- **Concurrent re-grouping.** Sync (single-job mutex), reclassify (per-call synchronous), and edit-PATCH each open short transactions. SQLite WAL handles the concurrency cleanly.
- **Document deletion leaves the group row.** FK CASCADE removes member rows; the parent group row is left as a harmless orphan. A vacuum query can clean orphans later if their count grows unmanageable.
- **Pure-SQL backfill complexity.** Migration 0012 carries an inline `-- BACKFILL` marker; the migration runner detects it and follows the SQL with a Node-side fingerprint pass that walks `documents` and inserts the appropriate `document_groups` and `document_group_members` rows under the existing UNIQUE constraints.
