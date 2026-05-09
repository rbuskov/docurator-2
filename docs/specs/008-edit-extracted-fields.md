# Slice 008: Edit extracted fields

**Status:** ready

## Observable result

When the classifier extracts the wrong vendor, amount, currency, or transaction date for a receipt, I can fix the value inline in the Review view's metadata pane — focus the field, type the correction, blur — and the new value persists, the field is marked as user-edited, and an entry is appended to `review_actions`, all without leaving the screen or losing my place in the queue.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` (Slice 004)
  - `documents` — including `vendor`, `amount`, `currency`, `transaction_date`, `review_status`, `updated_at` (Slice 006)
  - `review_actions` — with the `action='edited'` value already permitted by the CHECK constraint (Slice 007)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
  - `0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql` (Slice 004)
  - `0005_create_documents.sql` (Slice 006)
  - `0006_create_review_actions.sql`, `0007_create_senders.sql` (Slice 007)
- **API endpoints:**
  - `GET /api/review/queue` (Slice 007) — its `ReviewQueueRow` shape gains the new `*_edited` fields automatically once the columns exist; consumer change is local to the queue's query
  - `GET /api/documents/:id/file` (Slice 006)
- **UI views / components:**
  - `Review.tsx` at `/review` (Slice 007) — extended here
  - `ReviewMetadata.tsx` (Slice 007) — its read-only labels are replaced with editable fields here (modification, not re-deliver)
  - `ReviewActions.tsx`, `useReviewKeyboard.ts` (Slice 007)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` (Slices 002 / 004)
  - `src/server/db/repositories/documents.ts` (Slice 006)
  - `src/server/db/repositories/review_actions.ts` (Slice 007)
  - `src/server/api/documents.ts` (Slice 006) — extended here with a PATCH route
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:** —
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `documents.vendor_edited` INTEGER NOT NULL DEFAULT 0 — `0` / `1` boolean (SQLite has no native boolean; the column is treated as a flag)
  - `documents.amount_edited` INTEGER NOT NULL DEFAULT 0
  - `documents.date_edited` INTEGER NOT NULL DEFAULT 0 — covers edits to `transaction_date`. Currency edits do not get a parallel `currency_edited` flag per `architecture.md` § "Storage" (which lists exactly these three flags); see Implementation notes.
- **Migrations:**
  - `0008_add_documents_edited_flags.sql` — three `ALTER TABLE documents ADD COLUMN … INTEGER NOT NULL DEFAULT 0` statements
- **API endpoints:**
  - `PATCH /api/documents/:id` → request body Zod-validated as `{ vendor?: string | null, amount?: number | null, currency?: string | null, transaction_date?: string | null }` — each field optional, allowing only one or several at once, and explicit `null` is allowed (clearing a value the model extracted is a valid edit). Server behavior, in one SQLite transaction:
    1. Load the current row by `id` (HTTP 404 if missing)
    2. For each field present in the request whose new value differs from the current row, set the column to the new value, set the matching `*_edited` flag to `1` (where applicable: `vendor`, `amount`, `transaction_date`; `currency` updates the column with no flag), and append one `review_actions` row per changed field with `action='edited'` and `details = JSON.stringify({ field, from, to })`
    3. Update `documents.updated_at` to the current ISO timestamp once if at least one field changed
    4. Return HTTP 200 with the full updated `DocumentRow` so the client can replace its optimistic state
  - The endpoint **does not** change `review_status`. Editing fields and approving the document remain separate user actions; `review_actions` history simply gains an `edited` row in between.
- **UI views / components:**
  - `EditableField.tsx` — generic inline editor. Props: `value`, `onSave(newValue)`, `parse(string) => value`, `format(value) => string`, `placeholder`, `kind: 'text' | 'number' | 'currency' | 'date'`. Renders a styled text/number/date input that:
    - Looks like a label when not focused (italic "—" when null)
    - Becomes an editable input on click or focus
    - Saves on blur and on Enter (Escape reverts to the last saved value)
    - Shows an in-flight spinner while the PATCH is pending (optimistic UI keeps the new value visible)
    - On error, reverts to the previous value and shows an inline error chip with a "Retry" affordance
    - Renders a small "edited" indicator (e.g. a dot or pencil icon) when the corresponding `*_edited` flag is `1`
  - `ReviewMetadata.tsx` (modified) — the four read-only labels for `vendor`, `amount`, `currency`, `transaction_date` are replaced by `<EditableField>` instances:
    - `vendor` — `kind='text'`
    - `amount` — `kind='number'`, parses `1,234.56` and `1234.56` and `1.234,56` (locale-tolerant) but stores as a plain JS number; rejects non-numeric input and reverts on Escape
    - `currency` — `kind='currency'`, 3-letter input, auto-uppercases, validates against an ISO 4217 allowlist of common codes (USD, EUR, GBP, DKK, SEK, NOK, etc.; full list of ~60 codes). Unrecognized codes still save (advisory only) but show a hint
    - `transaction_date` — `kind='date'`, native `<input type="date">`
  - The classification metadata block (model, confidence, reason, sender, subject, account labels) remains read-only.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/db/migrations/0008_add_documents_edited_flags.sql`
  - `src/server/db/repositories/documents.ts` — modified to add `update({ id, patch }): UpdatedRow` that runs the load/diff/update/insert-actions transaction. Returns the updated row plus a list of `{ field, from, to }` entries describing what changed (the API handler uses this to write the `review_actions` rows in the same transaction).
  - `src/server/api/documents.ts` — modified to register `PATCH /api/documents/:id` and to JOIN the new `*_edited` columns into the row shape returned by the existing `GET /api/accounts/:id/documents` and `GET /api/review/queue` endpoints. (Slice 007's `GET /api/review/queue` selector is updated locally to add the three flag columns.)
  - `src/client/components/EditableField.tsx`
  - `src/client/components/ReviewMetadata.tsx` (modified to host the editable fields)
  - `src/client/lib/currencies.ts` — small constant array of common ISO 4217 codes used by the currency field's allowlist hint
- **External services:** —
- **Other:**
  - First slice that writes `review_actions` rows with `action='edited'` and a populated `details` JSON. Slice 007's CHECK constraint already permits `'edited'`; this slice does not need a new migration to start using it.
  - First slice with optimistic UI for a write path. Pattern: keep the new value visible immediately, revert on PATCH failure with an error chip and a Retry affordance.

## Out of scope

- A `notes` column on `documents` and a notes textarea in the metadata pane → Slice 016 (ships the column, the textarea, and the manifest population)
- A separate `currency_edited` flag → architecture sketch lists three flags; this slice ships those three; see Implementation notes
- Tags picker / `tags` / `document_tags` tables → Slice 009
- Surfacing the per-document edit history (the chain of `review_actions` rows) in the UI → Slice 016 polish; this slice writes the rows, doesn't display them
- Bulk edit (multi-select + apply same vendor) → not planned for v1
- Server-side validation of currency against ISO 4217 → client-side hint only; server stores whatever string fits the column
- Editing fields from the Inbox view → Slice 016 polish; for now editing happens only in the Review view (the queue surface that already shows the metadata pane)

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Review" ("editable extracted fields") and § "Key flows — Review" step 4 ("Edit fields inline — corrected values are saved immediately, with `*_edited` flags set"). It plugs into Slice 007's review surface without restructuring it: the metadata pane changes from labels to editable fields, the keyboard hook from Slice 007 (which already bails out on input focus) stays unchanged, and approve/reject continues to work with whatever values are currently saved on the document.

- **Per-field PATCH semantics.** The PATCH endpoint accepts any subset of the four fields and only writes the ones that actually changed. This keeps `review_actions` history precise (one row per real change, not one per field touched) and avoids spurious `*_edited=1` flips when a user focuses-and-blurs without changing anything.
- **Optimistic UI rules.** When the user blurs a changed field, the client sends the PATCH, keeps the new value rendered, and displays a small spinner inside the field. On success, the spinner clears and the `*_edited` indicator turns on (or stays on). On failure, the field reverts to the value the server last confirmed, and an inline error chip near the field offers Retry. The chip is dismissible; dismissing it leaves the field on the original value.
- **Type-aware editors.** Each field has a parsing/formatting pair. `amount` accepts either decimal form (`,` or `.` as decimal separator) and rejects letters; the parsed value is sent as a JSON number, never a string, so the column type matches. `transaction_date` uses the native `<input type="date">` for a calendar picker; the value is the browser's `YYYY-MM-DD` string, which matches the column's storage format. `currency` is 3-letter, auto-uppercased on save; an unknown code still saves (free-text per architecture) but shows a small "uncommon code" hint inline. `vendor` is plain text.
- **Edited indicator logic.** Once `vendor_edited=1`, the indicator stays on even if the user later restores the original value. The flag means "this column was touched by the user," not "this column currently differs from what the model produced." This matches the architecture's stated purpose: measuring how often the model is wrong, regardless of whether the user later reverted.
- **Currency without a flag.** The architecture's three-flag design omits `currency_edited`. Practical consequence: the system can't tell from the columns alone whether a user changed the currency. The data is still in `review_actions` (every edit including currency changes writes a row there with `details.field='currency'`), so analytics that need to count currency edits join on `review_actions` instead of relying on a flag column. This is a known asymmetry in the architecture; this slice does not deviate from it.
- **`review_actions.details` shape.** For `action='edited'`, `details` is JSON `{ "field": "vendor"|"amount"|"currency"|"transaction_date", "from": <prior value>, "to": <new value> }`. Numeric values stay as numbers in the JSON; nulls stay as JSON `null`. This shape is consumed (read-only) by future analytics or audit surfaces; the present slice only writes.
- **Transaction.** Loading the current row, computing the diff, running `UPDATE documents SET …`, and inserting one `review_actions` row per changed field all happen inside a single `db.transaction(() => { … })` block via `better-sqlite3`. If any step throws, nothing is written.
- **Keyboard shortcut interplay.** Slice 007's `useReviewKeyboard` already ignores key events when an input is focused. `EditableField` uses native `<input>` elements, so `a`/`r`/`j`/`k` correctly disengage during edits and re-engage on blur. The `Escape` key inside an editable field reverts and blurs (so the next key press re-engages the review shortcuts immediately).
- **Concurrency.** Single-user, single-tab is the baseline. Two-tab races against the same document field can cause stale-value writes, but the `review_actions` log preserves both edits and the `updated_at` timestamp records which one landed last. No optimistic-locking column (`if-match`/`version`) in this slice.

## Acceptance criteria

- After Slice 008, `sqlite3 data/app.db ".schema documents"` shows the three new columns `vendor_edited`, `amount_edited`, `date_edited` with `NOT NULL DEFAULT 0`. Documents created before this slice ran (from Slice 006 sync) all have `0` in those columns.
- In the Review view, clicking on the vendor label turns it into an input, typing a correction, and pressing Tab (or clicking elsewhere) saves the new value. Reloading the page shows the new value persisted. `documents.vendor` matches the new value, `documents.vendor_edited = 1`, and `review_actions` has a new row with `action='edited'` and `details = '{"field":"vendor","from":"…","to":"…"}'`.
- Editing `amount` to `42.50` saves it as the JSON number `42.5` (or `42.50` — both serialize to the same DB value); reloading shows `42.50` rendered (with two decimal places of formatting). `amount_edited = 1`, and `review_actions` has a new row with `details.field = "amount"`.
- Editing `currency` from `USD` to `eur` saves as `EUR` (auto-uppercased). The column updates, no `currency_edited` flag is added (per architecture), but a `review_actions` row exists with `details.field = "currency"`.
- Editing `transaction_date` via the date picker saves a `YYYY-MM-DD` string. `date_edited = 1` and a `review_actions` row exists with `details.field = "transaction_date"`.
- Focusing then blurring a field with no change writes nothing — `documents.updated_at` is unchanged, no new `review_actions` row is created, and the relevant `*_edited` flag stays at its prior value.
- Submitting an invalid amount (e.g. typing `abc`) does not save: the field reverts on blur, no PATCH is sent, and no DB rows change.
- Approving an edited document via `a` (Slice 007 shortcut) still works; the keyboard shortcut does not fire while a field is focused.
- The Slice 007 queue ordering (confidence ASC) is unaffected by edits — editing a doc doesn't move it; the next pending document is still the next-lowest-confidence one.
- A PATCH that hits a server error (e.g. a malformed request) shows the error chip on the field and reverts the optimistic value; the corresponding DB row remains unchanged.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Implementation notes

- **`notes` column deferred to Slice 016.** The `notes` column on `documents` and the textarea in `ReviewMetadata` ship in Slice 016 alongside the export-manifest population.
- **Asymmetric `*_edited` flags (no `currency_edited`).** Follows the architecture sketch's three-flag design. Downstream consumers that want "was currency user-edited?" must JOIN `review_actions` filtered to `details.field='currency'`.
- **Currency allowlist.** Hard-coded list of ~60 ISO 4217 codes drives the UX hint only. Codes outside the list still save (e.g. `XPF` for CFP francs).
- **Optimistic concurrency.** No `If-Match`/version column. Concurrent edits from two tabs race; the second write wins on the column, both edits appear in `review_actions`. Acceptable for a single-user tool.
- **Number formatting and decimal separators.** The parser tries `1,234.56` and `1.234,56` forms. Unusual formats (e.g. `1 234,56` with non-breaking space) are rejected rather than guessed.
- **Undo for edits.** No UI undo path; data is recoverable via `review_actions` JSON. A future polish slice can add a per-field "revert to model value" button.
- **`ReviewQueueRow` shape change.** Slice 007's response shape gains three new flag fields here. The change is additive; consumers ignore unknown fields.
