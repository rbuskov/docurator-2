# Slice 004: Persistent state and processed-messages log

**Status:** draft

## Observable result

I can pick a connected Gmail account on a Dashboard "Dev tools" panel, click "Mark first 10 messages as processed", restart the container with `docker compose down && docker compose up`, and see those 10 rows still attributed to the correct account.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` table (Slice 002)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002)
  - `GET /api/accounts/:id/messages?limit=50` (Slice 003) — used by the dev panel to fetch the 10 message IDs to seed
- **UI views / components:**
  - `Dashboard.tsx` at `/` (Slice 002) — extended with a Dev tools panel here
  - `Nav.tsx`, `AccountPicker.tsx` (Slice 003)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Slice 002)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/` directory (Slice 002 — the SQLite connection, the migration runner, and the migrations folder all already exist; this slice adds new migration files inside it and modifies `src/server/db/index.ts` to enable WAL)
  - `src/server/auth/accounts.ts` (Slice 002)
  - `src/server/gmail/client.ts` (Slice 003)
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/router.tsx` (Slices 001–003)
  - `data/.gitkeep` (Slice 002)
- **External services:**
  - Bind mount `./data:/app/data` from `docker-compose.yml` (Slice 002) — the SQLite file lives here, which is what makes "restart and see them still there" work
  - Gmail API access for the selected account (Slice 002 produced tokens; Slice 003 added the client)
- **Other:** —

## Deliverables (Produces)

- **DB tables / columns:**
  - `processed_messages` — `id` INTEGER PRIMARY KEY AUTOINCREMENT, `account_id` INTEGER NOT NULL REFERENCES `accounts`(`id`), `message_id` TEXT NOT NULL, `thread_id` TEXT NOT NULL, `internal_date` TEXT NOT NULL (Gmail's `internalDate`, epoch ms as string), `processed_at` TEXT NOT NULL (ISO 8601), `model_used` TEXT NOT NULL, `status` TEXT NOT NULL CHECK (`status` IN ('success','failed')), `error_message` TEXT NULL, `classification` TEXT NULL CHECK (`classification` IN ('invoice','receipt','other') OR `classification` IS NULL), `confidence` TEXT NULL CHECK (`confidence` IN ('high','medium','low') OR `confidence` IS NULL), `reason` TEXT NULL, `sender_domain` TEXT NULL, `subject` TEXT NULL. **No unique constraint on `(account_id, message_id)`** — the table is append-only, with one row per classification attempt, so re-classifying a message (Slice 010 single-row, Slice 014 batch) appends new rows without overwriting old ones (`architecture.md` § "Storage" calls this an "append-only audit log"). Indices: `(account_id, message_id, processed_at DESC)` for sync's idempotency lookup ("has this account+message been processed before?") and per-message classification history queries; `(account_id, processed_at)` for the audit-style listings future slices will build.
  - `sync_state` — `account_id` INTEGER PRIMARY KEY REFERENCES `accounts`(`id`), `last_history_id` TEXT NULL, `last_synced_at` TEXT NULL. One row per account, populated lazily.
  - `app_config` — `id` INTEGER PRIMARY KEY CHECK (`id` = 1), `fiscal_year_start_month` INTEGER NOT NULL DEFAULT 1 CHECK (`fiscal_year_start_month` BETWEEN 1 AND 12). Single-row table; the `id = 1` check enforces it.
- **Migrations:**
  - `0002_create_processed_messages.sql`
  - `0003_create_sync_state.sql`
  - `0004_create_app_config.sql` — also seeds the single row `(id=1, fiscal_year_start_month=1)`
- **API endpoints:**
  - `GET /api/accounts/:id/processed-messages?limit=50` → response `{ rows: Array<{ message_id, thread_id, internal_date, processed_at, model_used, status, classification, confidence, sender_domain, subject }> }`. Returns the most recent rows for that account, ordered by `processed_at DESC`. Used by the dev panel to display what was seeded.
  - `POST /api/dev/processed-messages/seed` — request `{ account_id: number, count: number }` (count ≤ 10). Server-side dev-only handler; returns HTTP 404 if `NODE_ENV === 'production'`. Pulls the first `count` messages for the account via the existing `gmail/client.ts`, then for each message: in a single transaction, checks `SELECT 1 FROM processed_messages WHERE account_id = ? AND message_id = ? LIMIT 1` and inserts a row only if none exists, with `status='success'`, `classification='other'`, `confidence='low'`, `model_used='dev-seed'`, `reason='inserted by dev seed button'`, populated `subject`, `sender_domain` (parsed from the `From` header), `thread_id`, `internal_date`. Returns `{ inserted, skipped }` counts. The dev seed's "skip if any prior row exists" rule is application-level idempotency — there is no DB-level unique constraint on `(account_id, message_id)`, deliberately, so future reclassification slices can append additional rows for the same message.
- **UI views / components:**
  - "Dev tools" panel inside `Dashboard.tsx` — visible only when the client detects `NODE_ENV !== 'production'` (the server exposes this via a small `GET /api/dev/enabled` boolean). Contains an `AccountPicker`, a "Mark first 10 messages as processed" button, an inline status line (`"inserted N, skipped M"`), and a small table showing the current rows from `GET /api/accounts/:id/processed-messages?limit=50`.
  - `DevSeedPanel.tsx` — the panel component itself.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `NODE_ENV` — read by both the dev API handler (gates `POST /api/dev/processed-messages/seed` and `GET /api/dev/enabled`) and the Dockerfile production stage (set to `production` automatically). Documented in `.env.example` (Slice 002's file is updated, not redelivered).
- **Files / modules:**
  - `src/server/db/index.ts` — modified to call `db.pragma('journal_mode = WAL')` and `db.pragma('foreign_keys = ON')` immediately after opening the connection. (Modification of a Slice 002 file, not a re-deliver.)
  - `src/server/db/repositories/processed_messages.ts` — `existsForMessage({ account_id, message_id })` (returns boolean — "has this account+message ever been processed?"; used by the dev seed and by Slice 006's sync to enforce idempotency at application level), `insert({ account_id, message_id, thread_id, internal_date, model_used, status, classification, confidence, reason, sender_domain, subject, error_message? })` returning the new row's surrogate `id`, `listForAccount({ account_id, limit })` (most-recent attempt per message, ordered by `processed_at DESC`), `countForAccount({ account_id })`. All methods take `account_id` explicitly; there is no global "list all" path that crosses accounts in this slice (cross-account audit views arrive in Slice 010).
  - `src/server/db/repositories/sync_state.ts` — `get(account_id)`, `upsert({ account_id, last_history_id, last_synced_at })`. Not exercised by this slice's UI but introduced now so Slice 006 can consume it without a fresh repository.
  - `src/server/db/repositories/app_config.ts` — `get()`, `update(partial)`. Not exercised by this slice's UI; introduced for Slice 011 (export) to consume.
  - `src/server/api/dev.ts` — registers `POST /api/dev/processed-messages/seed` and `GET /api/dev/enabled`. Both handlers short-circuit with HTTP 404 when `NODE_ENV === 'production'`.
  - `src/server/api/processed_messages.ts` — registers `GET /api/accounts/:id/processed-messages`
  - `src/client/views/DevSeedPanel.tsx`, `src/client/views/Dashboard.tsx` is updated to render the panel below the existing accounts list (modification, not re-deliver).
- **External services:** —
- **Other:**
  - SQLite WAL mode is now active for all DB connections (every read/write benefits, not just this slice's writes).
  - SQLite foreign-key enforcement is on (the `account_id` references in the new tables are now enforced by the engine, not just declared).

## Out of scope

- Real sync orchestrator that walks Gmail messages and writes `processed_messages` rows from real classification → Slice 006
- Ollama-based classification → Slice 005
- `documents` table and the file store under `./invoices/` → Slice 006
- Cross-account aggregate views over `processed_messages` (the Audit view) → Slice 010
- `app_config` UI (fiscal-year setting in Settings) → Slice 011
- `senders`, `tags`, `document_tags`, `review_actions`, `document_groups`, `document_group_members` tables → Slices 007 / 008 / 009 / 013
- Removing the dev seed panel from the Dashboard once the real sync ships → Slice 006

## Detailed design

This slice fills out `architecture.md` § "Storage" for everything that doesn't reference a `documents` table yet, and stands up the repository pattern (one file per table, all methods account-scoped) that future slices will plug into. WAL mode and foreign-key enforcement are turned on in the existing Slice 002 connection — both are pragmas, not migrations, so they belong in `db/index.ts` rather than a SQL file.

- **Schema choices.** Column types and constraints follow `architecture.md` § "Storage". Notable choices: dates and timestamps are stored as ISO 8601 strings (SQLite's recommended pattern with no native timestamp type), `internal_date` keeps Gmail's epoch-ms string form to preserve fidelity, and `classification`/`confidence` use `CHECK` constraints with the explicit enum values. `processed_messages.id` is a surrogate primary key (autoincrement) and `(account_id, message_id)` is **not** unique — `architecture.md` § "Storage" explicitly calls the table an "append-only audit log", and § "Reclassification" specifies that reclassification appends new rows. Application code is responsible for the "do we already have a row for this message?" check via `existsForMessage` before inserting in idempotent contexts (the dev seed here, Slice 006's sync); reclassification flows (Slices 010, 014) bypass the check and append unconditionally.
- **Why per-table migrations.** One migration per table makes the diff for each migration small and reviewable, and keeps the failure surface narrow if a single migration ever needs to be amended (which would happen via a new "fix" migration rather than editing the original — migrations are append-only).
- **WAL mode on existing connection.** Slice 002 deliberately deferred WAL because there were no concurrent writers to benefit from it. Slice 006's sync orchestrator will produce concurrent reads (UI polling progress) and writes (per-message inserts), so this slice turns WAL on now to avoid mixing the change with the larger sync work later.
- **Foreign keys.** SQLite's default is `foreign_keys = OFF`. This slice flips it on, which retroactively enforces the `account_id REFERENCES accounts(id)` declared on the new tables — and on `accounts` itself, though that table has no FK columns. Existing data was created without FK enforcement; nothing breaks because the only existing data is `accounts` rows with no FKs.
- **Repository pattern.** Each repository is a small TypeScript module that imports the singleton `db` and exports prepared-statement-backed methods. No ORM. Returned shapes are plain TypeScript types, not class instances, so call sites can pass them across module boundaries without entangling DB types in unrelated code. Account scoping is enforced at the method signature level — there is no `list({ limit })` without an account; the only cross-account method that ships in this slice is `app_config.get()` (which is install-wide by design).
- **Dev panel scope.** The panel is the smallest possible thing that makes the observable result observable. Picker → button → status → 50-row table. No styling beyond what fits next to the existing Dashboard. The button is gated server-side (404 in production) and additionally hidden client-side (the panel only renders when `GET /api/dev/enabled` returns `true`), so production users cannot trigger it via the UI even if they discover the URL. This satisfies "doesn't ship to production" without conflating the dev tool with real product surface.
- **Why the dev panel pulls real Gmail message ids.** Seeding fake message ids would not exercise the application-level idempotency check or the `subject`/`sender_domain` extraction, so the value of the slice (proving the round-trip works for real data) would shrink. The Slice 003 client is already constrained to read-only Gmail endpoints; using it for dev seeding does not break the read-only guarantee or the build-time guard.
- **Subject and sender retention.** `processed_messages` stores `subject` so the Audit view (Slice 010) can show "what email the model decided about" without re-fetching from Gmail. The architecture's note that this can be toggled off in settings is deferred to Slice 016 polish; this slice always stores subject. Email *body* and attachment content are never stored in `processed_messages` — that constraint belongs to all future slices that touch the table.

## Acceptance criteria

- After `docker compose up --build`, opening the SQLite database (e.g. `sqlite3 data/app.db ".schema"`) shows tables `accounts`, `processed_messages`, `sync_state`, `app_config`, plus the migration-tracking table from Slice 002.
- Running `sqlite3 data/app.db "PRAGMA journal_mode;"` returns `wal`. Running `PRAGMA foreign_keys;` returns `1`.
- The Dashboard renders a "Dev tools" panel in development. Picking a connected account and clicking "Mark first 10 messages as processed" responds within a few seconds with `inserted: 10, skipped: 0` (assuming the account has at least 10 messages).
- The dev panel's table immediately refreshes to show 10 rows for that account, each with the message's real `subject` and a `sender_domain` extracted from the `From` header (e.g. `stripe.com`), `model_used='dev-seed'`, `classification='other'`, `confidence='low'`, `status='success'`.
- Re-clicking the seed button on the same account and the same 10 messages responds with `inserted: 0, skipped: 10` and the row count stays at 10.
- Selecting a *different* connected account, clicking the seed button, and inspecting `data/app.db` shows 10 additional rows whose `account_id` matches the second account; the first account's 10 rows are unchanged.
- After `docker compose down` and `docker compose up`, the dev panel's table for each previously-seeded account still shows the same rows.
- In a build with `NODE_ENV=production`, `GET /api/dev/enabled` returns 404 and the dev panel does not render. `POST /api/dev/processed-messages/seed` also returns 404.
- `app_config` contains exactly one row with `fiscal_year_start_month=1` after first migration application; subsequent restarts do not re-insert the row.
- The build-time read-only Gmail check (Slice 003) still passes after this slice's changes.

## Risks / open questions

- **Append-only `processed_messages` (no DB-level uniqueness on `(account_id, message_id)`).** Idempotency for sync (Slice 006) and the dev seed here is enforced by an application-level `existsForMessage` check inside the same transaction as the insert. Concurrent sync runs against the same account are not currently planned (Slice 006 enforces a single-job mutex), so the check-then-insert race is moot. If concurrency requirements change, the check would need to either acquire a per-`(account_id, message_id)` advisory lock or move into a unique-on-conflict pattern with a separate idempotency-key table. Flag for confirmation; this design choice ripples into Slice 006's sync orchestrator (SELECT-then-INSERT) and Slice 006's `documents` foreign-key strategy (cannot be a composite FK to `processed_messages(account_id, message_id)` because no such unique key exists — see the next iteration's gap fix).
- **Bundling NODE_ENV detection client-side.** The client checks `GET /api/dev/enabled` rather than relying on a Vite-time `import.meta.env.MODE` flag, so the production image cannot leak the dev panel even if `NODE_ENV` is mis-set during `vite build`. Provisional choice; flag if this seems over-engineered for the dev surface.
- **Removing the dev seed panel.** Slice 006 supersedes the panel's purpose. Two options: (a) delete the panel as part of Slice 006, (b) leave it as a lower-frequency dev tool. Provisional: (a) — Slice 006's spec will list `DevSeedPanel.tsx` as a removed file. Flag.
- **`app_config` single-row enforcement.** The `CHECK (id = 1)` is a simple guard but doesn't prevent application code from forgetting to seed it. The migration's `INSERT OR IGNORE INTO app_config(id, fiscal_year_start_month) VALUES (1, 1);` is the safety net. Flag if a more robust pattern is preferred (e.g. a view that always exposes a row).
- **Migration order vs FK enforcement.** With `foreign_keys = ON`, the order of migrations matters: `processed_messages` and `sync_state` reference `accounts(id)`, which already exists from Slice 002, so 0002 and 0003 apply cleanly. If a future slice wants to alter `accounts` in a way that breaks an existing FK, it'll need to disable FKs for that migration — standard SQLite migration practice. Flag for awareness.
- **WAL files on the bind mount.** WAL mode produces `app.db-wal` and `app.db-shm` sibling files inside `./data`. The Slice 002 `.gitignore` already covers `data/`, so they aren't committed. Backup tooling should pick them up automatically as part of the directory; the README's eventual "Backup recommendations" section (Slice 016) should mention this.
- **Pre-existing rows during migration.** The first time this slice's migrations run on a Slice 002–shaped DB, there are zero rows in `processed_messages`/`sync_state`/`app_config`, so no data migration is needed. If a user somehow had rows already (e.g. ran an out-of-band SQL script), this migration would not detect or migrate them. Acceptable for a not-yet-released project.
