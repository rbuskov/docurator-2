# Slice 011: Export

**Status:** ready

## Observable result

I can pick one, several, or all of my connected accounts, choose a month-based period (a month, month range, quarter, or fiscal year — with one-click presets), filter to approved receipts plus optional tags, see a live preview of how many documents and what currency totals will be in the export, then click Download and receive a streamed zip file with a per-account folder structure plus a CSV manifest, a Markdown manifest, and a `summary.txt`.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` — including `email`, `display_name`, `slug` (Slice 002)
  - `processed_messages` — including `internal_date`, `sender_domain`, `subject`, `classification`, `confidence`, `model_used` (Slice 004)
  - `documents` — including `account_id`, `message_id`, `kind`, `filename`, `mime_type`, `size`, `file_path`, `vendor`, `amount`, `currency`, `transaction_date`, `review_status`, `created_at`, plus the `*_edited` flags (Slices 006 / 008)
  - `tags`, `document_tags` (Slice 009)
  - `app_config` — including `fiscal_year_start_month` (Slice 004) — read here to interpret the "FYxxxx" preset
- **Migrations:**
  - `0001`–`0010` (Slices 002–009)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/tags` (Slice 009)
- **UI views / components:**
  - `Settings.tsx` (Slice 009) — extended here with a "Fiscal year" section
  - `Nav.tsx` (Slice 003) — extended here with an "Export" link
  - `AccountPicker.tsx` (Slice 003), `TagChip.tsx` (Slice 009)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts` (Slices 002 / 004)
  - `src/server/db/repositories/documents.ts` (Slices 006 / 008 / 009)
  - `src/server/db/repositories/processed_messages.ts` (Slice 004)
  - `src/server/db/repositories/app_config.ts` (Slice 004)
  - `src/server/db/repositories/accounts.ts` (Slice 002)
  - `src/server/db/repositories/tags.ts`, `document_tags.ts` (Slice 009)
  - `src/server/files.ts` (Slice 006) — used here only to resolve absolute paths for streaming files into the zip
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
- **External services:**
  - Bind-mounted `./invoices` directory (Slice 006) — the source of the file bytes packaged into the zip
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:**
  - `GET /api/export/preview` → query params Zod-validated as `{ account_ids: number[] (≥1), period: { kind: 'month'|'month_range'|'quarter'|'fiscal_year', start: string (YYYY-MM), end: string (YYYY-MM) }, tag_ids?: number[], review_statuses?: Array<'approved'|'pending'|'rejected'> (default: ['approved']) }`. Returns `{ document_count: number, currency_breakdown: Array<{ currency: string|null, count: number, total_amount: number|null }>, account_breakdown: Array<{ account_id, account_email, account_slug, document_count, currency_breakdown }>, period_label: string }`. The `period_label` is a short human string (e.g. `"May 2026"`, `"Q2 2026"`, `"FY2026 (Jan–Dec 2026)"`). Used by the live preview pane.
  - `GET /api/export/download` → same query params as preview, but the response is a streaming zip (`Content-Type: application/zip`, `Content-Disposition: attachment; filename="docurator-export-<period_slug>.zip"`). Body is produced incrementally via `archiver`.
  - `GET /api/app-config` → `{ fiscal_year_start_month: number }`. Read from the single-row `app_config` table.
  - `PATCH /api/app-config` → request body `{ fiscal_year_start_month?: number (1-12) }`. Updates the row, returns the new state.
- **UI views / components:**
  - `Export.tsx` — at route `/export`. Top-to-bottom layout: (1) Account selector (multi-select; default is the most recently used account from `localStorage['docurator.lastExportAccountIds']`, plus "Select all"); (2) Period picker with preset row + custom range; (3) Tag filter (multi-select, OR semantics, "(any tag)" default); (4) Review-status filter (checkbox row, default `approved` only); (5) Live preview pane sourced from `GET /api/export/preview`; (6) "Download zip" button which navigates the browser to `GET /api/export/download` so the standard download flow handles the stream.
  - `PeriodPicker.tsx` — preset row (`Last month`, `This quarter`, `Last quarter`, `FY{currentFY}`, `FY{currentFY-1}`) plus a custom range with two month inputs (`<input type="month">`) and a quarter dropdown. Computed against the install's `fiscal_year_start_month` for the FY presets.
  - `PeriodPresets.tsx` — small constant + helper `presetToPeriod({ preset, today, fiscal_year_start_month })` that maps `'last_month'` etc. to a concrete `{ kind, start, end }`. Pure function, easy to test.
  - `AccountMultiSelect.tsx` — multi-select dropdown with chip display; reuses styling from `TagChip`. The `AccountPicker` from Slice 003 stays single-select for uses elsewhere; this one is parallel.
  - `TagMultiSelect.tsx` — multi-select tag picker. Replaces Slice 009's single-select `TagFilter` in the export context. Slice 009's TagFilter on the Inbox view is unchanged. Future cleanup may consolidate.
  - `ExportPreview.tsx` — renders the `GET /api/export/preview` payload. Top line: "X documents, totaling Y in {currencies} across N accounts". When more than one account is selected, expands to a per-account table. Updates on every filter change with a 200ms debounce.
  - `FiscalYearSettings.tsx` — Settings → Fiscal year section. Single dropdown ("January (calendar year)" through "December") that calls `PATCH /api/app-config`. Inline help text: "Affects how the export's `FYxxxx` preset and `summary.txt` interpret fiscal periods. Common choices: January (US/UK calendar), April (UK personal), July (Australia), October (US federal)."
  - `Settings.tsx` (modified) — fills in the previously-disabled "Fiscal year" section.
  - `Nav.tsx` (modified) — adds an "Export" link.
  - `src/client/router.tsx` (modified) — registers `/export` → `Export`.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `EXPORT_DOWNLOAD_TIMEOUT_MS` (default `300000`) — server-side timeout for the streaming zip endpoint. Receipt archives with thousands of files can take a couple minutes to stream on slow disks.
  - `docker-compose.yml` updated to pass through `EXPORT_DOWNLOAD_TIMEOUT_MS`.
- **Files / modules:**
  - `src/server/export/select.ts` — `selectDocumentsForExport({ account_ids, period, tag_ids, review_statuses })` returning the row set used by both preview and download. Builds the SQL query against `documents` + JOINs `processed_messages`, `accounts`, `document_tags`, `tags`. Period filtering uses `COALESCE(transaction_date, DATE(internal_date / 1000, 'unixepoch'))` so a missing or unparseable `transaction_date` falls back to the email's `internal_date` (architecture's "transaction_date is the basis; internal_date is the fallback").
  - `src/server/export/manifest.ts` — `buildManifest(rows): ManifestRow[]`. **Single source of truth** for the row shape consumed by both CSV and Markdown serializers. `ManifestRow` columns: `filename` (relative path within zip, see folder layout below), `account_email`, `account_label` (=`accounts.display_name` falling back to `accounts.email`), `source_email_date` (RFC 3339 from `internal_date`), `source_email_sender` (`sender_domain`), `source_email_subject`, `classification`, `confidence`, `model_used`, `vendor`, `amount`, `currency`, `transaction_date`, `tags` (semicolon-joined names, sorted), `notes` (always empty string in this slice — see Risks), `gmail_message_id`. Includes a small comment in the source explaining that field order matters because both serializers iterate `Object.keys(row)` in the same order.
  - `src/server/export/csv.ts` — RFC 4180 CSV writer with double-quote escaping. Emits header row from `Object.keys(rows[0])` (fixed by `manifest.ts`), then one row per file.
  - `src/server/export/markdown.ts` — emits a Markdown table with the same columns. Pads cells minimally (no column-width alignment beyond what Markdown requires).
  - `src/server/export/summary.ts` — `buildSummaryText({ rows, period_label, account_breakdown, transaction_date_basis_count, internal_date_basis_count })`. Plain text: header naming the period, total document count, currency breakdown, tag breakdown, per-account totals when more than one account, and an explicit "Period basis: N rows by transaction_date, M rows by internal_date fallback" line so the user knows which dating was used.
  - `src/server/export/zip.ts` — `streamExport({ res, params })` orchestrator. Opens an `archiver('zip', { store: false })`, pipes to the response stream. For each row from `select.ts`: appends the file from disk via the absolute path resolved by `files.ts` (path-traversal-guarded by the existing Slice 006 helper). After all files, appends `manifest.csv`, `manifest.md`, `summary.txt` at the zip root.
  - `src/server/api/export.ts` — registers `GET /api/export/preview` and `GET /api/export/download`. Both use the same `selectDocumentsForExport` to ensure preview totals match the actual zip.
  - `src/server/api/app_config.ts` — registers `GET /api/app-config` and `PATCH /api/app-config`.
  - `src/client/views/Export.tsx`, `src/client/components/PeriodPicker.tsx`, `src/client/components/PeriodPresets.tsx`, `src/client/components/AccountMultiSelect.tsx`, `src/client/components/TagMultiSelect.tsx`, `src/client/components/ExportPreview.tsx`, `src/client/components/FiscalYearSettings.tsx`
  - `src/client/views/Settings.tsx` (modified) — the previously-disabled Fiscal-year section now mounts `FiscalYearSettings`. Other disabled sections (Senders, Accounts, Ollama) remain disabled.
  - `src/client/router.tsx` (modified)
  - `src/client/components/Nav.tsx` (modified)
  - `package.json` updates: adds `archiver` to runtime deps.
- **External services:** —
- **Other:**
  - **Folder layout inside the zip:** `{account_slug}/{yyyy}/{mm}/{filename}`, mirroring the on-disk layout from Slice 006. Used even for single-account exports so the manifest's `filename` column is uniform across uses. Filenames are cleaned for cross-platform compatibility (no `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, `..`; truncated to a safe length while preserving extension); when two documents within the same `(account_slug, yyyy, mm)` would collide, a numeric suffix `_2`, `_3`, … is appended. The Slice 006 file store already produces collision-safe paths via the `{message_id}_{seq}_…` prefix; the export inherits those names by default and only re-cleans them.
  - **Manifest schema is a stable contract.** Both serializers write the same column set in the same order, sourced from `manifest.ts`. A new column requires editing `manifest.ts`, both serializers, and `summary.txt`'s breakdown logic — keeping the schema authoritative in one file.
  - **Streaming end-to-end.** `archiver` writes incrementally and the Hono response is set up as a streaming response, so the server's memory footprint stays bounded regardless of archive size. No "build the whole zip in memory then send" anywhere.

## Out of scope

- Failed-classification handling and retry → Slice 012
- Document grouping in the export (showing multi-member groups, surfacing the canonical artifact) → Slice 013 (the export here just packages the rows that match the filters, ignoring group membership)
- Reclassification → Slice 014
- Sender-memory-aware filters in the Export view → Slice 015 (export does not surface sender-memory yet)
- README "Backup recommendations", screenshots, setup walkthrough → Slice 016
- Direct upload to accounting software (Xero, QuickBooks, etc.) → not planned for v1
- Multiple zip formats (.tar.gz, .7z) → not planned
- Password-protected zips → not planned
- Cover-page PDF or pre-rendered PDF cover sheet → not planned
- Saved export presets / scheduled exports → not planned for v1
- Editing the `notes` field anywhere → still deferred to Slice 016 polish; see Risks
- Cumulative-balance / running-total columns → not planned

## Detailed design

This slice realizes `architecture.md` § "Components — Frontend — Export", § "Key flows — Export", and the install-wide `app_config` UI surface (the fiscal-year setting). The export is the deliverable that flows into the user's accounting workflow, so the design prioritizes accountant-readability (CSV + Markdown + summary), traceability (`gmail_message_id` per row), and re-runnability (whole-month boundaries make exports reproducible).

- **Period model.** Periods are always whole-month. The `kind` discriminator tells the server how to interpret `start` and `end`:
  - `kind='month'` — `start === end` and equals the chosen month, e.g. `{ start: '2026-05', end: '2026-05' }`.
  - `kind='month_range'` — arbitrary contiguous range, e.g. `{ start: '2026-01', end: '2026-06' }`.
  - `kind='quarter'` — calendar quarter, normalized to `start = first month of the quarter`, `end = last month of the quarter`. The `kind` exists so the UI label can say "Q2 2026" rather than "April–June 2026" (still the same SQL).
  - `kind='fiscal_year'` — fiscal year per `app_config.fiscal_year_start_month`. For `start_month=1`, "FY2026" maps to `{ start: '2026-01', end: '2026-12' }`. For `start_month=7`, "FY2026" maps to `{ start: '2025-07', end: '2026-06' }`, matching `architecture.md`'s example.
  - The server validates that `start ≤ end` and that both are well-formed `YYYY-MM`.
- **Document selection SQL.** Pseudocode:
  ```
  SELECT ... FROM documents d
  JOIN accounts a ON a.id = d.account_id
  LEFT JOIN processed_messages pm ON pm.account_id = d.account_id
                                 AND pm.message_id = d.message_id
  LEFT JOIN document_tags dt ON dt.document_id = d.id
  LEFT JOIN tags t ON t.id = dt.tag_id
  WHERE d.account_id IN (:account_ids)
    AND d.review_status IN (:review_statuses)
    AND month_basis(d) BETWEEN :start AND :end
    AND (:tag_ids IS NULL OR EXISTS (SELECT 1 FROM document_tags x WHERE x.document_id = d.id AND x.tag_id IN (:tag_ids)))
  GROUP BY d.id
  ORDER BY a.slug, d.transaction_date NULLS LAST, d.created_at
  ```
  where `month_basis(d) = strftime('%Y-%m', COALESCE(d.transaction_date, datetime(CAST(pm.internal_date AS INTEGER) / 1000, 'unixepoch')))`. The LEFT JOIN to `processed_messages` is **most-recent-attempt-aware**: when the message has been reclassified, we want the latest `internal_date` (in practice all attempts share the same `internal_date` because it's Gmail's own field, so the cardinality multiplication is a no-op for date math; it does affect `subject`/`sender_domain`/`classification`/`model_used` columns in the manifest, where we want the latest values). The query filters `pm` to `pm.id = (SELECT MAX(id) FROM processed_messages WHERE account_id = d.account_id AND message_id = d.message_id)`. See Risks for the broader JOIN-cardinality concern carried over from Slices 006/007.
- **Preview/download parity.** Both endpoints call `selectDocumentsForExport` with the same params, so the user's preview cannot lie about what's in the zip. The preview omits the file-streaming step but otherwise traverses the same row set.
- **Manifest fields and `notes`.** `architecture.md`'s manifest column list includes `notes`. The `notes` column on `documents` does not exist yet (deferred to Slice 016). This slice still emits a `notes` column in CSV/Markdown manifests, populated with empty string for every row, so the schema is stable from this slice forward and Slice 016's column addition is data-only (no manifest schema change). See Risks.
- **Tag filter semantics.** Multi-select with **OR** semantics — "any selected tag matches". For "AND" semantics ("must have both `business` AND `travel`"), the user can chain exports or wait for a future slice. OR is the more common bookkeeping intent.
- **Review-status filter semantics.** Multi-checkbox; the user can include `approved` only (default), or also `pending` (e.g. for an early peek), or `rejected` (rare). Including all three is allowed but unusual. The `summary.txt` always names the included statuses.
- **Filename collisions inside the zip.** Slice 006's on-disk filenames already include `{message_id}_{seq}_` prefixes, so collisions within the same `(account_slug, yyyy, mm)` directory are already prevented. The export's collision detector is defense-in-depth: if two documents somehow resolve to the same zip path (e.g. after future filename-cleanup changes), append `_2`, `_3`, etc.
- **`summary.txt`.** Always written, even when both manifests cover the same data. Provides a single quick-glance overview at the root of the zip — total count, total per currency, total per tag, per-account totals when applicable, period covered, basis explanation. Designed to be the first thing an accountant looks at.
- **Fiscal-year setting.** Single dropdown in Settings → Fiscal year. Updates `app_config.fiscal_year_start_month`. Affects only the FY presets in the period picker and the FY label in `summary.txt`. Calendar-year users (most US/UK) can ignore it.
- **Browser download UX.** The download endpoint sets `Content-Disposition: attachment; filename="docurator-export-{period_slug}.zip"` so the browser handles save-as natively. No spinner or progress bar in this slice (browsers show their own download UI). For very large exports the user just sees the standard download progress.
- **No request-body POSTs for export.** Using `GET` (with query-string params) means the user can copy-paste an export URL into a fresh tab, share it for reproducibility, or bookmark a recurring export. It also lets the browser handle the streaming download flow without intervention. URLs can grow long (especially with many `account_ids`); for typical use cases (≤10 accounts, a handful of tags) this stays well under reasonable limits.

## Acceptance criteria

- After Slice 011, the Settings → Fiscal year section is enabled. Picking "July" and reloading shows that selection persisted; `sqlite3 data/app.db "SELECT fiscal_year_start_month FROM app_config;"` returns `7`.
- Navigating to `/export` shows the Export view. Default state: most-recently-used account selected, period preset "Last month", review-status filter set to `approved`, no tag filter. The preview pane updates as filters change with a debounce.
- For an install with a previous month's worth of approved receipts, the preview reports an accurate count and currency total. Clicking "Download zip" downloads `docurator-export-2026-04.zip` (or whatever period); opening the zip shows `business/2026/04/...` (or other slugs), `manifest.csv`, `manifest.md`, `summary.txt`.
- `manifest.csv` and `manifest.md` have identical row contents in identical order, just rendered differently. The first column is `filename` matching the actual relative path of each file in the zip.
- `summary.txt` contains the period label, total count, currency breakdown, tag breakdown, per-account totals (when ≥2 accounts), and a "Period basis" line.
- Multi-account export with `account_ids=[1,2]`: the zip contains `business/.../...` and `personal/.../...` folders side by side; the `summary.txt` shows per-account totals; the manifest's `account_label` column distinguishes rows.
- Selecting period preset "FY2026" with `fiscal_year_start_month=1` exports January–December 2026; with `fiscal_year_start_month=7`, the same preset exports July 2025–June 2026.
- Selecting the `business` tag filter narrows both the preview totals and the zip contents to documents with that tag applied. Multi-select `business` + `travel` returns documents with at least one of the two (OR).
- Documents with `transaction_date` in the chosen period appear in the export; documents missing `transaction_date` fall back to `internal_date` for period assignment, and the `summary.txt` "Period basis" line reflects the count.
- Re-running the same export tomorrow (no new sync, no data changes) produces a byte-identical zip *up to the `archiver` library's nondeterministic timestamps and any zip-format jitter* — that's a stronger property than spec'd; the spec only requires same row count, same files, same manifest content.
- Exporting an empty result (e.g. picking a period with no approved receipts) still produces a valid zip with `manifest.csv` (just the header row), `manifest.md` (header only), and a `summary.txt` saying "0 documents". The download succeeds.
- `GET /api/app-config` returns `{ fiscal_year_start_month: 1 }` on a fresh install. `PATCH /api/app-config` with `{ fiscal_year_start_month: 7 }` updates it; subsequent GET returns `7`.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes.

## Risks / open questions

- **`notes` column emitted as empty string.** Adds a stable schema for CSV/Markdown manifests but produces always-empty data until Slice 016 ships the column. Alternative: omit `notes` from the manifest now and add it in Slice 016 (manifest schema change). Provisional choice: keep the column with empty values so Slice 016's contribution is data-only. Flag.
- **Multi-most-recent-`processed_messages` JOIN.** This slice's `selectDocumentsForExport` uses a subquery to take the most-recent `processed_messages` row per `(account_id, message_id)`, which side-steps the JOIN-cardinality issue inherited from the append-only audit log. Slices 006 (Inbox listing) and 007 (Review queue) make the same JOIN but their specs do not yet specify the most-recent-attempt rule. They should be amended in a future iteration to use the same pattern; documents that have been reclassified will currently produce duplicate-multiplied rows in those listings. Not blocking for this slice, but flag for the cleanup pass.
- **Tag filter is OR not AND.** Bookkeeping users sometimes want "tagged `business` AND `client:acme`" intersection. v1 ships OR; AND can be added by switching the `EXISTS` to a `(SELECT COUNT(DISTINCT tag_id) FROM document_tags WHERE document_id = d.id AND tag_id IN (:ids)) = :n` pattern, plus a UI toggle. Flag.
- **GET-with-long-query-string for download.** Most browsers and proxies cope with several KB of URL; a user picking 50 accounts × 30 tags would push that to limits. For typical single-user installs (≤5 accounts, ≤20 tags), GET is fine. If long-URL issues surface, switch to POST and accept the loss of share-by-URL. Flag.
- **`archiver` deflate vs. store.** Provisional: store-only (`store: true`) so PDFs (already compressed) don't get re-compressed for nothing, halving CPU on export. Most receipt files are PDFs; image attachments compress modestly. Flag.
- **Period-month math vs. SQLite.** The `strftime('%Y-%m', ...)` plus epoch-ms-divided-by-1000 conversion handles `internal_date` (Gmail's epoch-ms string). Edge cases: timezone (Gmail returns UTC ms; the user's local fiscal month may differ at month boundaries by a few hours). Provisional: UTC throughout; document this in `summary.txt`. Flag.
- **Live-preview cost.** A user changing filters quickly fires multiple `GET /api/export/preview` calls. The 200ms debounce limits this; for very large corpora, the `COUNT(*) + SUM(amount) GROUP BY currency` query is fast enough on SQLite. If it ever isn't, cache the last-N parameter sets. Flag.
- **Fiscal-year-aware quarter presets.** `Q2 2026` is currently calendar-based (April–June). Some users with non-calendar fiscal years want fiscal Q2 (e.g. October–December for July-start FY). Provisional: ship calendar quarters in v1; add fiscal-quarter presets if requested. Flag.
- **Concurrent download streams.** Multiple browser tabs hitting `/api/export/download` at once each open their own stream. SQLite WAL handles concurrent reads; `archiver` writes are independent per request. Should work without coordination.
- **Empty-result zips.** Some accounting tools expect at least one row; a zero-row export might confuse them. The spec ships a valid empty zip and lets the user decide. Flag.
