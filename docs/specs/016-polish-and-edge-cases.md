# Slice 016: Polish and edge cases

**Status:** ready

## Observable result

I could clone this repo, hand it to a freelancer friend with a personal and a business Gmail, and they could set it up themselves: the README walks them through Google Cloud OAuth client creation (with screenshots, the test-users-list note for Testing mode, and the multi-account add flow), Ollama install, `docker compose up`, and their first sync. The app's UI degrades gracefully when things go wrong — Ollama down, one Gmail account's tokens revoked mid-sync, a network blip — without breaking other accounts or losing data. They can also add freeform notes to receipts in the Review view, see them in exported manifests, and find Backup Recommendations explaining how to safeguard `./data/` and `./invoices/`.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` (Slice 002)
  - `processed_messages` (Slice 004)
  - `documents` — including all Slice 006/008/014/015 columns (`vendor`, `amount`, `currency`, `transaction_date`, `*_edited`, `review_status`, `model_disagrees`, `auto_approved`)
  - `review_actions` (Slice 007), `senders` (Slice 007 / 015), `tags`, `document_tags` (Slice 009), `document_groups`, `document_group_members` (Slice 013)
- **Migrations:**
  - `0001`–`0015` (Slices 002–015)
- **API endpoints:**
  - All endpoints from Slices 002–015 — extended here only for `notes` field on `PATCH /api/documents/:id`
- **UI views / components:**
  - All views from Slices 001–015 — extended here with shared empty/loading/error patterns and a re-auth banner
- **Background jobs / orchestrators:**
  - Sync orchestrator (Slices 006 / 013 / 015), reclassify orchestrators (Slices 010 / 014 / 015)
- **Env vars / configuration:**
  - All env vars from prior slices
- **Files / modules:**
  - All source from prior slices
  - `src/server/auth/session.ts` (Slice 002) — already raises `needs_reauth` per account; this slice surfaces it in the UI
  - `src/server/export/manifest.ts` (Slice 011) — extended here to populate the `notes` column from real data
- **External services:**
  - Google OAuth + Gmail per account (Slice 002 + 003)
  - Ollama at `OLLAMA_URL` (Slice 005)
- **Other:**
  - SQLite WAL + foreign-keys-on (Slice 004)

## Deliverables (Produces)

- **DB tables / columns:**
  - `documents.notes` TEXT NOT NULL DEFAULT '' — freeform user notes attached during review. Empty string default so the export's manifest column (which Slice 011 already emits as empty) starts populating real data immediately on upgrade.
- **Migrations:**
  - `0016_add_documents_notes.sql` — single `ALTER TABLE documents ADD COLUMN notes TEXT NOT NULL DEFAULT ''`. No backfill needed.
- **API endpoints:**
  - `PATCH /api/documents/:id` (modification of Slice 008's endpoint) — extends the request body's Zod schema to accept `notes?: string` (max length 4000 chars). When provided and different from the current value, updates the column, sets `documents.updated_at`, and writes a `review_actions` row with `action='edited'` and `details={"field":"notes","from":"...","to":"..."}` — same pattern as Slice 008's other field edits. `notes` does not get a `*_edited` flag (it has no model-extracted baseline).
- **UI views / components:**
  - `EmptyState.tsx` — shared empty-state component. Props: `title`, `body`, `cta?: { label, onClick | href }`, `illustration?: 'no-accounts' | 'no-receipts' | 'no-failures' | 'all-caught-up'`. Used by Dashboard ("Connect your first Gmail account" when no accounts), Inbox ("No receipts yet — run Sync"), Review queue ("All caught up — N approved, M rejected this session"), Audit ("No emails processed yet"), Export ("Pick a period to preview"), Settings → Senders ("No senders seen yet for this account").
  - `ErrorState.tsx` — shared error component. Props: `title`, `message`, `actions?: Array<{ label, onClick }>`, `severity: 'warning' | 'error'`, `details?: string` (collapsible). Used inline by Inbox/Audit/Review on fetch failures, by `OllamaHealth` (extended here from Slice 005's Dashboard badge into a more substantial banner when down for >30s), and by sync/reclassify orchestrators when an account-wide failure occurs.
  - `LoadingState.tsx` — shared loading component. Variants: `'spinner'` (default), `'skeleton-table'` (used by Inbox/Audit), `'skeleton-card'` (used by Review preview). Replaces the ad-hoc spinners scattered through Slices 002–015.
  - `ReAuthBanner.tsx` — global banner rendered at the top of every page when one or more accounts have `status='needs_reauth'`. Lists the affected accounts with one-click Reconnect buttons (calls Slice 002's `POST /api/accounts/:id/reconnect`). Persists across navigation. Disappears when all accounts are `connected`.
  - `MidSyncReAuthHandler.tsx` — listens to `sync.error` SSE events from Slice 006 (and the equivalent from Slice 014's reclassify) for `account_id`-scoped token failures. When triggered, surfaces an inline toast pointing at the `ReAuthBanner` and confirms that other accounts' sync continues. The toast is dismissible; the banner persists until reconnect.
  - `NotesField.tsx` — textarea embedded in `ReviewMetadata.tsx` below the tag picker. Save-on-blur (same pattern as Slice 008's `EditableField`); shows a small "saved" indicator after each successful PATCH. Max 4000 chars; counter shown when ≥3500.
  - `ReviewMetadata.tsx` (modified) — mounts `<NotesField />` after the tag picker.
  - `Inbox.tsx` (modified) — adopts `EmptyState`, `LoadingState`, `ErrorState` for its empty/loading/error paths; surfaces a small "notes" indicator (a tooltip-on-hover icon) on rows whose `notes` is non-empty.
  - `Review.tsx`, `Audit.tsx`, `Export.tsx`, `Settings.tsx`, `Dashboard.tsx` (modified) — all adopt the shared empty/loading/error components.
  - `OllamaHealth.tsx` (modified, originally Slice 005) — when Ollama has been unreachable for >30s, expand into an `ErrorState`-styled banner at the top of the Dashboard with copy "Ollama is not reachable at {OLLAMA_URL}. Make sure Ollama is running and the host network is accessible." plus a "Retry health check" button. The small badge variant is preserved as the default state.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/db/migrations/0016_add_documents_notes.sql`
  - `src/server/db/repositories/documents.ts` (modified) — `update` accepts `notes` in its partial; the same audit-row writer handles the new field.
  - `src/server/api/documents.ts` (modified) — extends the PATCH Zod validator with `notes`.
  - `src/server/export/manifest.ts` (modified) — emits `documents.notes` for the manifest's `notes` column instead of always empty (Slice 011 placeholder behavior). The CSV/Markdown serializers don't change since the column was already in the schema.
  - `src/client/components/EmptyState.tsx`, `ErrorState.tsx`, `LoadingState.tsx`, `ReAuthBanner.tsx`, `MidSyncReAuthHandler.tsx`, `NotesField.tsx`
  - `src/client/views/Dashboard.tsx`, `Inbox.tsx`, `Review.tsx`, `Audit.tsx`, `Export.tsx`, `Settings.tsx` (all modified) — adopt shared components, surface the re-auth banner globally
  - `src/client/components/OllamaHealth.tsx` (modified)
  - `src/client/components/ReviewMetadata.tsx` (modified) — mounts `<NotesField />`
  - `src/client/App.tsx` (modified) — mounts `<ReAuthBanner />` and `<MidSyncReAuthHandler />` once at the app shell
  - **Documentation files (text deliverables, written into the repo as part of this slice):**
    - `README.md` — top-level repo README. One-paragraph pitch; the three privacy properties; prerequisites; setup steps; first-run guide including the multi-account add flow; how classification works (brief); how reclassification works; FAQ ("why do I have to re-auth each time?", "can I use a different model?", "where are my files?", "can I connect more than one Gmail account?", "how do I disconnect or remove an account?"). Includes screenshots for: (a) Google Cloud Console — creating a Desktop OAuth client, (b) the consent screen showing only `Read your email messages and settings`, (c) the Dashboard with two accounts connected, (d) Sync progress with per-account counters, (e) the Review view, (f) the Export view, (g) a sample exported zip's contents.
    - `docs/setup-walkthrough.md` — long-form setup with extra detail: creating the Google Cloud project, enabling the Gmail API, configuring the consent screen in Testing mode (covering the test-users list and the small per-account cap), creating a Desktop OAuth client, populating `.env`, the first `docker compose up`, adding additional Gmail accounts, troubleshooting common issues (port conflicts, Ollama not reachable, browser blocking the popup).
    - `docs/backup-recommendations.md` — explains what's in `./data/app.db` and `./invoices/` and why they matter (legal significance for tax retention), recommends host-level backup tools (Time Machine on macOS, restic / Borg / Backblaze for cross-platform), notes the WAL sibling files (`app.db-wal`, `app.db-shm`) and why backup tools should pick them up automatically as part of the directory, suggests encrypted volumes (FileVault, BitLocker, LUKS) for sensitive client data, and explains how the Export feature can produce a self-contained year-end archive that's independent of the app continuing to work.
- **External services:** —
- **Other:**
  - First slice that emits documentation files — README and `docs/*` are intentional deliverables, not just notes. Their content has to track the implementation, so this slice ships them once the prior 15 slices have stabilized the surface area.
  - **Privacy walkthrough.** The README's "Privacy model" section foregrounds all three architectural properties — read-only Gmail, locally-only classification, only-receipts-persisted — uniformly across all connected accounts.

## Out of scope

- An accessibility audit beyond the natural-HTML-semantics baseline (WCAG conformance testing, screen-reader QA, keyboard-only navigation review of every screen) → not planned for v1
- Internationalization / translation → not planned (single-user self-hosted tool; English-only)
- Mobile / responsive layout review (the app is for desktop browsers) → not planned
- Multi-select tag filter on the Inbox (deferred from Slice 009) → still deferred; user can chain single-tag exports
- AND-semantics tag filter on the Export (deferred from Slice 011) → still deferred
- Tagging from the Inbox view (deferred from Slice 009) → still deferred
- A "Disconnect / remove account" UI (deferred from Slice 002) → still deferred; users can remove an account by editing the DB or letting it stay in `needs_reauth` indefinitely. Flag.
- Editing `display_name` from the UI (deferred from Slice 002) → still deferred
- Edit history disclosure in the Review metadata pane (deferred from Slice 007) → still deferred
- Undo toast for approve/reject (deferred from Slice 007) → still deferred
- Freeform color picker for tags (deferred from Slice 009) → still deferred (palette swatches + hex input is enough)
- Editing extracted fields from the Inbox view (deferred from Slice 008) → still deferred (Review is the canonical edit surface)
- Auto-cleanup of orphan `document_groups` rows (deferred from Slice 013) → still deferred
- Per-attempt provenance column on `documents` (`processed_message_id` FK; flagged in Slices 006 / 014) → still deferred
- Persisting reclassify diffs across container restarts (Slice 014) → still deferred
- Settings → Accounts panel that consolidates Dashboard's accounts list + a "Disconnect" button → still deferred
- Slice 006/007 JOIN cardinality cleanup (latest-`processed_messages`-row pattern explicit in their queries) → still deferred; the queries function correctly today as long as reclassification is rare; if reclassification becomes routine before this is fixed, duplicate rows in those listings may surface. Flag for follow-up.
- A polished "screenshots automation" pipeline → not planned; screenshots in the README are captured manually and committed under `docs/screenshots/`

## Detailed design

This slice's purpose is *delivering*: the prior 15 slices ship working code; this one ships the wrapper that turns the working code into something a freelancer can actually adopt themselves. It also closes one loose end the prior slices flagged (the `notes` column) and consolidates the empty/loading/error/re-auth UX patterns scattered across views.

- **Shared empty/loading/error components.** Each prior slice introduced ad-hoc states ("loading…" text, custom error messages). This slice unifies them via three components, with consistent visual treatment, copy patterns, and CTAs. The implementation pass replaces inline JSX in views with `<EmptyState />` / `<LoadingState />` / `<ErrorState />` calls. Screen real estate stays the same; the consolidation is for maintainability and consistency, not visual change.
- **Re-auth UX during long syncs.** Slice 002 ships per-account re-auth, and Slice 006 emits `sync.error` events for token failures. This slice surfaces both:
  - `ReAuthBanner` is mounted at the app shell and consults `GET /api/accounts` (polled every 30s, plus immediately after `sync.error` events) to render a persistent banner when any account is in `needs_reauth`.
  - `MidSyncReAuthHandler` listens to the SSE stream during active syncs and surfaces a non-blocking toast when a token failure occurs, with copy that explicitly reassures the user that other accounts' sync is continuing ("`personal@…` needs reconnecting; sync continues for your other accounts").
- **`notes` column.** Architecture lists it; Slices 006 and 008 both flagged it as deferred. This slice ships it: a `TEXT NOT NULL DEFAULT ''` column on `documents`, a textarea in `ReviewMetadata.tsx`, the PATCH endpoint extension, and the manifest population for export. Save-on-blur matches Slice 008's `EditableField` pattern. The 4000-char cap is generous; nobody writes 4000 characters of notes per receipt, but capping prevents pathological abuse and very-long manifest cells.
- **Manifest `notes` column population.** Slice 011 emitted the `notes` column with empty string; this slice flips it to read `documents.notes`. CSV escapes embedded newlines and double-quotes per RFC 4180 (already implemented in Slice 011's CSV writer); Markdown rendering of newlines inside a table cell uses `<br>` substitutions. No schema change to the manifest; the column was always there.
- **Ollama-down banner.** Slice 005's Dashboard badge handles the "Ollama is unreachable" case but only on the Dashboard. This slice extends it into an app-wide banner when down for >30s (a short flicker doesn't disrupt the UI), with a "Retry health check" button that re-polls `GET /api/ollama/health`. The banner is dismissible but reappears every 60s while the condition persists.
- **Documentation deliverables.**
  - **README.md** is the entry point for someone discovering the repo. It pitches Docurator in one paragraph, presents the privacy model upfront (all three properties), then walks through prerequisites (Docker, Ollama, ≥1 Google Account), setup (Google Cloud OAuth client creation with screenshots, `.env` config, `docker compose up`), first-run flow (connect first account, optional add others, first sync), and an FAQ. Screenshots live under `docs/screenshots/` and are referenced via relative paths.
  - **docs/setup-walkthrough.md** is the deeper companion to the README's setup section — for users who hit a snag and need step-by-step detail. Covers Google Cloud Console UI changes that drift over time, with specific screenshot annotations.
  - **docs/backup-recommendations.md** explains the tax-significance of the data, what to back up (`./data/`, `./invoices/`), what doesn't need backup, recommended tools per OS, and the WAL-file behavior. It also explains the long-tail safety net of running Export year by year as offline archives.
- **Per-account isolation of failures during sync.** Slice 006 already isolates per-account token failures from each other. This slice's UX work makes that isolation visible: the user sees that account A is paused for re-auth while accounts B and C continue, with explicit per-account counters in the SyncControls UI. No backend changes; the Slice 006 behavior is just made legible.
- **What this slice deliberately does not do.** Many smaller deferrals from prior slices (multi-select tag filter, AND-semantics tag filter, freeform color picker, undo toast, Settings → Accounts consolidation, JOIN-cardinality cleanup) remain out of scope. Slice 016's bar is "could a freelancer set this up themselves and use it productively?" — not "every nice-to-have polish item is shipped". The Out-of-scope list is long and explicit so future contributions know where to start.

## Acceptance criteria

- After Slice 016 migrations apply, `sqlite3 data/app.db ".schema documents" | grep notes` shows `notes TEXT NOT NULL DEFAULT ''`. Existing documents have empty-string notes.
- The Review pane shows a `<NotesField />` textarea below the tag picker. Typing a note and blurring saves it (a "saved" indicator briefly shows). Reloading the page persists the note. `documents.notes` matches the typed text. `review_actions` has a new row with `action='edited'`, `details={"field":"notes","from":"","to":"..."}`. `documents.updated_at` is bumped.
- Approving the document clears the `documents.review_status` to `'approved'` (Slice 007 behavior unchanged); the note is preserved across approval.
- Exporting a period whose documents have notes produces `manifest.csv` and `manifest.md` with the `notes` column populated for those rows; embedded newlines and quotes are escaped correctly per format.
- Each main view (Dashboard, Inbox, Review, Audit, Export, Settings) renders an empty state via `<EmptyState />` when no data is available — instead of a blank page or a console-only "0 results" message. The CTA on Dashboard's empty state ("Connect your first Gmail account") starts the OAuth flow.
- Each main view renders a `<LoadingState />` while initial data fetch is in flight, replacing previous ad-hoc spinners.
- Each main view renders an `<ErrorState />` on fetch failure, with a Retry button that re-runs the same fetch. The collapsible "Details" reveals the underlying error message for debugging.
- Stopping Ollama for ≥30s triggers an app-wide red banner ("Ollama is not reachable at http://host.docker.internal:11434. Make sure Ollama is running...") with a Retry button. Restarting Ollama and clicking Retry clears the banner.
- Revoking one account's Gmail tokens (e.g. via the user's Google account settings) and starting a sync triggers the `MidSyncReAuthHandler` toast for that account; the `ReAuthBanner` stays at the top of every page until the user reconnects; sync continues processing other connected accounts in the meantime; the affected account's progress shows "needs re-auth — paused".
- Reconnecting the affected account via the banner's button completes the OAuth flow; the banner disappears; the next sync covers the previously-paused window for that account.
- The repo contains `README.md` at root, `docs/setup-walkthrough.md`, and `docs/backup-recommendations.md`. The README references the screenshots under `docs/screenshots/` and the setup walkthrough; the screenshots themselves are committed.
- A new contributor (or a friend) can clone the repo, follow the README, and reach a state where: (a) `docker compose up` succeeds, (b) the Dashboard loads at `localhost:3737`, (c) the consent screen shows **only** `Read your email messages and settings`, (d) at least one Gmail account is connected, (e) Ollama health is green, (f) "Sync now" runs and produces receipts in `./invoices/`. This is the slice's "Observable result" and the most direct test of slice success.
- `npm run check:gmail-readonly` (Slice 003 guard) still passes after this slice's changes.

## Risks / open questions

- **Documentation drift.** The README and walkthrough will go stale as Google Cloud Console's UI changes (it does, frequently). Provisional mitigation: the screenshots live under `docs/screenshots/` and can be re-shot periodically; the doc text is written in steps that survive minor UI changes (e.g. "click the OAuth client type — usually labeled 'Desktop app'"). Flag.
- **Test-users-list cap.** Google's Testing-mode consent screen caps test users at a small number (currently 100, but historically lower). Users connecting many Gmail accounts may need to add each address to the test-users list. The setup walkthrough names this explicitly. If a user hits the cap, they'd need to apply for verification (out of scope) or run separate Docurator installs (which works fine — each install has its own `.env` and DB).
- **Notes max length.** 4000 chars is arbitrary; flag for confirmation. Markdown table rendering of long notes can wrap awkwardly; the manifest viewer (typically a spreadsheet program for CSV, a Markdown viewer for the `.md` companion) handles wrapping itself.
- **Ollama-down banner threshold.** 30s before the banner shows is a guess; flag. Some users might want immediate feedback (badge already covers that); others want to ride out brief network blips. The banner is the "you should do something" surface.
- **Re-auth banner polling.** 30s polling on `GET /api/accounts` is fine for most use; aggressive polling would be wasteful, slow polling means slow recovery from re-auth. Flag if this becomes a problem.
- **Empty-state copy quality.** This is fundamentally a writing problem; review by a non-developer user is the right test. The provisional copy is a starting point; iterate.
- **Many smaller deferrals.** The Out-of-scope list is long; some of those items (Disconnect account, undo toast, multi-select tag filter) are user-experience asks that may be more important than other Slice 016 items. The slice prioritizes the items that block self-service adoption (README, error states, re-auth UX, notes column for export completeness). Other deferrals can ship in follow-up slices outside the original 16-slice plan. Flag.
- **No automated tests in this slice.** The implementation will need a test pass (unit tests for repositories, integration tests for endpoints, smoke tests for views), but test infrastructure is not a Slice 016 deliverable per the spec. The implementation team should add tests as they go through the prior slices' code paths. Flag.
- **Slice 006/007 JOIN-cardinality cleanup not addressed here.** This slice does not extend the export's "latest-`processed_messages`-row" pattern back into the Inbox listing and Review queue. If reclassification becomes routine in real use, those listings may show duplicate rows. Flag for a follow-up cleanup pass after Slice 016 ships.
