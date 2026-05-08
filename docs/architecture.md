# Docurator — Architecture

This document describes the technical design of Docurator. For the project's purpose, intended users, and guiding principles, see [vision.md](./vision.md).

In short: Docurator is a self-hosted web app for freelancer business bookkeeping that reads one or more of your Gmail accounts (read-only), classifies receipts and invoices locally via Ollama, and lets you review and export them to your accounting system. Email content never leaves your machine; non-receipt mail is discarded after classification; no connected Gmail account is ever modified.

This document covers how that's built.

## Goals & non-goals

**Goals**
- **Read-only access to Gmail.** The app requests `gmail.readonly` and nothing more, for every account the user connects. It will never modify, label, move, mark as read, archive, or delete any message in any of them. Every connected inbox is left exactly as it was found. This is a hard architectural property, not a stylistic preference — see the "Read-only Gmail access" section below.
- **Multiple Gmail accounts per install.** A single Docurator instance can connect any number of Gmail accounts (typical case: a personal address and a business address). Sync, classification, review, audit, and export all treat the account as a first-class dimension, so receipts stay attributable to their source inbox.
- Detect invoices and receipts in Gmail messages — both as attachments and inside email bodies
- Classify entirely on the user's own machine; no email content sent to any third-party API
- Provide a review UI to confirm, reject, edit, and tag classifications
- Provide an audit/double-check view of all processed emails with deep-links to Gmail, including failed classifications
- Support re-classification with a different model
- Deduplicate when the same receipt appears multiple times (body + attachment, order confirmation + invoice, etc.)
- Export approved receipts as zip files plus a structured CSV manifest suitable for accountants or accounting-software import
- Support fiscal-period exports (year-end, quarterly VAT periods)
- Open source on GitHub, source-only distribution
- Gmail-only in v1

**Non-goals (v1)**
- **Any modification of Gmail state**, including labels, folders, read/unread status, archive, trash, or message content. Not now, not in any future version of v1.
- Full structured field extraction at line-item level (just the dedup/export fields: vendor, amount, currency, date)
- Multi-provider email support (Outlook, IMAP)
- Background polling or scheduling
- **Multi-user / multi-tenant.** One person owns the install. Multi-account (one user, several Gmail addresses) is supported and is *not* the same thing as multi-tenant (separate users sharing one Docurator) — the latter is out of scope.
- Persistent authentication across container restarts (each connected account re-auths on startup)
- Direct integration with accounting systems
- Distribution as binaries / installers
- Built-in backup (rely on user's existing host-level backup of the bind-mounted volumes)

## Read-only Gmail access

This is a strict, auditable property of the application: **the app never writes to any connected Gmail account, in any form, under any circumstance.** The guarantee applies uniformly to every account the user connects.

**OAuth scope.** Per account, the app requests **only** `https://www.googleapis.com/auth/gmail.readonly`. It does not request `gmail.modify`, `gmail.labels`, `gmail.send`, `gmail.compose`, `gmail.insert`, `gmail.metadata`, or any other scope. Google's consent screen will display "Read your email messages and settings" and nothing more, on every account-add flow. If the consent screen ever shows a write-related permission, the app has a bug and the user should refuse consent.

**No write API calls.** The application code uses only the read endpoints of the Gmail API: `users.messages.list`, `users.messages.get`, `users.history.list`, `users.threads.get`, and `users.attachments.get`. Calls to `users.messages.modify`, `users.messages.trash`, `users.messages.delete`, `users.labels.create`, `users.labels.delete`, `users.drafts.*`, and `users.messages.send` are not present in the codebase. This should be enforced by code review and ideally by a lint rule or test that fails the build if a write endpoint is referenced.

**No labels, no folders, no flags.** The app does not create labels, apply labels, remove labels, mark messages as read or unread, move messages to other folders, archive, star, snooze, or trash anything in any connected account. Each inbox after a sync looks identical to before — same messages in same folders with the same flags. The only signal the app leaves behind is in its own local database.

**Idempotency without writes.** Gmail-side idempotency (skip messages we've seen before) is implemented entirely via the local `processed_messages` table, scoped per account. We never need a Gmail-side flag to know what we've processed.

**Visibility in Gmail.** If the user wants to see "which receipts has the app captured?" they use the in-app Audit view, which deep-links to each message in the originating Gmail account. We do not expose this in Gmail's own UI because doing so would require labeling.

**Why this matters.** The user is granting access to one or more inboxes that may contain confidential client correspondence, contracts, personal mail, and everything else. The strongest privacy guarantee we can offer is that the app *cannot* damage this data — in any account — not because we promise we won't, but because we never asked Google for the capability. If the app is compromised, breaks, misbehaves, or is impersonated, the worst it can do is read. It cannot delete, alter, or hide anything in any of the user's inboxes. This is a meaningfully stronger property than "we asked for write access but only use it carefully."

## Privacy model

The defining constraint of this design: **email content never leaves the user's machine, ever** — regardless of how many Gmail accounts the user has connected. Outbound network calls are limited to:

- OAuth handshake with Google (browser-based login), once per account
- Direct Gmail API calls from the user's machine to Google's servers — **read endpoints only**, scoped per account
- Package installs from npm and Docker Hub during setup and updates

Classification runs locally via Ollama. There is no Anthropic API, no cloud OCR, no third-party connector. The app is a faithful local processor — it could function on an air-gapped machine if the OAuth and Gmail traffic were the only allowed exceptions.

A second deliberate property: **the local disk only contains confirmed receipts**. Non-receipt email flows through the app in memory and is discarded immediately after classification. The app is not an email archiver, for any connected account.

A third deliberate property: **the app never writes to any connected Gmail account**. It cannot modify, label, archive, delete, or send mail in any of them. The OAuth scope is read-only on every account, and the codebase does not call any Gmail write endpoint. Every connected inbox is exactly the same after a sync as it was before. See "Read-only Gmail access" above.

The README should foreground all three properties clearly.

## High-level architecture

```
┌─────────────────────────────────────────────────────┐
│             Docker Compose stack                    │
│                                                     │
│   ┌──────────────────────────────────────────┐      │
│   │  app container (Node.js)                 │      │
│   │   ┌────────────────────────────────────┐ │      │
│   │   │  Hono backend                      │ │      │
│   │   │   - OAuth flow, per-account        │ │      │
│   │   │   - In-memory tokens, keyed by acct│ │      │
│   │   │   - Gmail sync (per-account)       │ │      │
│   │   │   - Classification orchestration   │ │      │
│   │   │   - SQLite + filesystem            │ │      │
│   │   │   - Zip export                     │ │      │
│   │   └────────────────────────────────────┘ │      │
│   │   ┌────────────────────────────────────┐ │      │
│   │   │  React UI (served by backend)      │ │      │
│   │   └────────────────────────────────────┘ │      │
│   └──────────────────────────────────────────┘      │
│                                                     │
│   Volumes:                                          │
│     ./data      → SQLite DB                         │
│     ./invoices  → confirmed receipt files           │
│                                                     │
└──────────┬─────────────────┬────────────────────────┘
           │                 │
           ▼                 ▼
   ┌──────────────┐  ┌────────────────────┐
   │   Gmail API  │  │  Ollama (on host)  │
   │              │  │  vision model      │
   └──────────────┘  └────────────────────┘
```

One container, two stable host volumes, two outbound dependencies (Gmail — possibly several connected accounts — and the user's local Ollama). Browser hits `http://localhost:3737` to use the app.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | User preference |
| Runtime | Node.js in Docker | Cross-platform parity, easy distribution |
| Backend framework | Hono | First-class TypeScript ergonomics, Zod integration, simple SSE, smaller surface area |
| Validation | Zod + `@hono/zod-validator` | End-to-end type safety from request to response |
| Frontend | React + Vite + Tailwind + shadcn/ui | Familiar, accessible |
| PDF preview | react-pdf | Reliable in-browser PDF rendering |
| Gmail | `googleapis` + `google-auth-library` | Official |
| Auth | OAuth loopback redirect, in-memory tokens only | No persistent secrets |
| Local AI | Ollama on host machine | User's existing install, GPU access |
| Default model | Qwen2.5-VL 7B | Strong vision + text in a single model |
| HTML → PDF | Playwright headless | Robust render of receipt emails |
| Database | SQLite via `better-sqlite3` | Single file, zero ops |
| File store | `./invoices/{yyyy}/{mm}/...` on volume | Browsable, no lock-in |
| Zip export | `archiver` | Streams archives |
| Packaging | Docker Compose | Consistent across platforms |

## Components

### Frontend — React app served from the backend

Five primary views:

- **Dashboard** — list of connected Gmail accounts (each with its own status, last sync time, and per-account counts), Ollama reachable? which model?, aggregate counts across all accounts (this month: N processed, M receipts found, K pending review, J failed), an "Add Gmail account" button, and a "Sync now" button that syncs all connected accounts (or a chosen subset).
- **Inbox** — pending receipts awaiting review, sorted by confidence ascending. Each row shows the originating account. Filters: account, date range, confidence, tag.
- **Review** — side-by-side document preview (PDF via `react-pdf`, images natively, rendered email body as PDF) with classification metadata, the originating account, **editable extracted fields** (vendor, amount, currency, transaction date), **tags**, and a **notes** field. Approve/reject buttons. Keyboard shortcuts (`a` approve, `r` reject, `j`/`k` navigate, `e` focus first editable field). Shows duplicate group members if any.
- **Audit** — table of all processed emails across all connected accounts (whether classified as receipt or not, **including failures**), with account, sender, subject, classification result, confidence, model used, and a deep-link "Open in Gmail" button (that opens the message in the *correct* account — see "Audit / double-check"). Filters: account, classification, confidence, date range, sender, **status (success / failed)**, free-text search on subject. Each row has a "Reclassify" action. This is the main "double-check" surface and is essential for catching false negatives.
- **Export** — account selector (one, several, or all), month-based period selector (single month, month range, quarter, fiscal year) with **presets** ("Last month," "This quarter," "Last quarter," "FY2026"), tag filters, live preview of what the export will contain, "Download zip + manifest" button.

A **settings** panel covers connected accounts (add, remove, re-auth a specific account), Ollama endpoint and model selection, sender allowlist/blocklist editor (scoped per account), tag management (shared across accounts), fiscal-year start configuration (calendar year vs custom, applies to all accounts), and a "re-classify date range with current model" tool (per-account or all).

### Backend — Node.js

Six logical modules:

**Auth module.** Implements the loopback OAuth flow, **once per Gmail account**. Holds the OAuth client config (read from env vars or `./data/config.json`) and a **per-account session map** of access + refresh tokens **in memory only**, keyed by `accounts.id`. Refreshes access tokens silently as needed for each account independently. On expired/revoked refresh token for any account, surfaces a re-auth prompt for that specific account to the UI mid-session, without taking the others offline. The same OAuth client credentials (client ID/secret in `.env`) are reused across accounts — what differs per account is the token set and the Google identity that produced it.

**Gmail sync handler.** Triggered by a UI request that names one account, several, or all connected accounts. For each selected account:
1. Determine the message set to process for that account (since the account's last sync, or a user-specified date range)
2. For each message, fetch headers, body, and attachments into memory **using only read endpoints** (`users.messages.list`, `users.messages.get`, `users.history.list`, `users.attachments.get`) using that account's tokens
3. Hand the message to the classifier (with `account_id` carried through)
4. If receipt/invoice, persist (see Storage); otherwise, log the decision and discard the content
5. Stream progress events to the UI via Server-Sent Events or WebSocket, tagged with the originating account so the UI can show per-account progress

The handler **never calls write endpoints** for any account. Idempotency comes from the local `processed_messages` table, scoped per account — before classifying, check if `(account_id, message_id)` is already there. Account-level errors (one account's token revoked) pause that account's sync and surface a re-auth prompt for it, while other accounts continue.

**Classification module.** For each message:
1. Convert HTML body to plain text and gather any inline images
2. Build a multimodal prompt for Ollama: email metadata (sender, subject), body text, and each attachment (rendered as images for PDFs)
3. Call Ollama's chat API with a vision model
4. Parse structured JSON response: `{ classification, confidence, reason, vendor?, amount?, currency?, transaction_date? }`
5. Return the decision. The extracted fields are first-class: they power dedup, are surfaced in the review UI for editing, and flow into the export manifest.

The classifier should be **conservative about confidence**: when in doubt, return `low` rather than overstating certainty. The downstream UI sorts low-confidence items first, so a too-confident classifier produces silent misses, while an under-confident one just produces more user review work — strictly the better failure mode for business use.

If the message has multiple plausible "documents" (e.g., a body that's a receipt AND an attached invoice), the classifier may return multiple results, one per artifact.

If classification fails (Ollama unreachable, malformed input, JSON parse error, timeout), the message is recorded in `processed_messages` with status `failed` and an error message. **Failures are visible in the Audit view and retryable.** They are not silently dropped.

**Storage module.** Wraps SQLite and the filesystem. Append-only writes to the audit log; review actions go to a separate audit table.

**Dedup module.** Two-tier:
- **Hard dedup** by SHA-256 of stored file bytes — prevents the same exact PDF from being stored twice
- **Soft dedup** by transaction fingerprint (`vendor + amount + currency + transaction_date`) — surfaces probable duplicates in the review UI without auto-merging

**Zip exporter.** Streams a zip via `archiver`, with an optional `manifest.csv` at the root.

### Storage

**SQLite database** at `./data/app.db`. Schema (sketch):

- `accounts` — one row per connected Gmail account
  - `id` (stable surrogate key used by every other table)
  - `email` (unique; the address Google reports for the account)
  - `display_name` (nullable; a friendly label the user can edit, e.g. "Business" or "Personal")
  - `slug` (unique, derived from `email` — sanitized for filesystem use, e.g. `alice-at-example-com`)
  - `connected_at`
  - `last_seen_at` (last time tokens were successfully used)
  - `status` (`connected` / `needs_reauth` — set on refresh-token failure; cleared on successful re-auth)
  - **No tokens stored here.** Tokens live in process memory only, keyed by `accounts.id`.

- `processed_messages` — append-only audit log
  - `account_id` (FK to `accounts.id`)
  - `message_id` (Gmail's ID; unique within an account, **so the unique constraint is `(account_id, message_id)`**)
  - `thread_id`
  - `internal_date` (Gmail's `internalDate`)
  - `processed_at`
  - `model_used` (e.g. `qwen2.5vl:7b`)
  - `status` (`success` / `failed`) — failures are kept and retryable
  - `error_message` (nullable, populated when `status = failed`)
  - `classification` (`invoice` / `receipt` / `other`, nullable when failed)
  - `confidence` (`high` / `medium` / `low`, nullable when failed)
  - `reason` (short string from the model)
  - `sender_domain`
  - `subject` (kept for the audit UI; toggleable in settings)
  - **No email body, no attachment content stored here**

- `documents` — one row per stored receipt/invoice
  - `id`
  - `account_id` (FK to `accounts.id` — denormalized from `processed_messages` for query convenience and to keep account-scoped indices fast)
  - `message_id` (together with `account_id`, FK to `processed_messages`)
  - `kind` (`attachment` / `rendered_body`)
  - `filename`
  - `mime_type`
  - `size`
  - `content_hash` (SHA-256, unique constraint **scoped per account** — same PDF arriving in two different accounts is stored once per account, since the receipts belong to different inboxes and may map to different bookkeeping)
  - `file_path`
  - `vendor`, `amount`, `currency`, `transaction_date` — extracted by the classifier; **editable by the user during review**
  - `vendor_edited`, `amount_edited`, `date_edited` (booleans) — track which fields were corrected by the user, useful for measuring classifier accuracy
  - `notes` (free text, user-added during review)
  - `review_status` (`pending` / `approved` / `rejected`)
  - `created_at`, `updated_at`

- `tags` — user-defined categorization, **shared across accounts**
  - `id`
  - `name` (e.g. `business`, `personal`, `client:acme`, `vat-deductible`, `travel`)
  - `color` (for UI)

- `document_tags` — many-to-many
  - `document_id`
  - `tag_id`

- `document_groups` — soft-dedup groupings, **scoped per account** (a "duplicate" only makes sense within one inbox; the same receipt arriving in business *and* personal accounts is two separate documents in two separate groups)
  - `id`
  - `account_id` (FK)
  - `fingerprint` (e.g. hash of vendor+amount+currency+date)

- `document_group_members`
  - `group_id`
  - `document_id`

- `review_actions` — append-only audit of approve/reject/edit actions
  - `document_id`
  - `action` (`approved` / `rejected` / `edited` / `tagged`)
  - `details` (JSON, e.g. which field changed from what to what)
  - `at`

- `senders` — learned per-sender stats, **scoped per account**
  - `account_id`
  - `domain`
  - `approved_count`
  - `rejected_count`
  - `last_seen_at`
  - Primary key `(account_id, domain)` — stats from `stripe.com` in a personal inbox shouldn't bias what arrives in a business inbox

- `sync_state` — one row per account
  - `account_id` (primary key)
  - `last_history_id`
  - `last_synced_at`

- `app_config` — single row, applies to the install (not per-account)
  - `fiscal_year_start_month` (1-12, default 1 for calendar year)
  - other user preferences

**File store** at `./invoices/{account_slug}/{yyyy}/{mm}/{message_id}_{seq}_{safe_filename}`. The top-level account-slug folder makes provenance obvious from the filesystem alone, makes per-account backup/removal a single-folder operation, and prevents `message_id` collisions across accounts (Gmail IDs are unique within an account, not globally). Files are immutable. Browsable from the host filesystem regardless of app state.

The audit log keeps decision metadata (including subject) but **never** email body content or attachment bytes, except for confirmed receipts which are stored as files. A row in `processed_messages` is a few hundred bytes; even after years of use the audit log stays small enough to fit comfortably on any disk.

## Key flows

### First run

1. User clones repo, fills in `.env` with their own Google OAuth client ID and secret (Desktop app type), runs `docker compose up`
2. Opens `http://localhost:3737`
3. Sees a "Connect your first Gmail account" screen
4. Clicks the button, completes OAuth, returns to a connected app
5. Can immediately add additional Gmail accounts via "Add Gmail account" — repeats the OAuth flow signed in as a different Google identity
6. Sees an Ollama status check — if not reachable or no vision model installed, shows clear instructions. The app expects Ollama on the host at `host.docker.internal:11434` (or a configured URL).
7. Once at least one Gmail account is connected and Ollama is healthy, user picks a "first sync window" (e.g. last 30 days, or "since this date") and clicks Sync. Sync runs across all connected accounts.

### OAuth (loopback redirect, no persistence, per account)

The OAuth flow is run **once per account being added**. The same `.env` OAuth client credentials are reused; what changes per account is which Google identity authenticates.

1. Backend picks a fixed port (configured) for the redirect URI
2. Generates the consent URL and returns it to the frontend, including a state parameter that the backend uses to know "this callback corresponds to an add-account flow"
3. Frontend opens it in a new tab (or the user clicks a link). The user can pick *which* Google account to authenticate as in Google's account chooser — this is how a second/third/Nth Gmail account is added without affecting the first.
4. User authenticates with Google and approves the **single scope `gmail.readonly`**. Google's consent screen will display "Read your email messages and settings" — and only that. No write-related permissions are requested.
5. Google redirects to `http://localhost:<port>/oauth/callback?code=...&state=...`
6. The Docker port mapping ensures this hits the app container; the backend exchanges the code for tokens, fetches the authenticated email address (e.g. via `userinfo`), and:
   - If an `accounts` row already exists for that email: updates `status` to `connected` and stores the new tokens in the in-memory token map under that account's `id` (this is the re-auth path)
   - Otherwise: inserts a new `accounts` row (assigns `id`, derives `slug`) and stores tokens under the new id
7. Tokens are kept in process memory, in a map keyed by `accounts.id`. Nothing about tokens is written to disk.
8. The tab shows "You can close this tab"; the app's main UI now lists the newly connected account alongside any previously connected ones.

When the container stops, tokens are gone for *every* connected account. The `accounts` table persists, so the user sees the list of accounts on next start with a "Reconnect" prompt next to each. Each reconnect typically takes one click since Google remembers the consent.

If the refresh token is revoked mid-session for any one account, the next Gmail call for *that account* fails. The app catches this, sets that account's `status = needs_reauth`, pauses sync work for that account specifically, and prompts the user to reconnect it. Other accounts keep working. After the affected account reconnects, its paused sync resumes from where it left off.

### Sync (manual trigger)

1. UI calls backend `POST /sync` with optional date range and an optional list of `account_ids` (default: all connected accounts in `status = connected`)
2. Backend iterates the selected accounts. For each account:
   a. Determine the message set, using that account's row in `sync_state`:
      - If the account's `last_history_id` exists and no explicit range: incremental via History API
      - Otherwise: search by date range
   b. For each message in that account:
      i. Skip if `(account_id, message_id)` is already in `processed_messages` (idempotent — no Gmail-side state needed, scoped per account)
      ii. Fetch headers, body, and attachments via read-only endpoints, using that account's tokens
      iii. Classify via Ollama (the prompt is account-agnostic; classification logic doesn't change per account)
      iv. Write a `processed_messages` row tagged with `account_id`, regardless of outcome
      v. If receipt/invoice:
         - For each artifact (body and/or attachments classified as receipts):
           - If body: render HTML to PDF via Playwright
           - Compute content hash
           - If `(account_id, content_hash)` already exists in `documents`: skip (hard dedup, scoped per account)
           - Otherwise: write file under `./invoices/{account_slug}/{yyyy}/{mm}/...`, insert `documents` row
           - Compute fingerprint, attach to a `document_group` for that account (creating one if new)
      vi. Stream `sync.progress` event to the UI with the new audit row + any new documents, tagged with `account_id`
   c. Update that account's `last_history_id` and `last_synced_at`
3. Stream `sync.done` (with per-account summary counts) when all selected accounts are finished

Accounts are processed serially by default — Ollama is the bottleneck, and overlapping classification work doesn't help. If one account hits a token error mid-sync, that account is paused and the others continue.

**No connected Gmail account is modified** at any step. Every inbox is in the same state after a sync as it was before. The only side effects of a sync are local: rows in SQLite and files in `./invoices/{account_slug}/...`.

If anything fails on a single message, log it and continue. The next sync (for the same account) will retry uncategorized messages because they're not yet in `processed_messages` for that account.

### Review

1. User opens Review view; UI requests pending documents from backend
2. For each, side-by-side preview + classification metadata + **editable extracted fields** (vendor, amount, currency, transaction date) + tag picker + notes field + approve/reject buttons
3. If the document is part of a group with multiple members, show the group: "This appears to also be in {N} other emails — review together"
4. **Edit fields inline** — corrected values are saved immediately, with `*_edited` flags set so we can later measure how often the classifier got each field wrong
5. **Add tags** — typeahead picker on existing tags, with quick "create new tag" for first-time use. Common tags should be pre-populated (`business`, `personal`) and discoverable.
6. Approve → `review_status = 'approved'`, `senders.approved_count` incremented
7. Reject → `review_status = 'rejected'`, `senders.rejected_count` incremented
8. All edits, tag changes, and approve/reject actions appended to `review_actions`

### Audit / double-check

A table view of `processed_messages` (across all accounts by default) with these columns: account, date, sender, subject, classification, confidence, model used, status (success/failed), "Open in Gmail" link, "Reclassify" action.

The "Open in Gmail" link uses Gmail's URL scheme with the `authuser` parameter to target the correct account: `https://mail.google.com/mail/u/?authuser={account_email}#all/{message_id}`. Gmail's web UI honors `authuser=<email>` regardless of which positional `/u/N/` slot the user is currently signed into, so the link always opens the message in the right inbox even when the user has several Gmail accounts in the same browser.

Filters: account, date, sender, classification, confidence, status, free-text subject search. The account filter defaults to "all", and a per-account view is one click away.

**Key views for business use:**
- "Show only failed" — items the classifier couldn't process. These need attention; they may be receipts hidden by errors.
- "Show only `other` from senders I've previously approved (in this account)" — high-value review surface for catching false negatives. If you've approved 3 invoices from `acme.com` in your business inbox and a 4th in the same inbox was classified as `other`, that's worth a look. Sender stats are scoped per account, so signals don't cross-contaminate.
- "Show only low-confidence" — even when classified as receipt, low-confidence items deserve a look before approval.
- "Show only since last review" — checkpoint mechanism so you don't re-scan items you've already inspected.

If the user finds a misclassification, they can click "Reclassify" — the backend re-fetches the message from the originating account and re-runs with the current model. For systematic re-classification across a range, use the Settings → Reclassify tool.

### Reclassification

User selects a date range, optionally one or more accounts (default: all), and a model (newly pulled, perhaps), clicks "Reclassify."

1. Backend queries `processed_messages` for that range, filtered to the selected accounts
2. For each, re-fetches from the originating Gmail account (using that account's tokens) and re-runs the classifier with the new model
3. Appends a new `processed_messages` row each time, preserving `account_id` (decisions are append-only — older decisions remain visible in the audit log so you can see how a model's behavior changed over time)
4. If the new decision differs from the previous one:
   - If "was other, now receipt" → store the document as usual; surface for review
   - If "was receipt, now other" → soft-flag the existing document with a "model now disagrees" indicator; don't auto-delete (let the user decide)
   - User-edited fields are preserved across reclassification — the new model's extracted values are stored separately, and the user keeps their corrections
5. Show a summary diff: "47 messages re-classified, 3 changed to receipt, 1 changed away from receipt, 0 failed"

This makes "try a better model" a first-class operation, not a destructive one.

### Export

The export is the deliverable that flows into accounting — it needs to be substantive and accountant-ready.

**Period selection is month-based, not arbitrary date ranges.** A freelancer's accounting workflow runs in calendar units — "May 2026," "Q2 2026," "FY2026" — never "May 7th through June 14th." Anchoring the export to whole months matches how books are kept, eliminates a class of off-by-one errors at month boundaries, and produces consistent, reproducible exports (re-exporting "May 2026" tomorrow gives the same result as today).

1. User picks the **account(s)** to export from — typically a single business account, but the user may export from several (or all) at once. The default is the most recently used account; "All accounts" is a one-click option.
2. User picks a period: a single month, a range of consecutive months, a quarter, or a fiscal year. **Presets** — "Last month," "This quarter," "Last quarter," "FY2026," "FY2025" — cover the common cases. A custom month-range picker handles the rest. There is no day-level granularity in the picker.
3. User picks additional filters: tags (e.g. only `business`, exclude `personal`), review status (typically "approved")
4. UI shows a **live preview**: "X documents (across N accounts) totaling Y in {currency breakdown}" so the user can verify before downloading
5. Backend opens a streaming response, writes a zip via `archiver`
6. Adds files as it goes — never holds the full archive in memory, organized into a folder structure (see below)
7. Writes a **`manifest.csv`** at the root with one row per file:
   - `filename` (relative path within the zip, e.g. `business/2026/05/stripe_receipt.pdf`)
   - `account_email`, `account_label` (the `accounts.email` and `accounts.display_name` of the source inbox)
   - `source_email_date`, `source_email_sender`, `source_email_subject`
   - `classification`, `confidence`, `model_used`
   - `vendor`, `amount`, `currency`, `transaction_date`
   - `tags` (semicolon-separated)
   - `notes`
   - `gmail_message_id` (for traceability back to source — uniquely identified by `(account_email, gmail_message_id)`)
8. Also writes a **`manifest.md`** at the root with the same content as the CSV, formatted as a Markdown table. The two files serve different audiences: CSV for accounting-software import, Markdown for humans (an accountant scanning the export, a user reviewing what they handed over, anyone reading the zip without a spreadsheet program at hand). Both are generated from the same data, so they cannot drift.
9. Writes a **`summary.txt`** at the root: total document count (with per-account breakdown when more than one account is included), currency breakdown, tag breakdown, period covered — a quick sanity check before handing to an accountant. Always included, even when manifests would already cover this information; small files are cheap and a plain-text summary is the fastest way to verify the export at a glance.
10. Browser saves the zip via the standard download flow

**Period boundaries.** A document belongs to a month based on its `transaction_date` (the date the receipt is for, extracted by the classifier and editable by the user). When `transaction_date` is missing or unreliable, the `internal_date` from Gmail (when the email arrived) is used as a fallback. The `summary.txt` makes the basis explicit so the user knows which dating was used.

The CSV manifest is the import surface — most accounting tools can ingest CSV. The Markdown manifest is the readable mirror. The summary.txt is the at-a-glance overview. The PDFs are the supporting evidence.

**Zip folder structure.** Documents inside the zip are organized first by account, then by date — `{account_slug}/{yyyy}/{mm}/{filename}` — mirroring how they're stored on disk. The account-level folder is included even for single-account exports, so the structure is consistent and the manifest paths always say which inbox a file came from. The root of the zip looks like:

```
docurator-export-{date_range}.zip
├── manifest.csv
├── manifest.md
├── summary.txt
├── business/
│   ├── 2026/
│   │   ├── 01/
│   │   │   ├── stripe_receipt_jan15.pdf
│   │   │   └── aws_invoice_jan31.pdf
│   │   ├── 02/
│   │   │   └── ...
│   │   └── 05/
│   │       └── ...
│   └── 2025/
│       └── ...
└── personal/
    └── 2026/
        └── ...
```

Filenames inside the zip are derived from the document — vendor + date when available, fallback to original filename. They're cleaned for cross-platform compatibility (no slashes, colons, or other path-hostile characters).

**Fiscal-period handling:** the configured `fiscal_year_start_month` (default January) determines what "FY2026" means. A fiscal year starting in July would treat "FY2026" as July 2025 through June 2026. This matters for non-US/UK businesses with non-calendar fiscal years.

## Deduplication strategy

**Hard dedup (content hash):** SHA-256 of file bytes. Unique constraint on `documents.(account_id, content_hash)` prevents the same exact bytes from being stored twice **within an account**. Catches "body + attachment of the same PDF" and "same attachment in two threads" cleanly.

**Across accounts:** A receipt that arrives in *two different* connected inboxes (e.g. Stripe sends to both your personal and business addresses) is intentionally stored as two documents — one per account — because the two inboxes generally map to different bookkeeping. The audit log makes both copies visible; the user can reject one if they don't want it counted twice.

**Soft dedup (fingerprint):** During classification, the model is asked to extract `vendor`, `amount`, `currency`, and `transaction_date` when possible. These form a `fingerprint`. Documents with the same fingerprint go into a `document_group`, scoped per account. The review UI shows group members together so the user can pick which one to keep / mark approved.

**Within-thread:** When a single email contains both a receipt body AND a receipt attachment, prefer the attachment (canonical artifact) and skip rendering the body. Note the body's existence in `processed_messages` for traceability.

**Series vs duplicates:** Recurring monthly invoices for the same amount from the same vendor will share vendor + amount but differ in `transaction_date`. The fingerprint includes date specifically to keep these as separate documents, not duplicates.

Dedup decisions are **suggestions for the user's review**, not silent merges. The app never deletes or hides receipts behind the user's back; it surfaces grouping and lets the user decide.

## Docker Compose layout

```yaml
services:
  app:
    build: .
    ports:
      - "3737:3737"
    environment:
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
      OLLAMA_URL: http://host.docker.internal:11434
      OLLAMA_MODEL: qwen2.5vl:7b
      APP_PORT: 3737
    volumes:
      - ./data:/app/data
      - ./invoices:/app/invoices
    extra_hosts:
      - "host.docker.internal:host-gateway"   # Linux compat
```

The app is a single container. Ollama runs on the host (where it has direct access to the GPU). The container reaches Ollama via `host.docker.internal:11434`.

`.env` (gitignored) holds the OAuth credentials.

`./data` and `./invoices` are bind-mounted to the host so the user can browse them, back them up, or migrate them.

## Project structure

```
docurator/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── server/                  # Backend
│   │   ├── index.ts             # Hono entrypoint
│   │   ├── config.ts            # env + config loading
│   │   ├── auth/
│   │   │   ├── oauth.ts         # loopback OAuth flow (per-account)
│   │   │   ├── accounts.ts      # accounts repository (CRUD on `accounts`)
│   │   │   └── session.ts       # in-memory token store, keyed by account_id
│   │   ├── gmail/
│   │   │   ├── client.ts        # Gmail API wrapper (constructed per account)
│   │   │   └── sync.ts          # sync orchestration (iterates accounts)
│   │   ├── classify/
│   │   │   ├── index.ts         # pipeline
│   │   │   ├── ollama.ts        # Ollama HTTP client
│   │   │   ├── prompt.ts        # the classification prompt
│   │   │   └── render.ts        # HTML body → PDF (Playwright)
│   │   ├── dedup/
│   │   │   ├── hash.ts
│   │   │   └── fingerprint.ts
│   │   ├── db/
│   │   │   ├── index.ts         # better-sqlite3 setup
│   │   │   └── migrations/
│   │   ├── files.ts             # file store
│   │   ├── export.ts            # zip streaming
│   │   └── api/                 # HTTP routes
│   └── client/                  # React frontend
│       ├── main.tsx
│       ├── App.tsx
│       ├── views/
│       │   ├── Dashboard.tsx
│       │   ├── Inbox.tsx
│       │   ├── Review.tsx
│       │   ├── Audit.tsx
│       │   ├── Export.tsx
│       │   └── Settings.tsx
│       └── components/
├── README.md
├── LICENSE                      # MIT
└── .gitignore                   # ignores .env, data/, invoices/
```

## Open source considerations

**Each user provides their own Google OAuth credentials.** The README walks through creating a Google Cloud project, enabling Gmail API, configuring the consent screen in Testing mode, and creating a Desktop-app OAuth client. The same credentials are reused for every Gmail account the user connects — there is no per-account configuration on the Google Cloud side. Credentials go in a gitignored `.env`. Note: while the consent screen remains in Testing mode, Google enforces a small cap on test users; users connecting many Gmail accounts may need to add each address to the test-users list (the README covers this).

**Each user provides their own Ollama install.** The README links to ollama.com and gives the `ollama pull qwen2.5vl:7b` command. The app's dashboard surfaces a clear status if Ollama isn't reachable or the model isn't available.

**License: MIT.**

**README structure:**
- One-paragraph pitch
- Privacy model: "email content never leaves your machine" — applies uniformly to every connected Gmail account
- Prerequisites: Docker, Ollama, one or more Google accounts
- Setup: Google Cloud OAuth client creation walkthrough (with screenshots), `.env` file, `docker compose up`
- First-run guide, including how to add additional Gmail accounts
- How classification works (brief)
- How re-classification works
- A FAQ covering: "why do I have to re-auth each time?", "can I use a different model?", "where are my files?", "can I connect more than one Gmail account?", "how do I disconnect or remove an account?"

**Issues, CI, contribution guidelines:** add only if someone shows up.

## Security notes

- **Read-only Gmail access only.** The app requests `gmail.readonly` per connected account and uses only Gmail's read endpoints. It cannot modify, label, archive, delete, or send anything in any of the user's Gmail accounts. See the "Read-only Gmail access" section above for the full guarantee.
- OAuth tokens for every connected account live in process memory only, in a map keyed by `accounts.id`. Container stop = tokens gone for all accounts. The `accounts` table itself persists (so the user sees their list of accounts on next start), but it stores no secrets — only metadata such as email, slug, and `last_seen_at`.
- The OAuth client ID and secret in `.env` are configuration, not user data. They authenticate the *app*, not the user. The same client credentials are reused across all connected accounts.
- Files in `./data` and `./invoices` are at the user's home filesystem permissions. Not encrypted at rest by default. For business use with sensitive client data, place these on an encrypted volume (FileVault on Mac, BitLocker on Windows, LUKS on Linux). The README should recommend this for business users.
- The app makes no outbound network calls except to `googleapis.com` (read endpoints only, on behalf of each connected account) and the configured Ollama URL. Auditable from the source.
- No telemetry, no crash reporting, no analytics.
- Logging: errors to stdout (Docker captures these); no email content in logs ever.
- **CI enforcement (recommended):** add a build-time check that scans the codebase for forbidden Gmail API method names (`messages.modify`, `messages.trash`, `messages.delete`, `messages.send`, `labels.create`, `labels.delete`, `drafts.*`, etc.). Any match fails the build. This makes the read-only property impossible to accidentally violate in a future change.

## Data retention and backup

For business use, the data this app produces — confirmed receipts and the audit log — is **legally significant**. Tax authorities in most jurisdictions require receipt retention for 5-7 years. The app's design supports this naturally, but the user must take responsibility for backups.

**What needs to be backed up:**
- `./data/app.db` — the SQLite database. Contains all metadata, the per-account audit log, tags, review state, and the `accounts` registry itself. Small (probably <100 MB even after years).
- `./invoices/` — the actual receipt files, organized by account slug then date. Grows with usage; budget a few GB per active account-year.

**What does not need to be backed up:**
- `./data/config.json` (if used) — easy to recreate
- The container itself — rebuilt from source

**Recommended approach:** since both directories are bind-mounted to the host, use the user's existing host-level backup tool. Time Machine, restic, Backblaze, Arq, BorgBackup — anything that backs up the host filesystem will pick these up automatically. The README should include a "Backup recommendations" section that says exactly this.

**For migration / archival:** the Export feature can produce a self-contained archive of any month-based period. For a clean year-end snapshot, the user can export "all approved receipts for FY2026" to a zip, store it offline (offsite, on encrypted storage), and have a self-contained record independent of the app continuing to work.

**Database integrity:** SQLite with WAL mode is durable across crashes. The container should be stopped cleanly (`docker compose down`) when possible, but a hard stop won't corrupt the database.

## Open questions / future work

- **Better fingerprinting for dedup.** The current fingerprint depends on the model extracting structured fields reliably. A perceptual-hash approach for visual similarity could complement it.
- **Line-item extraction.** Beyond vendor/amount/date, extract VAT, line items, and payment method for full structured export.
- **Direct accounting-software integration.** Push approved docs and metadata to QuickBooks, Xero, e-conomic, Dinero, Billy, etc. via their APIs. Optional, opt-in per system.
- **Outlook/Microsoft Graph support.** Second provider behind a `MailProvider` interface.
- **Encrypted attachments.** Handle password-protected PDFs (rare).
- **Bring-your-own-API alternative.** A drop-in classifier that uses Anthropic API (or another cloud LLM) for users who prefer quality over strict locality. Same interface, different implementation. Could be sensible as a paid model when local hardware can't keep up.
- **Backfill UX.** Friendlier first-sync experience for large archives, with progress, pause/resume, rate limiting.
- **Reclassify diffs.** Better UI for visualizing what changed between two model runs over the same date range.
- **Recurring expense detection.** "Stripe charges you $X every month, here are this year's instances" — would help spot missed months.
- **Classifier accuracy reporting.** Use the `*_edited` flags to compute "the model gets vendor right 87% of the time, amount 95%" — useful for deciding when to swap models.

## Summary

**Docurator** — a Docker Compose web app written in TypeScript, designed for freelancer business use. You run `docker compose up`, open `localhost:3737`, connect one or more Gmail accounts (typical: a personal address and a business address), click Sync. Docurator **reads** every connected inbox (read-only — it can never modify, label, or delete anything in any of them), classifies every email locally via Ollama, persists confirmed receipts to a per-account folder you can browse, and discards everything else. In the review UI you confirm the model's classifications, edit any extracted fields it got wrong (vendor, amount, date), tag receipts (business / personal / per-client / per-project), and approve them. The audit view shows everything the classifier processed across all accounts, with deep-links that open each message in the right Gmail account and surfaces for catching false negatives. Export produces a zip of receipt files (organized by account, then by date) plus a structured CSV manifest you can hand to your accountant or import into accounting software, with fiscal-period presets for year-end and quarterly VAT exports. Re-classify with a different model whenever a better one comes out; old decisions stay in the log for comparison. Nothing about your email ever touches a third party. Every connected inbox is left exactly as it was found. Source on GitHub, MIT licensed, each user supplies their own OAuth credentials and Ollama install. Small enough to fit in your head, boring enough to actually finish, real enough to trust with your books.
