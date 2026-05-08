# Slice 009: Tags

**Status:** draft

## Observable result

I can apply install-wide tags (starting with `business` and `personal`, plus any I create — e.g. `client:acme`, `travel`, `vat-deductible`) to any receipt from any connected account, see them as chips on every Inbox row, filter the Inbox by tag, and manage the taxonomy from a Settings → Tags screen.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` (Slice 004)
  - `documents` (Slice 006)
  - `review_actions` — with the `action='tagged'` value already permitted by the CHECK constraint (Slice 007)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
  - `0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql` (Slice 004)
  - `0005_create_documents.sql` (Slice 006)
  - `0006_create_review_actions.sql`, `0007_create_senders.sql` (Slice 007)
  - `0008_add_documents_edited_flags.sql` (Slice 008)
- **API endpoints:**
  - `GET /api/accounts/:id/documents` (Slice 006) — extended here to include tag rows per document
  - `GET /api/review/queue` (Slice 007) — extended here to include tag rows per document
  - `PATCH /api/documents/:id` (Slice 008) — unchanged; tag operations have separate endpoints
- **UI views / components:**
  - `Inbox.tsx` (Slice 006) — extended with a Tags column and tag filter
  - `Review.tsx`, `ReviewMetadata.tsx` (Slices 007 / 008) — extended with a tag picker
  - `Nav.tsx` (Slice 003) — extended with a Settings link
  - `AccountPicker.tsx` (Slice 003)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008)
  - `src/server/db/repositories/review_actions.ts` (Slice 007)
  - `src/server/api/documents.ts` (Slices 006 / 008) — extended with two tag-link routes here
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:** —
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `tags` table:
    - `id` INTEGER PRIMARY KEY AUTOINCREMENT
    - `name` TEXT NOT NULL — case-preserved for display, but uniqueness is enforced case-insensitively (see migration)
    - `color` TEXT NOT NULL — hex string `#RRGGBB`, validated by a CHECK on the format
    - `created_at` TEXT NOT NULL — ISO 8601 timestamp
    - UNIQUE INDEX `idx_tags_name_nocase` on `LOWER(name)` — `business` and `Business` collide
  - `document_tags` table:
    - `document_id` INTEGER NOT NULL REFERENCES `documents`(`id`) ON DELETE CASCADE
    - `tag_id` INTEGER NOT NULL REFERENCES `tags`(`id`) ON DELETE CASCADE
    - `applied_at` TEXT NOT NULL — ISO 8601 timestamp; `applied_by` is implicit (single user)
    - PRIMARY KEY (`document_id`, `tag_id`)
- **Migrations:**
  - `0009_create_tags.sql` — creates the `tags` table, the case-insensitive unique index, and seeds two rows: `('business', '#1d4ed8', now())` and `('personal', '#15803d', now())`. Seeded with `INSERT OR IGNORE` so re-running is a no-op (and so a user who manually edited the colors before this seed re-applies keeps their version).
  - `0010_create_document_tags.sql` — creates the junction table with both FKs cascading.
- **API endpoints:**
  - `GET /api/tags` → `{ tags: Array<{ id, name, color, created_at, document_count }> }`. `document_count` is computed via JOIN for the Settings screen's "in use by N receipts" hint.
  - `POST /api/tags` → request body `{ name: string, color?: string }` (Zod-validated; color defaults to a deterministic palette pick if omitted; name trimmed, rejects empty after trim). Returns HTTP 201 with the new row. Returns HTTP 409 if a tag with the same case-folded name already exists, with the existing row in the body so the client can use it.
  - `PATCH /api/tags/:id` → request body `{ name?: string, color?: string }`. Updates the row; same case-fold uniqueness check applies. Returns HTTP 200 with the updated row.
  - `DELETE /api/tags/:id` → returns HTTP 200 with `{ id, removed_links: number }`. The CASCADE on `document_tags` automatically removes the links; the count is reported back so the Settings screen can confirm "removed from N receipts" and the user is not surprised.
  - `POST /api/documents/:id/tags` → request body `{ tag_id: number }`. Inserts a `document_tags` row (no-op + HTTP 200 if the link already exists), updates `documents.updated_at`, appends a `review_actions` row with `action='tagged'` and `details = JSON.stringify({ verb: 'added', tag_id, tag_name })`. Returns the updated tag list for that document. The tag's `name` is captured in `details` so the action remains legible after a tag rename or delete.
  - `DELETE /api/documents/:id/tags/:tag_id` → mirrors POST: deletes the link (no-op + HTTP 200 if no link existed), updates `documents.updated_at`, appends a `review_actions` row with `details.verb='removed'`. Returns the updated tag list.
  - The existing `GET /api/accounts/:id/documents` (Slice 006) and `GET /api/review/queue` (Slice 007) row shapes are extended to include `tags: Array<{ id, name, color }>` per row. Implementation: a single `GROUP_CONCAT` JOIN per query, parsed server-side into the array shape. (Slice 008's `*_edited` flags addition was the first additive shape change; this is the second.)
- **UI views / components:**
  - `Settings.tsx` — at route `/settings`. Top-level shell with a left-rail of sections; for now the only populated section is "Tags". Other sections (Accounts, Ollama, Senders, Fiscal year) are forward-declared as disabled menu items pointing at the slices that will fill them (007, 005, 015, 011 respectively). The shell is the surface future Settings-touching slices will plug into.
  - `TagManager.tsx` — the Settings → Tags section. Lists all tags with `{ name, color swatch, document_count, edit, delete }`. Edit opens a small inline form (rename + color picker). Delete confirms ("Removing the `client:acme` tag will unlink it from N receipts. The receipts themselves are not deleted.").
  - `TagPicker.tsx` — typeahead combobox used by the Review view. Shows applied tags as removable chips on top, an input below; typing filters existing tags; pressing Enter on an unrecognized name offers a "Create `<name>`" affordance that calls `POST /api/tags` then `POST /api/documents/:id/tags`. Bound into `ReviewMetadata.tsx` below the editable fields.
  - `TagChip.tsx` — reusable rendered tag (color dot + name). Used by the picker, the Inbox list, and the Audit view (Slice 010 will reuse).
  - `TagFilter.tsx` — dropdown next to the Inbox's account picker, lets the user pick one tag (multi-select is polish; see Out of scope). Selecting a tag narrows `GET /api/accounts/:id/documents?tag_id=…`.
  - `ReviewMetadata.tsx` (modified) — gains the `<TagPicker />` block.
  - `Inbox.tsx` (modified) — adds a Tags column rendering each row's chips, plus the `<TagFilter />` in the toolbar; passes `tag_id` through to `GET /api/accounts/:id/documents`.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/db/migrations/0009_create_tags.sql`
  - `src/server/db/migrations/0010_create_document_tags.sql`
  - `src/server/db/repositories/tags.ts` — `list({ withCounts })`, `findById`, `findByNameCaseFold`, `insert({ name, color })`, `update({ id, patch })`, `delete(id)`. The `delete` returns the number of `document_tags` rows that were cascaded out (read with `changes()` after the cascade, or pre-counted before the delete). All methods are install-wide (no `account_id` — tags are shared per architecture).
  - `src/server/db/repositories/document_tags.ts` — `add({ document_id, tag_id })`, `remove({ document_id, tag_id })`, `listForDocument(document_id)`, `listForDocumentBatch(document_ids)` (the bulk method is what powers the queue/document-list endpoints' tag JOIN).
  - `src/server/api/tags.ts` — registers `GET /api/tags`, `POST /api/tags`, `PATCH /api/tags/:id`, `DELETE /api/tags/:id`.
  - `src/server/api/documents.ts` — modified to register `POST /api/documents/:id/tags`, `DELETE /api/documents/:id/tags/:tag_id`, and to extend the document-list and review-queue selectors with the tag JOIN.
  - `src/client/views/Settings.tsx`, `src/client/components/TagManager.tsx`, `src/client/components/TagPicker.tsx`, `src/client/components/TagChip.tsx`, `src/client/components/TagFilter.tsx`
  - `src/client/views/Review.tsx`, `src/client/components/ReviewMetadata.tsx` — modified to host the tag picker
  - `src/client/views/Inbox.tsx` — modified to host the Tags column and the `TagFilter`
  - `src/client/router.tsx` — modified to register `/settings` → `Settings`
  - `src/client/components/Nav.tsx` — modified to add a "Settings" link
  - `src/client/lib/tag-palette.ts` — small constant array of preset hex colors used as defaults when the user creates a tag without picking a color
- **External services:** —
- **Other:**
  - First slice that writes `review_actions` rows with `action='tagged'`. Slice 007's CHECK constraint already permits the value; this slice does not need a new migration to start using it.
  - First Settings surface; future Settings sections plug into the same `Settings.tsx` shell.

## Out of scope

- Multi-select tag filter on the Inbox (AND/OR semantics, multi-chip input) → Slice 016 polish; v1 ships single-select
- Tag-aware classifier (the model getting hints like "this account usually receives client:acme receipts on Mondays") → not planned for v1
- Tag-based export filters → covered by Slice 011 (which lists tag filters as one of its deliverables)
- Cross-account audit view's tag column → Slice 010 (reuses `TagChip` here)
- Sender allowlist/blocklist driven by tag patterns → Slice 015
- Tagging from the Inbox view (right-click or quick-action) → Slice 016 polish; tagging happens in the Review view in this slice
- Bulk tag operations (select N rows, apply tag to all) → not planned for v1
- Importing/exporting the tag taxonomy → not planned for v1; the install-wide DB is the artifact
- Tag colors UI: pre-defined palette swatches; freeform color picker (e.g. native `<input type="color">`) deferred to polish

## Detailed design

This slice realizes `architecture.md` § "Storage" (the `tags` and `document_tags` tables), § "Components — Frontend — Review" ("tag picker"), § "Components — Frontend — Inbox" ("Tag column visible in Inbox list"), and § "Components — Frontend — Settings" (the Tags section). Tags are explicitly install-wide per architecture — no `account_id` column on `tags` — so the same taxonomy applies regardless of which connected account a receipt came from.

- **Tag creation flow.** The Review view's TagPicker collapses "create + apply" into one user gesture: typing a non-matching name and pressing Enter calls `POST /api/tags` then `POST /api/documents/:id/tags`. The two requests are sequential (the second needs the first's `id`); failure of the first surfaces inline. This matches the architecture's note about "quick 'create new tag' for first-time use".
- **Pre-populated tags.** `business` (`#1d4ed8`, blue) and `personal` (`#15803d`, green) are seeded by the migration. Colors picked for accessibility (high contrast against white). The user can edit or delete them; deleting `business` is unusual but not forbidden.
- **Case-insensitive uniqueness.** `LOWER(name)`-indexed unique constraint. `business`, `Business`, and `BUSINESS` all collide. The user's exact casing is preserved for display in `tags.name`. This avoids the common bookkeeping foot-gun where two tags differ only in case and the user has to remember which they applied.
- **Color validation.** CHECK constraint `color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'` enforces the `#RRGGBB` format at the SQLite layer. The TagManager's edit form uses a small palette of preset swatches plus a freeform hex input.
- **Document-tag link.** Idempotent on `(document_id, tag_id)` — re-applying the same tag is a no-op (HTTP 200, no second `review_actions` row). Removing a non-existent link is also a no-op (no error, no `review_actions` row). This makes the picker UI simple: it can fire add/remove per chip click without first checking server state.
- **`review_actions` capture.** Each tag link change appends one `review_actions` row with `details = { verb, tag_id, tag_name }`. Capturing `tag_name` at the time of the action means the audit log stays legible even after a tag rename or delete. This mirrors Slice 008's `from`/`to` capture for field edits.
- **Cascade on tag delete.** SQLite's `ON DELETE CASCADE` removes all `document_tags` rows for the deleted tag. The audit trail in `review_actions` is **not** cascaded — the historical "tagged with X" rows remain, with `details.tag_name` preserving the name for human readability. This is the right behavior for a bookkeeping tool: no surprise data loss, history is preserved, and an exported manifest column for tags (Slice 011) can still resolve historic state if needed.
- **Tag JOIN performance.** The Inbox listing and review queue add a `LEFT JOIN document_tags … LEFT JOIN tags …` with `GROUP_CONCAT(tags.id || ':' || tags.name || ':' || tags.color, '\x1f')` (using ASCII unit-separator to avoid collisions with name characters). Server-side this is parsed into the per-row `tags` array. For a few thousand documents this is fast enough; if it ever isn't, a separate `listForDocumentBatch` round-trip is the fallback.
- **Settings shell.** `Settings.tsx` is the canonical home for install-wide configuration UIs that don't fit on a primary view. Slice 015 will fill the Senders section; Slice 011 will fill the Fiscal-year section; Slice 016 may add Accounts (currently lives on Dashboard) and Ollama. Forward-declaring the empty sections with disabled menu items makes the future surface obvious without committing to layout decisions now.
- **Inbox filter UX.** A single dropdown next to the account picker, "All tags" by default. Picking a tag narrows the listing. Multi-select with chip input is the next ergonomic step but requires a different component model; deferred. The filter state is reflected in the URL (`/inbox?tag_id=N`) so reloading or sharing a link preserves the view.

## Acceptance criteria

- After Slice 009 migrations apply, `SELECT name, color FROM tags` returns at least two rows: `business` (`#1d4ed8`) and `personal` (`#15803d`). Re-running the migration on an already-seeded DB inserts no duplicates.
- Trying to create a second tag named `Business` returns HTTP 409 with the existing `business` row in the body.
- Creating a tag named `client:acme` via Settings → Tags works; the new tag appears in the Settings list with `document_count=0`.
- In the Review view, the metadata pane shows a TagPicker. Typing `client` shows `client:acme` in the dropdown; selecting it adds the tag to the current document. The chip appears immediately (optimistic UI); reloading the page persists it. `document_tags` has a new row for `(document_id, tag_id)`. `review_actions` has a new row with `action='tagged'`, `details = {"verb":"added","tag_id":N,"tag_name":"client:acme"}`. `documents.updated_at` is bumped.
- Removing the chip writes a `review_actions` row with `details.verb='removed'` and removes the `document_tags` row.
- Approving a tagged document via `a` (Slice 007 keyboard shortcut) still works; tags stay on the document after approval.
- The Inbox view shows a "Tags" column with chips per row reflecting `document_tags`. The chip color matches `tags.color`.
- The Inbox view's `TagFilter` dropdown lists all tags. Picking `business` narrows the list to documents with that tag applied; picking "All tags" restores the full listing. The URL reflects `?tag_id=N`.
- Deleting a tag from Settings → Tags confirms the cascade ("removed from 7 receipts"), then removes it. The Inbox column and the chips on remaining documents update accordingly. Old `review_actions` rows still reference the deleted tag's name in their `details.tag_name`.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Risks / open questions

- **Single-select tag filter.** Multi-tag filtering (e.g. "show all `business` AND `travel` receipts") is plausible bookkeeping. Provisional choice: ship single-select v1 to keep the picker simple. Multi-select is a small follow-up if the user asks. Flag.
- **Tag color palette only.** No freeform color picker in v1 (just a 12-swatch palette + freeform hex input in the edit form). Native `<input type="color">` would be cheap to add later. Flag.
- **Tag rename and review actions.** Renaming a tag updates `tags.name` but `review_actions.details.tag_name` keeps the old name in old rows. This is the intended behavior (audit log captures state at the time of the action), but it's worth documenting in the README's audit chapter. Flag for the docs slice.
- **Deletion cost surfacing.** The DELETE handler does a pre-count to report `removed_links`, then runs the DELETE. The cascade is enforced by SQLite. A single transaction protects against concurrent links being added between the count and the delete. Flag if the pre-count drifts (single-user, low likelihood).
- **Tag chip rendering across views.** `TagChip` is reused in three places (Review picker, Inbox column, future Audit view). Styling drift is the usual risk; component-level tests (when the project adds them) would cover this.
- **`GROUP_CONCAT` parsing.** Using ASCII unit-separator (`\x1f`) inside `GROUP_CONCAT` is robust against tag names containing `,`/`;`. If a future migration changes how names are stored (e.g. allowing hex bytes), the separator may need to change. Provisional choice: fine for v1.
- **No tag-color uniqueness.** Two tags can share a color. Probably fine (the name disambiguates) but worth flagging.
- **Settings shell forward-declaring sections.** The disabled menu items for Slices 005/007/011/015 are a UX nicety but introduce a small coupling: those slices must update the Settings shell to enable their sections. Acceptable; they all touch the file anyway.
