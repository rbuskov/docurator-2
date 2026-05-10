# Slice 004: Persistent state and processed-messages log — Research

**Spec:** `docs/specs/004-persistent-state-and-processed-messages-log.md`

## Summary of what the spec asks for

The slice fills out `docs/architecture.md` § "Storage" for everything that doesn't yet need a `documents` table: it adds three SQLite tables (`processed_messages`, `sync_state`, `app_config`) via three new bare-SQL migrations, flips WAL + foreign-keys on the existing `getDb()` connection, stands up the repository pattern (one module per table, account-scoped methods on prepared statements), and wires a development-only "Dev tools" panel to the Dashboard that writes 10 rows into `processed_messages` for the picked account using the existing Gmail read client. The Observable result is "click the seed button on Dashboard → see the rows; restart the container with `docker compose down && docker compose up` → the rows are still there, attributed to the right account." Headline deliverables are the migrations `0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql`; three repositories (`processed_messages.ts`, `sync_state.ts`, `app_config.ts`); two new API surfaces (`POST /api/dev/processed-messages/seed`, `GET /api/dev/enabled`, `GET /api/accounts/:id/processed-messages`); and a `DevSeedPanel.tsx` rendered inside the existing `Dashboard.tsx` only when `GET /api/dev/enabled` returns `true`.

## Existing code that this spec touches

What's actually in the tree today (post-Slice 003):

- `src/server/db/index.ts` — exports `getDb()` (lazy singleton over `better-sqlite3`) and `setDbPathForTest()`. **Modify here** to call `db.pragma('journal_mode = WAL')` and `db.pragma('foreign_keys = ON')` immediately after opening the connection. Both happen once per process; the test setter closes + reopens the DB, so the new test path goes through the same constructor and the pragmas re-apply. No structural change beyond the two pragma calls.
- `src/server/db/migrate.ts` — applies `*.sql` files from a directory in lexical order, idempotent, transactional per file. **No changes** — migrations 0002/0003/0004 just drop into `src/server/db/migrations/` and the existing runner picks them up. ADR-002 pinned this contract; new slices add files, never edit existing migrations.
- `src/server/db/migrations/0001_create_accounts.sql` — the existing `accounts(id, email, display_name, slug, connected_at, last_seen_at, status)` schema. The new tables reference `accounts(id)` via FK; with `foreign_keys = ON` flipped on, those references become enforced at runtime. **No edit** — append-only migration discipline.
- `src/server/index.ts` — already calls `migrate(getDb(), migrationsDir)` before `serve(...)`. **No change** — the new migrations apply on the next process start without any wiring code.
- `src/server/app.ts` — `createApp()` registers `/health`, accounts, oauth, messages, then the optional static fallback. **Edit here** to insert `registerDevRoutes(app)` and `registerProcessedMessagesRoutes(app, deps?)` between the existing message route and the static fallback so they precede the catch-all `*`. The factory pattern (`registerXxxRoutes(app, deps?)`) used by `registerMessagesRoutes` is the established shape.
- `src/server/api/messages.ts` — already builds the Gmail client per request, gates on `account.status === 'connected'` + `session.get(id) !== undefined`, sequentially fetches headers via `getMessage(id, { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })`, and unwraps headers via a private `extractHeader` helper. The dev seed endpoint reuses **all** of this: same auth/session preconditions, same Gmail call shape, same header extraction. The decision is whether to pull the helper into a shared module or to duplicate the four-line lookup; see "Patterns to follow".
- `src/server/gmail/client.ts` — `createGmailClient(accountId): { listMessages, getMessage }`. **No change** — both methods are reused as-is from the dev seed handler. Read-only Gmail discipline (Slice 003) is unchanged; the build-time check still passes because no new Gmail-write substring is introduced.
- `src/server/auth/accounts.ts` — `findById`, `updateStatus`, etc. The dev seed handler reuses `findById` to validate the request's `account_id` and to enforce `status === 'connected'`. **No change**.
- `src/server/auth/session.ts` — `get(id)` (in-memory token presence check) and `withFreshTokens` (used implicitly via `createGmailClient`). **No change**.
- `src/server/config.ts` — frozen snapshot of `port`, `googleClientId`, etc. **Optional addition:** a `nodeEnv: process.env.NODE_ENV ?? 'development'` field, so the dev gate is read at module load and consistent across handlers (and trivially overridable in tests via `vi.resetModules()` like the existing OAuth env vars). Without it, handlers each read `process.env.NODE_ENV` directly. The plan picks one in the first repository step; either works.
- `src/client/views/Dashboard.tsx` — currently renders the Slice 002 account list + AddAccountButton inside `<main>`. **Edit here** to render `<DevSeedPanel />` below the existing children when the dev gate is on. The component itself fetches `/api/dev/enabled` once on mount; if the response says `false` (production) or 404s, the component returns `null` and the Dashboard looks unchanged. Pattern matches how `AccountList` and `AddAccountButton` are both children of `<main>` today — DevSeedPanel slots in as a third child.
- `src/client/components/AccountPicker.tsx` — the disabled-on-needs-reauth `<select>` from Slice 003. **Reuse as-is** inside `DevSeedPanel`. The picker already supports `includeDisconnected={false}` to filter out `needs_reauth` rows entirely; the dev panel passes `false` because seeding requires a live Gmail call.
- `src/client/api.ts` — `getJson<T>` and `postJson<T>`. **Reuse**.
- `src/client/types.ts` — exports `Account` and `Message`. **Edit here** to add a `ProcessedMessage` type matching the API response shape, alongside the existing types. Pattern matches Slice 003's choice to keep all client-side domain types in this one file.
- `src/server/app.test.ts`, `src/server/api/messages.test.ts`, `src/server/auth/accounts.test.ts` — existing patterns the new tests follow verbatim: `mkdtempSync` + `setDbPathForTest()` + `migrate()` per `beforeEach`, then either direct repository calls or `app.fetch()` against a freshly built `Hono()` instance with injected fakes. **No edits** to existing tests.
- `vitest.workspace.ts` — already includes `src/server/**/*.test.ts` for the server project and `src/client/**/*.test.{ts,tsx}` for the client project. **No change** — new tests slot in.
- `package.json` — runtime deps `better-sqlite3`, `googleapis`, `react`, `react-router-dom@^6` already present from Slices 001-003. **No new deps.** The `check:gmail-readonly` build step still runs and still passes.
- `.env.example` (added in Slice 002) — already mentions `NODE_ENV` indirectly via `docker-compose.yml`. The spec asks for documenting that dev-only handlers gate on `NODE_ENV !== 'production'`. **Edit here** to add a one-line comment under the existing entries; a fresh delivery is not required.
- `.gitignore` — already ignores `*.db-wal` and `*.db-shm`. WAL files inside `./data/` are doubly covered (the directory is gitignored). **No change.**
- The deleted root `Dockerfile` / `docker-compose.yml` — historically the spec calls out `docker compose down && docker compose up` as the Observable-result restart trigger. The Dec 9 commit (`switch local dev to a Claude Code devcontainer`) deleted both. The slice's smoke-test recipe substitutes a devcontainer-aware restart (kill the `npm run dev` process, restart it; or for a closer-to-prod check, `node dist/server/index.js` after `npm run build` against the same `data/app.db`). The spec's Observable result is preserved in spirit — the row persistence across process restarts on the same bind-mounted DB is what's tested, not the specific Docker subcommand.

Files / modules the spec creates from scratch (no existing analogue):

- `src/server/db/migrations/0002_create_processed_messages.sql`
- `src/server/db/migrations/0003_create_sync_state.sql`
- `src/server/db/migrations/0004_create_app_config.sql`
- `src/server/db/repositories/processed_messages.ts`
- `src/server/db/repositories/sync_state.ts`
- `src/server/db/repositories/app_config.ts`
- `src/server/api/dev.ts`
- `src/server/api/processed_messages.ts`
- `src/client/views/DevSeedPanel.tsx`
- The corresponding `*.test.ts` / `*.test.tsx` files
- (Optionally) `src/server/gmail/headers.ts` if the `extractHeader` helper is promoted out of `messages.ts` — see "Refactors needed below"

## Patterns to follow

The slice introduces a small number of new patterns; most reuse what Slices 002-003 already established.

- **Per-table migrations.** One `*.sql` file per table, named `NNNN_create_<table>.sql` matching Slice 002's `0001_create_accounts.sql`. ADR-002 pins the bare-SQL discipline; migrations are append-only (never edited) and transactional per file. Column types follow `docs/architecture.md` § "Storage" verbatim — ISO 8601 strings for timestamps, `internal_date` as Gmail's epoch-ms string form, `CHECK` constraints with the explicit enum values for `status` / `classification` / `confidence`. Primary keys are surrogate `INTEGER PRIMARY KEY AUTOINCREMENT` for the append-only `processed_messages`, plain `INTEGER PRIMARY KEY` (the FK to `accounts.id`) for `sync_state`, and the literal `id INTEGER PRIMARY KEY CHECK (id = 1)` for the single-row `app_config`. The `app_config` migration also seeds the row with `INSERT OR IGNORE INTO app_config(id, fiscal_year_start_month) VALUES (1, 1);` so a re-run on an existing DB is a no-op.

- **WAL + FK pragmas in `getDb()`.** The two pragmas live next to the `new Database(...)` call inside `getDb()`. Order: `journal_mode = WAL` first, then `foreign_keys = ON`. WAL mode is a sticky property of the DB file (persists across opens) but `foreign_keys` must be re-asserted on every connection — both go in the same place to keep the contract obvious. Tests that open temporary DBs go through the same `setDbPathForTest` → `getDb()` path and so inherit both pragmas; the existing `accounts` integration tests stay green because pragmas are additive and the existing schema/data don't violate FK declarations. Architecture-level: this is **the** moment WAL turns on for the install — Slice 002 deliberately deferred it. The decision is small but durable; it does not warrant a new ADR (architecture.md already names WAL as the runtime mode and Slice 004's spec chose the moment to flip it).

- **Repository layer (`src/server/db/repositories/<table>.ts`).** Same shape as `src/server/auth/accounts.ts`: a `WeakMap<Database.Database, Map<string, Database.Statement>>` cache, a `stmt(db, key, sql)` helper that lazily prepares + caches, plain functions per query that call `getDb()` and return rows shaped as plain TypeScript types matching column names. **Crucially**, the slice relocates the canonical home for the repository pattern from `src/server/auth/` to `src/server/db/repositories/` (`docs/architecture.md` § "Project structure" already names this directory). Slice 002's `accounts.ts` lives under `auth/` for historical reasons and stays there for now — moving it would touch every Slice 002/003 import site for no current functional benefit. The split is documented in the review's "Decisions worth flagging" so a future slice can consolidate. **Repositories for this slice:**
  - `processed_messages.ts` — `existsForMessage({ account_id, message_id }): boolean` (used by the dev seed and Slice 006's sync), `insert(input): number` (returns the new row's surrogate `id`), `listForAccount({ account_id, limit }): ProcessedMessage[]` (most-recent first by `processed_at DESC`), `countForAccount({ account_id }): number`. All methods take `account_id` explicitly; there is no global `list({ limit })` that crosses accounts. The `ProcessedMessage` type matches the column set verbatim. **Insert column set:** `account_id`, `message_id`, `thread_id`, `internal_date`, `processed_at`, `model_used`, `status`, `classification`, `confidence`, `reason`, `sender_domain`, `subject`, `error_message`. The handler (not the repo) decides defaults — the repo accepts every field as a typed parameter and writes them; nullable columns accept `null`.
  - `sync_state.ts` — `get(account_id): SyncState | undefined`, `upsert({ account_id, last_history_id, last_synced_at }): void` using `INSERT INTO sync_state ... ON CONFLICT(account_id) DO UPDATE SET ...`. Not exercised by this slice's UI but introduced now so Slice 006 consumes it without a fresh repository.
  - `app_config.ts` — `get(): AppConfig` (always returns the singleton row, throws if it's missing — that's a migration bug), `update(partial: Partial<{ fiscal_year_start_month: number }>): void`. Not exercised by this slice's UI but introduced for Slice 011.

- **Repository tests (server, Node env).** Mirror `src/server/auth/accounts.test.ts`: `mkdtempSync` for a temp dir, `setDbPathForTest(join(tempDir, 'test.db'))`, `migrate(getDb(), migrationsDir)`, then call repo functions directly and assert on results. Each `beforeEach` resets modules with `vi.resetModules()` + dynamic `import()` so prepared-statement caches don't leak between tests (the cache key is the `Database` instance and modules re-import fresh). Tests do **not** mock SQLite — they exercise real `better-sqlite3` against a temp DB.

- **API endpoint factories (`src/server/api/<name>.ts`).** Same shape as `registerMessagesRoutes(app, deps?)`: a function that takes the `Hono` app and an optional deps object whose default values point at the production implementations. The deps object exists so tests can inject fakes (a fake `createGmailClient` for `dev.ts`'s seed handler). Validation rules: positive-integer `:id` parsed via `Number()` + `Number.isInteger(...)`, `?limit=` clamped (default 50, max 50 per the spec — this slice's limit is `≤ 50` for `GET /api/accounts/:id/processed-messages`, separate from the dev seed's separate `count ≤ 10` rule). Error response shape is `{ error: 'kebab-case-code', ...details? }` matching Slice 002/003.
  - **`POST /api/dev/processed-messages/seed`** — body `{ account_id: number, count: number }`. Handler:
    1. If `process.env.NODE_ENV === 'production'` → 404. (Hono's default 404 is fine; the body is empty per the spec's "404 in production" wording.)
    2. Validate body shape: `account_id` positive integer, `count` integer in `[1, 10]`. 400 on miss with `{ error: 'invalid_body' }` plus a short detail string.
    3. `findById(account_id)` → 404 with `{ error: 'account_not_found' }`.
    4. Status check + session check identical to `messages.ts` — 409 `{ error: 'account_not_connected', status }` on `needs_reauth`, and the additional status-flip on missing in-memory session.
    5. `client.listMessages({ maxResults: count })` returns `{ messages: [...] }`.
    6. For each message: `client.getMessage(id, { format: 'metadata', metadataHeaders: ['Subject', 'From'] })` (Date is unnecessary — we keep `internalDate` from the SDK return value). Inside a single `db.transaction(() => { … })`: `existsForMessage({ account_id, message_id })` → if true, `skipped++`; else `insert({...})` with `model_used: 'dev-seed'`, `classification: 'other'`, `confidence: 'low'`, `reason: 'inserted by dev seed button'`, `status: 'success'`, `processed_at: new Date().toISOString()`, `error_message: null`. Sender domain comes from a small `extractDomain(fromHeader): string | null` helper (regex-free: split on `<`, take the part with `@`, take the segment after `@`, strip a trailing `>`; lowercase the domain; return `null` if not parseable).
    7. Response: `{ inserted, skipped }`.
    8. Gmail error handling matches `messages.ts`: `invalid_grant` → 401 `{ error: 'needs_reauth', account_id }`, anything else → 502 `{ error: 'gmail_error', message }`.
  - **`GET /api/dev/enabled`** — same NODE_ENV gate (404 in production), otherwise returns `{ enabled: true }` with status 200. Trivial handler, single test.
  - **`GET /api/accounts/:id/processed-messages`** — `:id` validation + `findById` + status check identical to messages. Response shape per spec: `{ rows: Array<{ message_id, thread_id, internal_date, processed_at, model_used, status, classification, confidence, sender_domain, subject }> }`. **This endpoint is not gated on NODE_ENV** — it's part of the read API the dev panel uses, but a future slice might consume it from the Audit view (Slice 010) without needing dev-only behavior. The spec is silent on this; the plan picks "not gated" because gating production reads of audit data is a wider question that Slice 010 will answer authoritatively. **Decision flagged for the review.**

- **Status checks split between API and repository.** The repository functions assume callers have already validated the account exists (they take `account_id` as an integer). The Hono route does the validation. Same separation Slice 003's `messages.ts` uses against `accounts.findById`.

- **NODE_ENV gating split between API and UI.** The server gate (404 in production for `/api/dev/...`) is the canonical enforcement; the client gate (panel renders `null` when `GET /api/dev/enabled` returns 404) is a UX-only nicety. The spec explicitly forbids the alternative ("client gates on `import.meta.env.MODE`") — production images can have a mis-set NODE_ENV at `vite build` time, and a server-side gate is the only stable enforcement.

- **`extractHeader` helper.** Slice 003 defined this as a private helper inside `src/server/api/messages.ts`. The dev seed needs the same logic for `Subject` and `From`. Two options: (a) duplicate the four-line function, (b) promote it to `src/server/gmail/headers.ts` and import in both places. Plan picks **(b)** — the helper is small and already needs to grow a `parseFromAddressDomain(value)` sibling for the dev seed's `sender_domain` extraction; colocating both functions is cleaner than two ad-hoc copies. The Slice 003 file becomes a one-line import edit; the existing tests stay green because behavior is unchanged. **Refactor flagged below.**

- **Dev panel (`src/client/views/DevSeedPanel.tsx`).** Component-level state: `{ enabled, accounts, selectedAccountId, status, table, error }`. Lifecycle:
  - On mount: `getJson('/api/dev/enabled')`. On 404 / non-`enabled`: set `enabled=false`, render nothing. On 200: set `enabled=true` and proceed.
  - On enabled: `getJson('/api/accounts')` → set `accounts`. Pre-select the first `connected` account if any.
  - When `selectedAccountId` changes: refresh the table via `getJson('/api/accounts/:id/processed-messages?limit=50')` → set `table` (newest-first rows).
  - On click "Mark first 10 messages as processed": `postJson('/api/dev/processed-messages/seed', { account_id, count: 10 })`. On success: set status line `inserted N, skipped M` and refetch the table. On 401 (`needs_reauth`): "This account needs to be reconnected — go to the Dashboard." On 502: "Gmail returned an error: {message}. Try again." On 409: "Account not currently connected — try Reconnect on Dashboard."
  - The "table" is a small 50-row `<table>` with columns `Subject / Sender / Processed at / Classification / Confidence / Model`. No styling beyond what `Dashboard.tsx` already uses (no Tailwind classes added for this — sticking to plain HTML matches the rest of the slice-003 surface).
  - Rendering condition: `enabled === true && accounts !== null`. Loading state: `<p>Loading…</p>`. No empty state when there are zero connected accounts — render the picker (which itself shows the "no connected accounts" message via Slice 003's `AccountPicker`).
- **Dashboard integration.** `Dashboard.tsx` adds `<DevSeedPanel />` as the third child of its `<main>`. The panel is fully self-contained — no props from Dashboard, no state lifted up. If the panel returns `null` (production), the Dashboard renders identically to today.

- **Test seam for the dev seed handler.** The handler's only external collaborators are `getDb()` (real, against a temp DB) and `createGmailClient` (faked via the deps object). Tests don't need to fake repositories — they call the real `processed_messages.ts` functions against the temp DB. The Gmail fake returns synthetic `Schema$Message` objects with the metadata-header shape `messages.ts` already expects.

- **Client tests (`DevSeedPanel.test.tsx`).** Stub `fetch` (or the `getJson`/`postJson` helpers) to return canned responses; render the component under `<MemoryRouter>` (defensive — component doesn't currently use `<Link>` but Dashboard might add Reconnect navigation later). Cases: `/api/dev/enabled` → 404 renders nothing; `/api/dev/enabled` → 200 + `/api/accounts` → 0 connected accounts renders the picker's empty state; happy-path seed renders `inserted 10, skipped 0`; second click renders `inserted 0, skipped 10`; 401 path renders the needs-reauth message.

- **App-level integration test.** `src/server/app.test.ts` already verifies `/health` and the static fallback. **No edit needed** — the new routes don't require app-level coverage beyond the unit tests for each handler. If the existing test suite contains a "non-API path falls through to static" assertion, the dev routes must come before the static fallback in `createApp` (they do, by the same ordering as Slice 003).

## Refactors needed before adding the new feature

Three small ones, none big enough to be a separate slice:

- **Promote `extractHeader` from `src/server/api/messages.ts` to `src/server/gmail/headers.ts`.** Move the four-line helper, add a colocated `parseFromAddressDomain(value: string): string | null` for sender-domain extraction, and replace the in-file definition with an import. `messages.ts`'s tests don't exercise `extractHeader` directly so they stay green; a small new `headers.test.ts` covers the extracted helpers. Justification: this slice needs both helpers; centralizing now avoids two duplicated implementations.
- **Add `nodeEnv` to `src/server/config.ts`.** A single new field `nodeEnv: process.env.NODE_ENV ?? 'development'`. Existing code doesn't use it; the dev handler reads it. Justification: same reason `googleClientId`/`googleClientSecret` live in `config.ts` rather than being read inline — the handlers stay testable via `vi.resetModules()` + mutating `process.env` in `beforeEach`.
- **Wire `registerDevRoutes` and `registerProcessedMessagesRoutes` into `src/server/app.ts`.** Single line each. The existing route order is `/health` → accounts → oauth → messages → static fallback; the dev/processed-messages routes slot in between messages and the static fallback. Tests for `app.test.ts` continue to pass — they don't exercise dev routes, but the static-fallback test still hits the catch-all because the new routes are more specific.

Two refactors deliberately *not* done in this slice:

- **Consolidate `auth/accounts.ts` under `db/repositories/`.** The current location is historical (Slice 002 only had one repository). Moving it touches every importer (six files at last count) for zero functional gain. Flagged as a follow-up.
- **Migrate `messages.ts`'s sequential `getMessage` loop to a shared utility.** The dev seed reuses the same fetch shape, but the loop is 12 lines and lifting it would add an abstraction with one caller (the seed) plus a tiny wrapper around the existing call site. Inlining matches "three similar lines is better than a premature abstraction"; Slice 006's sync orchestrator is where a real shared pipeline lives.

## Risks and open questions

- **`PRAGMA journal_mode = WAL`'s persistence behavior.** WAL is a sticky DB property: once set, the DB file is in WAL until explicitly changed back. On a freshly created `app.db` (Slice 002 baseline), the first `getDb()` call after this slice flips the file. On an existing DB (e.g. a developer who ran Slice 002, populated rows, then upgraded to Slice 004), the same first call flips that existing file too — atomic, no rollback risk. The `*.db-wal` and `*.db-shm` sibling files appear in `./data/`, already gitignored. Acceptance criterion: `sqlite3 data/app.db "PRAGMA journal_mode;"` returns `wal`. Confirmed safe; nothing further to investigate.

- **`PRAGMA foreign_keys = ON` retroactivity.** SQLite's default is OFF. The pragma is a per-connection setting; `getDb()` sets it on every open. The `accounts(id)` references declared on `processed_messages.account_id` and `sync_state.account_id` become enforced at runtime. The existing data (a few `accounts` rows from Slice 002 testing) has no FK columns, so existing data violates nothing. Future migrations that need to alter referenced columns will need to disable FKs locally for that migration — standard SQLite practice; not relevant for this slice.

- **`AUTOINCREMENT` on `processed_messages.id`.** Distinct from plain `INTEGER PRIMARY KEY` (which assigns `MAX(id) + 1` on insert and reuses freed values). `AUTOINCREMENT` guarantees monotonically increasing ids and forbids reuse — the trade-off is a small write-time overhead and a `sqlite_sequence` table SQLite manages internally. The architecture's "append-only audit log" framing motivates `AUTOINCREMENT`: a future query like "show me the most recent 50 attempts" wants the surrogate id to be a stable creation order, not a reused-after-delete id. Spec says `AUTOINCREMENT`; honoring it.

- **`docker compose`-based smoke wording in the spec.** The spec's Observable result and several acceptance criteria reference `docker compose down && docker compose up` and `docker compose up --build`. The Dec 9 commit deleted `Dockerfile` and `docker-compose.yml` in favor of a Claude Code devcontainer. The smoke test in this slice's plan substitutes a process restart against the same bind-mounted `data/app.db` — the spec's *intent* (rows persist across restart on the same on-disk DB) is preserved. The plan calls this out so the human can spot the substitution; the review's "Deviations from spec or architecture" section will repeat it. **This does not change any deliverable** — the SQLite file's persistence is what's actually being verified, and that property is independent of the harness.

- **`NODE_ENV=production` smoke check.** The spec's AC #7 ("In a build with `NODE_ENV=production`, `GET /api/dev/enabled` returns 404 …") needs a build-mode test. Two options: (a) `npm run build && NODE_ENV=production node dist/server/index.js` against the bind-mounted `data/app.db`, exercising the production path end-to-end; (b) a unit test that calls the handler with `process.env.NODE_ENV` set to `'production'` and asserts the 404. Plan does both: (b) as a regular vitest case, (a) as a smoke step. The unit test catches the wiring; the smoke test catches "the build pipeline didn't accidentally bake NODE_ENV in wrong."

- **Sequential `getMessage` calls and Gmail rate limits.** The dev seed issues 1 + 10 = 11 Gmail calls per click (one `listMessages`, ten `getMessage`s). Gmail's per-user quota is 250 quota units / second / user; a `messages.get(format=metadata)` is 5 units, `messages.list` is 5 units → 55 units total, well within quota. No batching needed.

- **Concurrent dev-seed clicks.** The handler is not idempotency-protected at the request level — two simultaneous clicks would issue two Gmail-fetch loops. The application-level `existsForMessage` check inside each per-message transaction means the second call sees the first call's inserted rows and counts them as `skipped`. Net effect: `inserted N + 0`, `skipped 0 + 10`. No DB corruption. Race timing where both calls find the row missing and both insert? `existsForMessage` runs inside the same transaction as `insert`, and `better-sqlite3` is synchronous + single-threaded inside the Node process; there is no concurrent JS execution between the two SQL statements. Genuinely safe.

- **The `sender_domain` extraction.** Gmail's `From` header values look like `Sender Name <sender@example.com>`, sometimes `sender@example.com` bare, occasionally with comments or quoted display names. A regex-free parser ("split on `<`, take the segment containing `@`, slice after `@`, strip trailing `>`, lowercase") covers the common cases. Pathological inputs (group syntax `Group: a@x.com, b@y.com;`, encoded MIME words) return `null`; the dev seed inserts the row with `sender_domain: null` rather than failing. Spec accepts `sender_domain TEXT NULL`. Flagged so the review can record the parser's coverage caveat.

- **`subject` retention vs the architecture toggle.** `docs/architecture.md` § "Storage" notes that subject retention is "kept for the audit UI; toggleable in settings." The toggle lives in Slice 016. This slice unconditionally stores `subject`. Email body and attachments are never stored in `processed_messages` — that constraint is upheld; only the `Subject` header value lands.

- **`app_config` read of a missing row.** The migration's `INSERT OR IGNORE INTO app_config(id, fiscal_year_start_month) VALUES (1, 1);` runs unconditionally. The runner is transactional per file; the seed is part of the migration's transaction. So a fresh DB after migration always has the row. `app_config.get()` throws if the row is missing because that's a migration-runner bug — not a runtime case to gracefully handle.

- **`POST /api/dev/processed-messages/seed`'s `count` parameter.** Spec says `count ≤ 10`. The handler clamps; values >10 → 400. Alternative: silently clamp to 10. Plan picks 400 to match Slice 003's strictness on `?limit=` (400 on out-of-range).

- **`getMessage(id, { format: 'metadata' })` payload.** Returns `internalDate` as a string of epoch milliseconds. Spec stores `internal_date TEXT NOT NULL`, matching that encoding. If `internalDate` is missing for a message (extremely unusual for a real Gmail account), the seed inserts an empty string. **Decision flag:** treat `null`/`undefined` `internalDate` as "unexpected — refuse to insert" or "tolerate — insert empty string"? Plan picks the latter for symmetry with Slice 003's `internal_date: ''` fallback in the `/messages` listing; flagged for the review.

- **Repository placement under `src/server/db/repositories/` vs `src/server/auth/`.** Slice 002 placed `accounts.ts` under `auth/` because it was part of the OAuth flow. Architecture's project structure puts repositories under `db/repositories/`. The slice creates the directory and follows the architecture; `accounts.ts` stays where it is. **Decision flag for review:** the inconsistency is intentional but worth a follow-up note.

- **No ADR for this slice.** None of the decisions cross the "architecturally significant" bar that ADR-002 set: WAL + FK pragmas are explicitly named in `architecture.md` § "Tech stack" / § "Data retention and backup", append-only `processed_messages` is named in § "Storage", the repository pattern is named in § "Project structure", and the dev panel is a one-slice-only scaffold the spec marks for removal in Slice 006. The judgment calls (sequential vs batched Gmail fetches, helper-promotion location, repository directory placement) are routine implementation choices. Flagged here so the priority-3 ADR check returns "no ADR needed."

## Test strategy

Following the loop's "TDD where applicable" rule. Server tests go under `src/server/...` (vitest workspace 'server', Node env), repository tests against a real temp SQLite DB, route tests via `app.fetch()` against a freshly built `Hono()` with fake deps, client tests under `src/client/...` (vitest workspace 'client', jsdom + RTL).

**Unit tests planned (vitest, Node env):**

- `src/server/db/index.test.ts` — extend the existing tests (or add new cases): after `setDbPathForTest` + `getDb()`, `db.pragma('journal_mode', { simple: true })` returns `'wal'` and `db.pragma('foreign_keys', { simple: true })` returns `1`. Existing test for `getDb` returning a singleton stays green.

- `src/server/db/migrations.test.ts` — extend (or add a new sibling `migrations-004.test.ts`): apply all migrations against a temp DB, then introspect via `db.prepare("SELECT name FROM sqlite_master WHERE type='table'")` to assert `accounts`, `processed_messages`, `sync_state`, `app_config`, and `_migrations` exist; assert `processed_messages` has the expected column set + CHECK constraints (use `PRAGMA table_info(processed_messages)` and `PRAGMA foreign_key_list(processed_messages)`); assert `app_config` has exactly one row with `fiscal_year_start_month = 1`. A re-run of `migrate()` does not duplicate the seed row (`INSERT OR IGNORE` semantics).

- `src/server/db/repositories/processed_messages.test.ts`
  - `existsForMessage` returns false when the row doesn't exist; true after `insert`; remains true after a second `insert` with different `processed_at` (the function asks "any row?", not "exactly one").
  - `insert` returns the new surrogate id; the row is readable via `listForAccount` with all fields preserved (including nullable `error_message`, `classification`, `confidence`, `reason`).
  - `insert` rejects rows with a `status` outside the CHECK enum (lets the DB reject; the test uses `expect().toThrow()`).
  - `listForAccount({ account_id, limit })` returns rows ordered `processed_at DESC`, scoped to the account (a row inserted under another `account_id` is invisible).
  - `listForAccount` respects `limit`; calling with `limit=2` against three rows returns the two newest.
  - `countForAccount` returns 0 for an account with no rows; matches the actual count after inserts.
  - FK constraint: inserting with an `account_id` that doesn't exist in `accounts` throws (verifies `foreign_keys = ON` is wired).

- `src/server/db/repositories/sync_state.test.ts`
  - `get(account_id)` returns `undefined` until `upsert` runs; returns the inserted row after.
  - `upsert` updates `last_history_id` + `last_synced_at` on a second call without inserting a duplicate row.
  - Inserting with a non-existent `account_id` throws (FK enforcement).

- `src/server/db/repositories/app_config.test.ts`
  - After migration, `get()` returns `{ id: 1, fiscal_year_start_month: 1 }`.
  - `update({ fiscal_year_start_month: 7 })` flips the value; subsequent `get()` returns 7.
  - `update({ fiscal_year_start_month: 13 })` throws (CHECK enforcement).

- `src/server/api/dev.test.ts`
  - `GET /api/dev/enabled` returns 200 `{ enabled: true }` when `NODE_ENV !== 'production'`.
  - `GET /api/dev/enabled` returns 404 (and no body) when `NODE_ENV === 'production'`.
  - `POST /api/dev/processed-messages/seed` returns 404 in production.
  - Body validation: missing `account_id` → 400 `{ error: 'invalid_body' }`; `count = 11` → 400; `count = 0` → 400; `count = 10` → accepted.
  - `account_id` not in DB → 404 `{ error: 'account_not_found' }`.
  - Account in `needs_reauth` → 409 with `status: 'needs_reauth'`; account `connected` but no session → 409 with status flipped + body `status: 'needs_reauth'`.
  - Happy path with a fake Gmail client returning 10 messages (each with a `Subject`, `From: Sender <sender@example.com>`, `internalDate`): response `{ inserted: 10, skipped: 0 }`; `processed_messages` table has 10 rows for the account with `model_used='dev-seed'`, `classification='other'`, `confidence='low'`, `status='success'`, `subject` matching, `sender_domain='example.com'`.
  - Re-issuing the same request with the same Gmail fixtures: response `{ inserted: 0, skipped: 10 }`; row count stays at 10.
  - `From` header without `<>` (`bare@example.com`) → `sender_domain='example.com'`; unparseable `From` (e.g. empty string) → `sender_domain` is `null` and the row still inserts.
  - Gmail client throws `invalid_grant` → 401 `{ error: 'needs_reauth', account_id: id }`.
  - Gmail client throws a generic error → 502 `{ error: 'gmail_error', message }`.
  - Two accounts seeded in sequence: account A's rows are unaffected by seeding account B (cross-contamination check that satisfies AC #5).

- `src/server/api/processed_messages.test.ts`
  - `:id` invalid → 400.
  - Account not found → 404.
  - Empty list (account exists, no rows) → 200 `{ rows: [] }`.
  - Multiple rows → 200 with rows ordered `processed_at DESC` and the field set the spec names (10 fields).
  - `?limit=200` → 400 (clamped at 50 per spec).

- `src/server/gmail/headers.test.ts` (new)
  - `extractHeader` finds matching header case-insensitively; missing header returns `''`.
  - `parseFromAddressDomain` for `Sender <sender@example.com>` → `'example.com'`; for `sender@example.com` → `'example.com'`; for `''` → `null`; for `Group: a@b.com, c@d.com;` → `null` (bail on unsupported syntax).

**Client tests planned (vitest, jsdom env, `@testing-library/react`):**

- `src/client/views/DevSeedPanel.test.tsx`
  - `/api/dev/enabled` returns 404 → component renders nothing (no DOM output).
  - `/api/dev/enabled` returns `{ enabled: true }` → component fetches accounts, renders the picker with the first connected account preselected, fetches and renders the processed-messages table.
  - Click "Mark first 10 messages as processed" → POSTs the seed endpoint with the selected `account_id` and `count: 10`; on success renders `inserted N, skipped M`; refetches the table.
  - Second click on the same account → renders `inserted 0, skipped 10`.
  - Server returns 401 `needs_reauth` → renders the needs-reauth message.
  - Server returns 502 → renders the Gmail error.
  - Picker change → table refetches for the new `account_id`.
  - Component unmount mid-fetch → no React state updates after unmount (cleanup pattern matches Slice 003's `Inbox.tsx`).

- `src/client/views/Dashboard.test.tsx` — extend (or add): with `/api/dev/enabled` mocked to 200, the Dashboard renders DevSeedPanel below the existing children. With it mocked to 404, the rendered DOM is identical to today's Dashboard (regression check that the panel's `null` return doesn't shift layout).

**Integration tests:** the `app.fetch` pattern carries through. The new `dev.test.ts` and `processed_messages.test.ts` exercise routes against the real DB; that's the integration boundary. No new harness needed.

**Smoke test outline (manual, run by priority 5):**

1. `git status` clean. From the devcontainer: stop any running `npm run dev`. Delete or move aside `./data/app.db` to start fresh.
2. `npm run dev` (server + Vite). Open `http://localhost:5173/` in the host browser. Sign in to a Google account so `accounts` has at least one `connected` row.
3. Sanity-check the schema: `sqlite3 data/app.db ".schema"` shows `accounts`, `processed_messages`, `sync_state`, `app_config`, `_migrations`. `sqlite3 data/app.db "PRAGMA journal_mode;"` → `wal`. `sqlite3 data/app.db "PRAGMA foreign_keys;"` → `1`. `SELECT * FROM app_config;` → `1, 1`.
4. On the Dashboard: confirm the "Dev tools" panel appears below the account list. Pick the connected account; click "Mark first 10 messages as processed". Status line: `inserted 10, skipped 0`. Table immediately shows 10 rows with real subjects, `sender_domain` like `stripe.com`, `model_used='dev-seed'`, `classification='other'`, `confidence='low'`.
5. Click again. Status line: `inserted 0, skipped 10`. Row count stays at 10. (AC #4.)
6. Connect a second Google account. Switch the panel's picker to it. Click seed. Status line: `inserted 10, skipped 0`. `sqlite3 data/app.db 'SELECT account_id, COUNT(*) FROM processed_messages GROUP BY account_id;'` shows two account_ids each with 10 rows. (AC #5.)
7. Stop `npm run dev`. Restart it (substitutes for `docker compose down && docker compose up` per the devcontainer migration — see "Risks"). Reload the Dashboard. Both accounts' tables still show 10 rows each. (AC #6.)
8. **Production gate.** `npm run build && NODE_ENV=production node dist/server/index.js` against the same `data/app.db`. From the host browser at `http://localhost:3737/`: `curl http://localhost:3737/api/dev/enabled` → 404; `curl -X POST http://localhost:3737/api/dev/processed-messages/seed -d '{"account_id":1,"count":10}' -H 'Content-Type: application/json'` → 404. The Dashboard renders without the panel. (AC #7.)
9. **`app_config` invariant.** `sqlite3 data/app.db 'SELECT COUNT(*) FROM app_config;'` → 1, before and after a process restart. (AC #8.)
10. **Read-only Gmail check still passes.** `npm run check:gmail-readonly` → exit 0; the `npm run build` step in (8) already enforced this. (AC #9.)
11. `git status` clean.
