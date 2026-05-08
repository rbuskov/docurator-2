# Docurator — Implementation slices

Vertical feature slices for building Docurator. Each slice cuts through whatever layers it needs (DB schema, server, UI, integration) to deliver one observable capability. Each slice should leave the app in a more useful state than before.

This document lists slice intents in bullet form. Each is fleshed out into a full spec in `specs/`.

## Specs

Each slice listed below has a corresponding spec in `specs/`. The numbering aligns: slice N here is `specs/00N-<kebab-name>.md`. `specs/000-template.md` is the structural template — not a slice.

Specs are authored by an automated loop using `prompts/spec-authoring-loop.md`. The loop reads this file and the existing specs, then takes one focused action per iteration: write a missing spec, fix a gap or overlap between specs, or promote a finished spec from `draft` to `ready`. When it adds or removes a spec, it renumbers the rest and updates this file to match.

Two conventions make gaps and overlaps mechanically detectable:

- Each spec lists **Prerequisites (Consumes)** — what must already exist from earlier slices — and **Deliverables (Produces)** — what this slice adds. Both use the same fixed vocabulary (DB tables, endpoints, components, etc.).
- Identifiers used across specs are written verbatim. If slice 6 produces `documents.amount_edited`, slice 7 must list `documents.amount_edited` if it uses it — same string, same casing.

A gap is a Prerequisite that no earlier spec produces. An overlap is a Deliverable claimed by two specs. Both are cause to rewrite or restructure.

## Notes on ordering

- **Slice 5 (classify one email) is intentionally early.** Classification quality is the whole product's foundation. If a local model can't reliably tell invoices from non-invoices, every other slice is wasted work. Find out fast.
- **Slices 2–3 are throwaway-friendly.** They exist to prove integration works, then get reshaped.
- **Slices 6–11 are the user-value core.** After these, the tool is genuinely usable for bookkeeping.
- **Slices 12–15 are trust and reliability improvements** that make the tool ready for real business use.
- **Soft dependencies:** foundation → anything; classification → sync; sync → review; review → export. Otherwise reorder freely.

---

## Slice 1 — Walking skeleton

- Repo scaffold (package.json, tsconfig, Vite, Dockerfile, docker-compose.yml, MIT LICENSE, .gitignore)
- Hono server boots, serves a placeholder React app at `localhost:3737`
- Health endpoint returns `ok`
- `docker compose up` works end to end
- **Observable result:** "I can run the app and see a page that says Docurator"

## Slice 2 — Connect Gmail accounts

- `accounts` table migration (id, email, display_name, slug, connected_at, last_seen_at, status)
- OAuth loopback flow (consent URL, temp HTTP server, token exchange), runnable any number of times to add additional accounts
- In-memory token store keyed by `accounts.id`, with per-account refresh
- Dashboard view shows the list of connected accounts (email + status), an "Add Gmail account" button when zero or more are connected, and per-account "Reconnect" buttons when status is `needs_reauth`
- Re-auth handling for revoked tokens, isolated per account (one account's failure doesn't take the others offline)
- Configuration loader for OAuth client ID/secret from `.env` (one set of client credentials, reused across all accounts)
- **Observable result:** "I can click a button, log into Google with one or more different Gmail accounts, and see them all listed as connected"

## Slice 3 — See my emails listed

- Gmail API read-only client wrapper (just `listMessages` + `getMessage` for headers), constructed per-account from the in-memory token store
- Build-time check forbidding Gmail write endpoints
- A simple "Inbox" page with an account picker (defaults to the first connected account) that fetches and shows the last 50 messages by subject + sender + date for the selected account
- No DB, no classification, no persistence — just a live read-through view
- **Observable result:** "I can pick any of my connected Gmail accounts and see real headers from it inside the app"

This slice exists mainly to prove Gmail integration works (per account) and to discover the API quirks early. It gets superseded by Slice 6. Keep it small.

## Slice 4 — Persistent state and processed-messages log

- SQLite + better-sqlite3 setup, WAL mode
- Migration runner
- First migration: `processed_messages` (with `account_id` FK and `(account_id, message_id)` unique constraint), `sync_state` (one row per `account_id`), `app_config` tables. The `accounts` table itself was created in Slice 2; this slice adds the tables that reference it.
- Bind-mounted `./data` volume
- Repository layer for these tables (every read/write is account-scoped)
- Manual "Mark first 10 messages as processed for account X" button on the dev UI to verify the round-trip across accounts
- **Observable result:** "I can write rows to SQLite scoped to a chosen connected account, restart the container, and see them still there"

## Slice 5 — Classify one email end-to-end (the riskiest path first)

- Ollama HTTP client + health check on Dashboard
- Single classification prompt + Zod-validated response parsing
- Endpoint: "classify message {account_id}/{message_id}" — fetches one Gmail message from the named account, runs through Ollama, returns the decision (does NOT yet store anything)
- Dashboard or Inbox page gets a "Classify this" button per row (in the currently selected account) that shows the model's verdict inline
- Includes attachment fetching for messages with PDFs/images, using the account's tokens
- HTML body → text extraction (no Playwright PDF rendering yet)
- **Observable result:** "I can pick a real email from any of my connected accounts and see Ollama classify it as invoice/receipt/other with reasoning"

This is the make-or-break slice. If local classification quality isn't good enough, find out now.

## Slice 6 — Sync and store receipts

- `documents` table migration (with `account_id` FK and `(account_id, content_hash)` unique constraint)
- File store (`./invoices/{account_slug}/{yyyy}/{mm}/...`) with per-account content-hash dedup
- Sync orchestrator: iterates connected accounts (default: all), walks each account's recent Gmail messages, classifies each, stores receipts to disk + DB under the right account slug, writes `processed_messages` rows for everything (carrying `account_id`)
- "Sync now" button on Dashboard syncs all connected accounts; per-account "Sync" button on each account row syncs that one
- SSE endpoint for streaming progress, events tagged with `account_id` so the UI can show per-account progress
- Inbox view now shows persisted receipts pulled from SQLite (filterable by account), not live Gmail
- HTML body → PDF rendering (Playwright) for body-as-receipt cases
- Idempotency: re-running sync skips messages already in `processed_messages` for the same `(account_id, message_id)`
- **Observable result:** "I can click Sync, watch per-account progress, and see real receipts captured to per-account folders I can browse on my host"

## Slice 7 — Review and approve

- Side-by-side review view (preview left, metadata right), with the originating account labeled in the metadata
- Approve / reject buttons → updates `review_status`
- `review_actions` table migration + writes
- Keyboard shortcuts (`a`, `r`, `j`, `k`)
- Sorted by confidence ascending; account filter optional (default: all accounts)
- `senders` table (scoped per account, primary key `(account_id, domain)`) + auto-incrementing approved/rejected counts
- **Observable result:** "I can sit down with the captured receipts from all my accounts and triage them in a few minutes"

## Slice 8 — Edit extracted fields

- `documents` schema updated: editable `vendor`, `amount`, `currency`, `transaction_date` + `*_edited` flags
- Inline field editing in review view
- Save-on-blur, optimistic UI
- Edits recorded as actions in `review_actions`
- **Observable result:** "When the model gets the vendor wrong, I can fix it without leaving the review screen"

## Slice 9 — Tags

- `tags`, `document_tags` tables — tags are shared across all connected accounts (one taxonomy for the whole install)
- Tag picker component in review view
- Tag management screen in Settings
- Pre-populated `business` and `personal` tags on first run
- Tag column visible in Inbox list
- **Observable result:** "I can categorize receipts from any account as business / personal / per-client and filter by those, with the same tag taxonomy across all my accounts"

## Slice 10 — Audit view (with deep links)

- Audit page: paginated table of `processed_messages` across all connected accounts (default), with an account column
- Filters: account, classification, confidence, sender, date range, free-text subject search
- "Open in Gmail" deep links per row using `authuser={account_email}` so they open in the correct inbox even when the user has several Gmail accounts in the same browser
- Single-message reclassify button (re-runs classifier on demand, against the originating account)
- Status column for success / failed (failed paths added in Slice 12; this slice can stub)
- **Observable result:** "I can see exactly what the classifier decided about every email across all my accounts, and click through to the original in the right Gmail account"

## Slice 11 — Export

- Account selector (one, several, or all connected accounts; default is the most recently used)
- Month-based period picker (single month, month range, quarter, fiscal year, presets)
- Tag and review-status filters
- Live preview of count + currency breakdown (with per-account breakdown when more than one account is selected)
- Streaming zip endpoint with `archiver`
- Manifest row builder (single source of truth) emitting `account_email` and `account_label` columns
- CSV manifest serializer
- Markdown manifest serializer
- `summary.txt` generator (per-account totals when multiple accounts are exported)
- Account-then-date folder structure inside zip (`{account_slug}/{yyyy}/{mm}/...`), used even for single-account exports for consistency
- Fiscal-year start configuration in Settings (install-wide, applies to all accounts)
- **Observable result:** "I can export approved receipts for a month from any combination of my accounts and hand the zip to my accountant, with each file's source inbox clearly attributed"

## Slice 12 — Failed-classification handling

- `processed_messages.status` and `error_message` columns (migration if not already added)
- Sync orchestrator catches per-message errors and records them as `failed` (with `account_id` carried through)
- Audit view filter for failed items, combinable with the account filter
- Retry-from-audit action (re-runs against the originating account)
- Visual indicator (color, icon) for failed rows
- **Observable result:** "When the classifier breaks on some weird email — in any of my accounts — I can see it, retry it, and don't silently lose data"

## Slice 13 — Document groups and dedup display

- `document_groups` (with `account_id`), `document_group_members` tables — groups are scoped per account so the same receipt arriving in two different connected inboxes stays as two separate documents in two separate groups
- Fingerprint computation during classification
- Review view shows "this also appears in N other emails in this account" when a doc is in a multi-member group
- Quick-select between siblings
- **Observable result:** "When the same Stripe receipt arrives as both body and attachment in the same inbox, I see them grouped and pick one — without spurious cross-account grouping"

## Slice 14 — Reclassification

- Batch reclassify tool in Settings: pick account(s) + month range + model, run
- Reclassifier appends new `processed_messages` rows (doesn't overwrite), preserving `account_id` and re-fetching from the originating account's tokens
- Decision diff calculator + summary view ("3 became receipts, 1 no longer a receipt"), broken down per account when multiple are selected
- User-edited fields preserved across reclassification
- **Observable result:** "When a better local model comes out, I can re-run any account's archive (or all of them) and see what changed"

## Slice 15 — Sender memory and auto-skip

- Use per-account `senders.approved_count` / `rejected_count` to influence classification confidence (signals don't cross between accounts — Stripe trusted in your business inbox doesn't auto-trust Stripe in your personal inbox)
- Sender allowlist/blocklist editor in Settings, with an account selector
- Auto-flag high-confidence receipts from frequently-approved senders, scoped per account
- Auto-skip from blocked senders (recorded in audit log as skipped, with `account_id`)
- **Observable result:** "After approving a few Stripe receipts in my business inbox, the app trusts Stripe in that inbox by default and surfaces less for review — without affecting how it treats Stripe mail in my personal inbox"

## Slice 16 — Polish and edge cases

- Empty states across all views (no accounts connected yet, single-account vs multi-account)
- Comprehensive error states (Ollama down, Gmail revoked on one or more accounts, network errors during sync)
- Loading and streaming states
- Mid-session re-auth UX during long syncs, isolated per account so other accounts continue
- README with screenshots, including the multi-account add flow
- Setup walkthrough docs (including how to add additional accounts and the test-users-list note for Google Cloud Testing mode)
- Backup recommendations doc
- **Observable result:** "I could give this to a freelancer friend with a personal and a business Gmail and they could set it up themselves"
