# Slice 004: Persistent state and processed-messages log — Plan

**Spec:** `docs/specs/004-persistent-state-and-processed-messages-log.md`
**Research:** `docs/research/004-persistent-state-and-processed-messages-log.md`

## Steps

Each step is small enough to fit in one loop iteration. Each step ends with a concrete verification — a named test passing, or a specific command's output. Per-step refactor is folded into the priority-3 action. The research doc concluded no ADR is warranted by this slice; if a step surfaces a decision that crosses the ADR bar, the ADR ships in the same iteration.

- [x] **Step 1: Three migrations + `migrations.test.ts` assertions for each table.** Add `src/server/db/migrations/0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql`. Extend `src/server/db/migrations.test.ts` (which already has a `describe('0001_create_accounts.sql', …)` block) with three new sibling `describe` blocks. Each block reuses the same `mkdtempSync` + fresh `Database(...)` + `migrate(db, migrationsDir)` setup pattern as the existing 0001 block.

  - **`describe('0002_create_processed_messages.sql', …)`** — assertions:
    - `PRAGMA table_info(processed_messages)` returns the column set `id, account_id, message_id, thread_id, internal_date, processed_at, model_used, status, error_message, classification, confidence, reason, sender_domain, subject` with the spec's NOT NULL / nullable distribution: `account_id`, `message_id`, `thread_id`, `internal_date`, `processed_at`, `model_used`, `status` are NOT NULL; `error_message`, `classification`, `confidence`, `reason`, `sender_domain`, `subject` are nullable.
    - `id` has `pk: 1`. The autoincrement property is observed indirectly by inserting + deleting + re-inserting a row and asserting the second insert's `id` exceeds the deleted `id` (SQLite's plain `INTEGER PRIMARY KEY` would reuse it; `AUTOINCREMENT` would not).
    - `PRAGMA foreign_key_list(processed_messages)` shows one row referencing `accounts(id)` on `account_id`.
    - `PRAGMA index_list(processed_messages)` includes the two indices the spec calls out: `(account_id, message_id, processed_at DESC)` and `(account_id, processed_at)`. The test introspects index names + `PRAGMA index_info(<name>)` to confirm the column composition; the order of `processed_at DESC` is asserted via `PRAGMA index_xinfo` (column 2 of which is the `desc` flag).
    - Inserting `status='banana'` throws (CHECK enforcement).
    - Inserting `classification='spam'` throws; `classification=NULL` succeeds; `classification='receipt'` succeeds.
    - Inserting `confidence='ultra'` throws; `confidence=NULL` succeeds.
    - **Two rows with the same `(account_id, message_id)` both insert successfully** — the table is append-only with no unique constraint; this regression test pins that property so future schema edits don't accidentally add a UNIQUE.
  - **`describe('0003_create_sync_state.sql', …)`** — assertions:
    - `PRAGMA table_info(sync_state)` returns `account_id` (PK, NOT NULL), `last_history_id` (nullable), `last_synced_at` (nullable). Single column primary key, no surrogate id.
    - `PRAGMA foreign_key_list(sync_state)` shows one row referencing `accounts(id)` on `account_id`.
    - Inserting two rows with the same `account_id` throws (PK uniqueness).
  - **`describe('0004_create_app_config.sql', …)`** — assertions:
    - `PRAGMA table_info(app_config)` returns `id` (PK), `fiscal_year_start_month` (NOT NULL).
    - `SELECT COUNT(*) FROM app_config` returns exactly `1` after migration.
    - `SELECT id, fiscal_year_start_month FROM app_config` returns `{ id: 1, fiscal_year_start_month: 1 }`.
    - `INSERT INTO app_config (id, fiscal_year_start_month) VALUES (2, 1)` throws (CHECK `id = 1`).
    - `INSERT INTO app_config (id, fiscal_year_start_month) VALUES (1, 1)` throws (UNIQUE/PK collision on `id`).
    - `UPDATE app_config SET fiscal_year_start_month = 13 WHERE id = 1` throws (CHECK on month range).
    - `UPDATE app_config SET fiscal_year_start_month = 0 WHERE id = 1` throws.
    - **Idempotent seed:** open a *second* `Database(...)` against the same temp file and call `migrate(...)` again. Row count stays at 1 (the `INSERT OR IGNORE` does nothing on the second pass).

  Run vitest — **red** (new tests; the SQL files don't exist yet so `migrate` throws or the new `describe` blocks see no schema). Implement the three SQL files:
  - `0002_create_processed_messages.sql`:
    ```sql
    CREATE TABLE processed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      internal_date TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      model_used TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success','failed')),
      error_message TEXT NULL,
      classification TEXT NULL CHECK (classification IN ('invoice','receipt','other') OR classification IS NULL),
      confidence TEXT NULL CHECK (confidence IN ('high','medium','low') OR confidence IS NULL),
      reason TEXT NULL,
      sender_domain TEXT NULL,
      subject TEXT NULL
    );
    CREATE INDEX processed_messages_account_message_processed_idx
      ON processed_messages (account_id, message_id, processed_at DESC);
    CREATE INDEX processed_messages_account_processed_idx
      ON processed_messages (account_id, processed_at);
    ```
  - `0003_create_sync_state.sql`:
    ```sql
    CREATE TABLE sync_state (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
      last_history_id TEXT NULL,
      last_synced_at TEXT NULL
    );
    ```
  - `0004_create_app_config.sql`:
    ```sql
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fiscal_year_start_month INTEGER NOT NULL DEFAULT 1
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
    );
    INSERT OR IGNORE INTO app_config (id, fiscal_year_start_month) VALUES (1, 1);
    ```

  Re-run **green**. Verification: `npx vitest run src/server/db/migrations.test.ts` passes; the existing 0001 block is unchanged.

  Notes for the implementer:
  - `migrations.test.ts`'s existing `beforeEach` opens a fresh DB *without* setting `foreign_keys = ON`, because the existing 0001 tests do not exercise FKs. The new 0002/0003 tests need to `db.pragma('foreign_keys = ON')` inside each `describe`'s `beforeEach` to actually exercise the FK violation behavior; the assertion "inserting with non-existent `account_id` throws" is in **Step 3** (the repo step) where `getDb()` already turns FK on; the migration test focuses on the *declared* FK via `PRAGMA foreign_key_list`, not runtime enforcement.
  - The `0004` idempotent-seed test re-opens the temp DB to reset module-level caches; alternatively, calling `migrate` twice on the same `db` handle works because the runner skips already-applied filenames. Pick whichever is shorter.

  _Done: 21 new tests added (8 for 0002, 3 for 0003, 6 for 0004 — counted by `describe`-block totals). Three SQL files landed under `src/server/db/migrations/`. The autoincrement check uses the presence of the `sqlite_sequence` system table rather than insert-delete-reinsert behavior — simpler and equally diagnostic. The index-detection test resolves indices by their column composition (via `PRAGMA index_xinfo`) rather than by name guessing — the table-name prefix `processed_messages_` made name-substring heuristics ambiguous (both index names contain `message`). The 0004 idempotency check uses `migrate(db, migrationsDir)` twice on the same handle (the runner's filename-skip guarantee plus the `INSERT OR IGNORE` make the second call a no-op). The `processed_at DESC` ordering is verified via the `desc=1` flag returned by `PRAGMA index_xinfo`. Pre-flight: ran `npm rebuild better-sqlite3` because the native binary was compiled against a different Node ABI from the devcontainer's Node 24 (the `node_modules` cache predated the devcontainer migration); flagged for the review since this might be the first time anyone hits it post-migration. Full suite: 23 files / 163 tests passing in 11.51 s. The 0001 block is unchanged._

- [x] **Step 2: Enable `journal_mode = WAL` and `foreign_keys = ON` in `getDb()`.** Edit `src/server/db/index.ts`. After `_db = new Database(_path ?? config.dbPath)` and before the `return _db`, call `_db.pragma('journal_mode = WAL')` and `_db.pragma('foreign_keys = ON')`. Update or extend `src/server/db/index.test.ts` (or create it if absent — the file already exists per `## Test run` in Slice 003's plan with three carry-over tests):
  - `getDb()` returns the same instance on subsequent calls (carry-over assertion if already present; preserve).
  - After `setDbPathForTest(...)` + `getDb()`, `db.pragma('journal_mode', { simple: true })` returns `'wal'`.
  - After `setDbPathForTest(...)` + `getDb()`, `db.pragma('foreign_keys', { simple: true })` returns `1`.
  - Calling `setDbPathForTest(...)` a second time closes the prior DB and reopens at the new path; both pragmas re-apply on the reopened handle.

  Run vitest — **red** (the two pragma assertions fail). Add the two pragma calls to `getDb()`. Re-run **green**.

  Verification: `npx vitest run src/server/db/index.test.ts` passes; the existing accounts/messages/migrations tests continue to pass (the change is additive — pragmas don't break existing semantics, and the existing tests don't exercise FK violations on `accounts` rows).

  Notes:
  - The `_db.pragma('journal_mode = WAL')` form passes a SQL fragment; the read-form `_db.pragma('journal_mode', { simple: true })` returns the current setting. `better-sqlite3`'s API is fine with both. Keep the *write* form in `getDb()` for clarity.
  - `journal_mode = WAL` produces `*.db-wal` and `*.db-shm` sibling files in `./data/`. The `.gitignore` already covers `*.db-wal`/`*.db-shm`. No `.gitignore` edit needed.
  - The pragma call order (WAL before FK) matches the research doc; either order works at runtime, but pinning one keeps the diff predictable.

  _Done: 3 new tests added inside the existing `db singleton` describe — opens in WAL, enables foreign_keys, re-applies both after `setDbPathForTest` reopens. Note: `better-sqlite3` enables `foreign_keys` by default (its README is explicit on this), so the FK test was passing **before** the code change too — the explicit `pragma('foreign_keys = ON')` is still added because (a) the architecture wants the contract pinned by our code, not implicit driver behavior, and (b) future raw `new Database(...)` callers (e.g. tooling scripts) get the same guarantee. Implementation matches the plan: two `pragma(...)` calls inside the `_db === undefined` branch so they fire once per process per opened path. Full suite: 23 files / 166 tests passing in 23.53 s. The migrations and accounts tests are unchanged in behavior — WAL on a brand-new in-memory-style temp DB has no observable effect on those assertions._

- [x] **Step 3: `processed_messages` repository (red→green).** Create `src/server/db/repositories/processed_messages.ts` with the same prepared-statement-cache pattern as `src/server/auth/accounts.ts` (`WeakMap<Database.Database, Map<string, Database.Statement>>` + a `stmt(db, key, sql)` helper). Functions:
  - `existsForMessage({ account_id, message_id }: { account_id: number, message_id: string }): boolean` — `SELECT 1 FROM processed_messages WHERE account_id = ? AND message_id = ? LIMIT 1`. Returns `true` if any row exists.
  - `insert(input: ProcessedMessageInput): number` — full insert against the column set; returns `Number(stmt.run(...).lastInsertRowid)`. `ProcessedMessageInput` types every column the migration declares (no `id`, no defaults — caller passes everything explicitly; nullable fields accept `null`).
  - `listForAccount({ account_id, limit }: { account_id: number, limit: number }): ProcessedMessage[]` — `SELECT message_id, thread_id, internal_date, processed_at, model_used, status, classification, confidence, sender_domain, subject FROM processed_messages WHERE account_id = ? ORDER BY processed_at DESC LIMIT ?`. The returned type is `ProcessedMessage` (the API response row shape, not the full DB row — `id`, `account_id`, `error_message`, `reason` are not surfaced).
  - `countForAccount({ account_id }: { account_id: number }): number` — `SELECT COUNT(*) AS c FROM processed_messages WHERE account_id = ?`.

  Write `src/server/db/repositories/processed_messages.test.ts` mirroring `src/server/auth/accounts.test.ts` (mkdtempSync + setDbPathForTest + migrate per beforeEach). Test cases:
  - Setup helper inserts one `accounts` row via the existing repo, returning `accountId`. Reused by every test.
  - `existsForMessage` returns `false` when nothing's inserted; returns `true` after one `insert`; remains `true` after a second `insert` for the same `(account_id, message_id)` pair (append-only).
  - `insert` returns a positive integer `id`; the row is readable via `listForAccount` with all surfaced fields preserved (subject, sender_domain, classification, confidence, model_used, status). Insert with `classification: null, confidence: null, reason: null, sender_domain: null, subject: null, error_message: null` succeeds (nullable columns).
  - `insert` with `status: 'banana'` throws (CHECK).
  - `insert` with `classification: 'spam'` throws (CHECK).
  - `insert` with `account_id` of `99999` (no such account) throws (FK enforcement). **This test verifies Step 2 wired FK on.**
  - `listForAccount({ account_id, limit: 50 })` returns rows ordered by `processed_at DESC`; a row with a later `processed_at` appears first.
  - `listForAccount({ limit: 2 })` against three rows returns the two newest.
  - `listForAccount` is account-scoped: a row inserted under a different `account_id` does not appear in account A's listing. (Exercises AC #5 at the repo layer.)
  - `countForAccount` returns 0 with no rows; matches actual count after inserts; per-account scoped.

  Run vitest — **red** (file doesn't exist). Implement the repository. Re-run **green**.

  Verification: `npx vitest run src/server/db/repositories/processed_messages.test.ts` passes (~10 tests).

  _Done: 15 tests passing — 4 for `existsForMessage` (false on empty, true after insert, true after second insert for same pair, account-scoped), 5 for `insert` (returns positive integer + row readable, accepts null on every nullable column, status CHECK, classification CHECK, FK enforcement throws `FOREIGN KEY` per the better-sqlite3 error wording — confirms Step 2's pragma is wired), 3 for `listForAccount` (DESC ordering, limit, account-scoped), 3 for `countForAccount` (zero, count, account-scoped). Implementation: `WeakMap<Database, Map<string, Statement>>` cache + `stmt(db, key, sql)` helper, mirroring `auth/accounts.ts`'s pattern verbatim. The insert SQL uses `@named` parameters so the call site is `.run(input)` rather than a long positional argument list — readable, harder to misalign. `existsForMessage` selects `1 AS one` (rather than `*`) so the result row is small and the alias avoids parser ambiguity in some sqlite versions. Returned `ProcessedMessage` type is the API row shape (10 fields), not the full DB row — `id`, `account_id`, `error_message`, `reason` are intentionally not surfaced to the caller. `listForAccount` returns rows ordered by `processed_at DESC` directly via SQL, no JS sort. Full suite: 24 files / 181 tests passing in 11.69 s. `tsc --noEmit` clean (the test file's `as 'success'` / `as 'other'` casts deliberately bypass the discriminated-union type to exercise the runtime CHECK; no implicit-any leakage)._

- [x] **Step 4: `sync_state` repository (red→green).** Create `src/server/db/repositories/sync_state.ts` with:
  - `get(account_id: number): SyncState | undefined` — `SELECT account_id, last_history_id, last_synced_at FROM sync_state WHERE account_id = ?`.
  - `upsert(input: { account_id: number, last_history_id: string | null, last_synced_at: string | null }): void` — `INSERT INTO sync_state (account_id, last_history_id, last_synced_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET last_history_id = excluded.last_history_id, last_synced_at = excluded.last_synced_at`.
  - Type `SyncState = { account_id: number, last_history_id: string | null, last_synced_at: string | null }`.

  Write `src/server/db/repositories/sync_state.test.ts`:
  - `get(accountId)` returns `undefined` before any `upsert`.
  - After `upsert({ account_id, last_history_id: 'abc123', last_synced_at: '2026-05-09T10:00:00Z' })`, `get` returns the inserted row.
  - A second `upsert` with new values updates the row in place; `get` returns the new values; `SELECT COUNT(*) FROM sync_state WHERE account_id = ?` is still 1.
  - `upsert` with `account_id` referencing a non-existent account throws (FK).
  - `upsert` accepts `null` for both nullable fields and round-trips them.

  Run vitest — **red**. Implement the repository. Re-run **green**.

  Verification: `npx vitest run src/server/db/repositories/sync_state.test.ts` passes (~5 tests).

  _Done: 5 tests passing — get returns undefined on empty, upsert inserts then get returns it, second upsert updates in place + count stays 1, accepts null on both nullable fields, FK enforcement throws `FOREIGN KEY` for non-existent account. Implementation mirrors `processed_messages.ts`'s prepared-statement-cache pattern. The upsert uses `ON CONFLICT(account_id) DO UPDATE SET ... = excluded.<col>` (SQLite's standard upsert syntax) — atomic and works regardless of whether a row already exists. `get` returns the full `SyncState` shape (the `account_id` is included in the return so call sites can be sure which account a row maps to without re-threading the parameter). Full suite: 25 files / 186 tests passing in 19.05 s._

- [x] **Step 5: `app_config` repository (red→green).** Create `src/server/db/repositories/app_config.ts` with:
  - `get(): AppConfig` — `SELECT id, fiscal_year_start_month FROM app_config WHERE id = 1`. If the row is missing, throw `Error('app_config row missing — migration 0004 did not seed')`. (Defensive; the migration always seeds.)
  - `update(partial: { fiscal_year_start_month?: number }): void` — emits an `UPDATE app_config SET ... WHERE id = 1` for each provided key. With one field today, the simplest implementation is a single conditional. The signature accepts `Partial<...>` so future fields slot in without changing the signature.
  - Type `AppConfig = { id: 1, fiscal_year_start_month: number }`.

  Write `src/server/db/repositories/app_config.test.ts`:
  - After `migrate`, `get()` returns `{ id: 1, fiscal_year_start_month: 1 }`.
  - `update({ fiscal_year_start_month: 7 })` flips the value; `get()` returns 7.
  - `update({ fiscal_year_start_month: 13 })` throws (CHECK enforcement).
  - `update({ fiscal_year_start_month: 0 })` throws.
  - `update({})` is a no-op (does not throw, does not change the row).

  Run vitest — **red**. Implement the repository. Re-run **green**.

  Verification: `npx vitest run src/server/db/repositories/app_config.test.ts` passes (~5 tests).

  _Done: 6 tests passing — get returns the seeded singleton, update flips and is observable, update throws on out-of-range high (13) and low (0) values, update with empty partial is a no-op, get throws on a missing row (defensive against migration corruption). Implementation: `update` only emits a SQL `UPDATE` for keys explicitly present in `partial` — no `Object.keys(partial)` reflection, just an `if (partial.fiscal_year_start_month !== undefined)` guard. Future fields slot in by adding another guarded statement; the `Partial<...>` signature already accepts them. The `get` row-missing throw uses the literal message `'app_config row missing — migration 0004 did not seed'` so production stack traces point at the right cause without further digging. Full suite: 26 files / 192 tests passing in 13.27 s._

- [x] **Step 6: Promote `extractHeader` to `src/server/gmail/headers.ts` and add `parseFromAddressDomain`.** Create the new module:
  - `extractHeader(message: gmail_v1.Schema$Message, name: string): string` — moved verbatim from `src/server/api/messages.ts` (case-insensitive lookup; returns `''` on miss).
  - `parseFromAddressDomain(value: string): string | null` — parses an RFC-5322 `From` header value and returns the lowercase domain part of the email address, or `null` if not parseable. Algorithm: trim; if the value contains `<`, take the substring between the last `<` and the last `>` (the email address); else take the whole value as the address; if the address contains `@`, split at the last `@`, lowercase the right side, strip a trailing `>` defensively, return; else return `null`. Group syntax (`Group: a@x, b@y;`) — return `null` because the parser bails on the first `:` followed by a list.

  Write `src/server/gmail/headers.test.ts` covering:
  - `extractHeader`: present header returns its value; missing header returns `''`; lowercase header name (`subject` instead of `Subject`) is found; the `payload.headers` being `undefined` returns `''`.
  - `parseFromAddressDomain`:
    - `'Sender Name <sender@example.com>'` → `'example.com'`.
    - `'sender@example.com'` → `'example.com'`.
    - `'<sender@example.com>'` → `'example.com'`.
    - `'Sender <SENDER@EXAMPLE.COM>'` → `'example.com'` (lowercased).
    - `'Sender Name <sender@subdomain.example.com>'` → `'subdomain.example.com'`.
    - `''` → `null`.
    - `'no-at-sign'` → `null`.
    - `'Group: a@x.com, b@y.com;'` → `null`.
    - `'"Quoted, name with comma" <sender@example.com>'` → `'example.com'`.

  Run vitest — **red**. Implement `headers.ts`. Then edit `src/server/api/messages.ts`: remove the local `extractHeader` definition; add `import { extractHeader } from '../gmail/headers.js'`. The `messages.ts` test file does not change (the helper was always module-private; behavior is unchanged from the caller's perspective).

  Re-run **green**. Verification: `npx vitest run src/server/gmail/headers.test.ts src/server/api/messages.test.ts` both pass; `tsc --noEmit` clean.

  _Done: 16 tests in `src/server/gmail/headers.test.ts` — 5 for `extractHeader` (present, missing, case-insensitive, undefined `payload.headers`, undefined `payload`), 11 for `parseFromAddressDomain` (Name `<addr>`, bare addr, `<addr>` only, lowercased domain, subdomain preserved, empty value, whitespace-only, no `@`, RFC-5322 group syntax → null, quoted display name with comma, whitespace inside angle brackets). Implementation: `extractHeader` is moved verbatim from `messages.ts`. `parseFromAddressDomain` uses a small finite-state algorithm — trim → if `<` present, slice between last `<` and last `>`; else if any of `, : ;` present (group / list syntax), bail; else treat as bare address; then split at last `@`, lowercase, return. The fallback path for `'no-at-sign'` returns `null` because `lastIndexOf('@') < 0`. `messages.ts` now imports `extractHeader` from `../gmail/headers.js` and dropped its private copy + the now-unused `gmail_v1` type import. The 14 `messages.test.ts` tests are unchanged in behavior. **Flaky-suite note:** the first full-suite run after Step 6 had one timeout failure on `messages.test.ts > returns 404 …`; three subsequent reruns all passed cleanly. The trace points at a `Database connection is not open` error inside `accounts.findById` — pre-existing concurrency hazard around the module-level `_db` singleton + vitest's thread-pool workers, surfaced under the higher test load (208 tests vs. 192 prior). Step 6 only changed an import path; runtime behavior is identical. Flagged for the review under "Followups for later" — recommended fix is either `pool: 'forks'` or per-file isolation in `vitest.workspace.ts`. Full suite (latest run): 27 files / 208 tests passing in 11.68 s. `tsc --noEmit` clean._

- [x] **Step 7: `nodeEnv` in `config.ts` + `GET /api/dev/enabled` + `POST /api/dev/processed-messages/seed` (single iteration).** Three concerns are bundled because they all live in the same dev-mode-gating subsystem and share the same test fixture (a Hono app with `NODE_ENV` toggled per case).

  **Config update.** Edit `src/server/config.ts` to add `nodeEnv: process.env.NODE_ENV ?? 'development'` to the frozen object. Add a config test asserting the default + that a `process.env.NODE_ENV = 'production'` override before module re-import flips it (mirrors the existing `googleClientId` test).

  **Dev API module.** Create `src/server/api/dev.ts`:
  - `export type DevRouteDeps = { createGmailClient?: (accountId: number) => GmailClient }`.
  - `registerDevRoutes(app: Hono, deps: DevRouteDeps = {}): void`.
  - Both routes start with a `if (config.nodeEnv === 'production') return c.notFound()` guard. (Hono's `c.notFound()` returns a default 404 with `Not Found` body; if the spec's "returns 404" requires JSON, switch to `c.json({ error: 'not_found' }, 404)` — pick the latter for consistency with the rest of the API. **Decision:** use `c.json({ error: 'not_found' }, 404)`.)
  - `app.get('/api/dev/enabled', …)` — production gate, otherwise `c.json({ enabled: true })`.
  - `app.post('/api/dev/processed-messages/seed', …)` — production gate, then:
    1. Parse JSON body via `await c.req.json()`. Catch and return 400 `{ error: 'invalid_body', detail: 'JSON parse failed' }`.
    2. Validate body shape: `account_id` must be a positive integer; `count` must be an integer in `[1, 10]`. Otherwise 400 `{ error: 'invalid_body', detail: '...' }`.
    3. `accounts.findById(account_id)` → 404 `{ error: 'account_not_found' }` if missing.
    4. If `account.status !== 'connected'` → 409 `{ error: 'account_not_connected', status: account.status }`.
    5. If `session.get(account_id) === undefined` → flip `accounts.updateStatus(account_id, 'needs_reauth')` then 409 `{ error: 'account_not_connected', status: 'needs_reauth' }`.
    6. `const client = createGmailClient(account_id)`. `await client.listMessages({ maxResults: count })`. For each message: `await client.getMessage(m.id, { format: 'metadata', metadataHeaders: ['Subject', 'From'] })`. Build the row from headers + Gmail SDK fields. Inside a transaction: if `existsForMessage({ account_id, message_id }) === false`, call `processed_messages.insert({...})` — `inserted++`; else `skipped++`. Single SQLite transaction wraps the whole loop (the migration runner does the same; `db.transaction(() => {...})()`).
    7. Response: `c.json({ inserted, skipped })`.
    8. Try/catch around the Gmail block — `invalid_grant` substring or `err.response?.data?.error === 'invalid_grant'` → 401 `{ error: 'needs_reauth', account_id }`; else 502 `{ error: 'gmail_error', message }`.

  **Register the routes.** Edit `src/server/app.ts` to call `registerDevRoutes(app)` between `registerMessagesRoutes(app)` and the static fallback.

  **Test file.** Write `src/server/api/dev.test.ts` mirroring `messages.test.ts`'s pattern (mkdtempSync + setDbPathForTest + migrate + accounts.insert + session.set + Hono via `registerDevRoutes(app, deps)` + a fake `createGmailClient`). Toggle `process.env.NODE_ENV` per `describe` block and `vi.resetModules()` before re-importing the modules so the `config` snapshot picks up the new value.
  - **`describe('production gate', …)`:**
    - `process.env.NODE_ENV = 'production'`. After re-import, `GET /api/dev/enabled` returns 404.
    - Same setup, `POST /api/dev/processed-messages/seed` with a syntactically valid body returns 404.
  - **`describe('GET /api/dev/enabled', …)`:**
    - `NODE_ENV=development` → 200 `{ enabled: true }`.
    - `NODE_ENV=test` → 200 `{ enabled: true }`. (Anything other than `'production'`.)
  - **`describe('POST /api/dev/processed-messages/seed validation', …)`:**
    - Missing body → 400.
    - `account_id: 'abc'` → 400.
    - `account_id: 0` → 400.
    - `count: 0` → 400; `count: 11` → 400; `count: 1.5` → 400.
    - `count: 10` with everything else valid → not a 400.
  - **`describe('POST /api/dev/processed-messages/seed account discriminators', …)`:**
    - Account not in DB → 404 `{ error: 'account_not_found' }`.
    - Account in `needs_reauth` → 409 `{ error: 'account_not_connected', status: 'needs_reauth' }`.
    - Account `connected` but no session entry → 409 with status `needs_reauth`. After the call, `accounts.findById(id).status === 'needs_reauth'`.
  - **`describe('POST /api/dev/processed-messages/seed happy path', …)`:**
    - Connected account + session + fake Gmail client returning 10 messages (each with `Subject: 'Receipt N'`, `From: 'Stripe <noreply@stripe.com>'`, `internalDate: '1715000000000'`) → response `{ inserted: 10, skipped: 0 }`. Assert via `processed_messages.listForAccount({ account_id, limit: 50 })` that the 10 rows have `model_used='dev-seed'`, `classification='other'`, `confidence='low'`, `status='success'`, `subject='Receipt 0'..'Receipt 9'`, `sender_domain='stripe.com'`.
    - Re-issue the same request: response `{ inserted: 0, skipped: 10 }`; row count remains 10.
    - Sender-domain edge cases: a fixture message with `From: 'bare@example.com'` → `sender_domain='example.com'`. A message with `From: ''` → `sender_domain` is `null`, row still inserts.
  - **`describe('POST /api/dev/processed-messages/seed error mapping', …)`:**
    - Fake `listMessages` rejects with `Error('invalid_grant')` → 401 `{ error: 'needs_reauth', account_id }`.
    - Fake `listMessages` rejects with `Error('rate limit')` → 502 `{ error: 'gmail_error', message: 'rate limit' }`.
    - Fake `listMessages` returns 10 ids; one of the per-message `getMessage` calls rejects → 502 (no partial 200). Whatever was inserted before the failing call is rolled back by the transaction — assert `countForAccount` is 0 after the failure.
  - **`describe('cross-account isolation', …)`:**
    - Seed account A with 10 messages. Switch to account B (different fake-Gmail messages). Seed account B with 10. Assert `processed_messages.listForAccount({ account_id: A, limit: 50 })` has only A's 10 messages and `listForAccount({ account_id: B, limit: 50 })` has only B's 10. (AC #5.)

  Run vitest — **red**. Implement `dev.ts`, register the routes, add `nodeEnv` to `config.ts`. Re-run **green**.

  Verification: `npx vitest run src/server/api/dev.test.ts src/server/config.test.ts` both pass; the existing `app.test.ts` still passes. Target ~22 tests in `dev.test.ts`.

  Notes:
  - Hono's body parser via `await c.req.json()` throws `SyntaxError` on malformed JSON. Wrap in `try/catch` and map to 400.
  - The transaction wraps the *insert loop*, not the Gmail-fetch loop. Gmail calls happen outside the transaction (they're network I/O); the transaction is opened just before the insert phase. Alternative: open the transaction at the start and commit after each insert — slower for 10 inserts; the spec's "single transaction" wording in § "Deliverables — POST /api/dev/processed-messages/seed" reads as "per-message" but the cleanest implementation for atomicity-on-failure is per-message-transaction. Plan picks **per-message** transactions because partial success ("3 inserted before the 4th Gmail call failed") is a more useful default than all-or-nothing ("network blip on call 4 wipes calls 1-3"). Flagged for review under "Decisions worth flagging."

  _Done: 13 tests in `config.test.ts` (was 11; +2 for `nodeEnv` default + production-override). 20 tests in `dev.test.ts` covering: production gate (404 on both endpoints), `GET /api/dev/enabled` (200 in dev), seed body validation (missing body, missing/invalid `account_id`, count out-of-range / non-integer), account discriminators (404 missing, 409 needs_reauth, 409 + status flip on no-session), happy path (10 inserted with full row shape), idempotency (second call → all skipped), sender-domain edge cases (bare-address From → domain extracted, empty From → null), error mapping (`invalid_grant` → 401, generic → 502, mid-loop getMessage failure → 502 with **zero** rows inserted), cross-account isolation (Alice's seed doesn't leak into Bob's table). Implementation deviation from the plan's note about "per-message transactions": picked **two-phase** instead — Gmail fetches happen first, in-memory `staged[]` collects everything, then **one** transaction wraps the existsForMessage/insert loop. If any Gmail call throws, the transaction never opens and zero rows land. Test "mid-loop getMessage failure → 502 + zero rows" pins this contract. The plan's per-message-transaction wording was contradictory with its own test expectation; the two-phase approach matches the test, satisfies AC #4 (re-click idempotency), and is cleaner — flagging this in the review under "Decisions worth flagging." Wired in `app.ts` between `registerMessagesRoutes` and the static fallback. The `c.json({ error: 'not_found' }, 404)` shape is used for production gates (matches the rest of the API's error shape; rejects Hono's default `Not Found` text body).

  **Test stability fix.** Two pre-existing flaky-suite issues surfaced loudly at this step (228/230 with 2 timeouts on simple 404 tests). Root cause: vitest's default `pool: 'threads'` shares module-level singletons across test files in the same worker (the DB `_db` reference, the OAuth state map). The first test in each file pays a one-time ~2.6s cost for `vi.resetModules()` + dynamic-imports of `hono` + `better-sqlite3` native binding init; under full-suite parallelism this clips the default 5s test timeout, and the resulting partial state gets misread as `Database connection is not open`. Fixed in `vitest.workspace.ts` (server project → `pool: 'forks'`, isolating module state per file process) plus `vitest.config.ts` (`testTimeout: 15000`, generous enough to ride out worker startup but tight enough that genuine assertion failures still surface promptly). Three full-suite runs in a row are now green: 28 files / 230 tests / ~18-22 s. The fix is captured in inline comments at both call sites. Flagging in the review under "Decisions worth flagging" since the runtime change is broader than this slice's strict scope. `tsc --noEmit` clean (one fix-up: `expect(rows[0].sender_domain)` → `expect(rows[0]?.sender_domain)` to satisfy `noUncheckedIndexedAccess`)._

- [x] **Step 8: `GET /api/accounts/:id/processed-messages` route (red→green).** Create `src/server/api/processed_messages.ts`:
  - `registerProcessedMessagesRoutes(app: Hono): void` (no deps — this route reads only the local DB; no Gmail client involved).
  - `app.get('/api/accounts/:id/processed-messages', …)`:
    1. Parse `:id` (positive integer) → 400 on invalid.
    2. Parse `?limit=` (default 50, max 50 per spec — different from `messages.ts`'s 100; the spec for *this* slice's read endpoint uses 50 as both default and max). Out-of-range → 400.
    3. `accounts.findById(id)` → 404 `{ error: 'account_not_found' }`.
    4. *Do not* gate on `account.status === 'connected'` — the row listing is local and works for `needs_reauth` accounts too (the rows still belong to that account; the audit view in Slice 010 will read this same path). The spec doesn't require a status gate.
    5. `processed_messages.listForAccount({ account_id: id, limit })` → response `{ rows: [...] }`.

  Edit `src/server/app.ts` to register the route between `registerDevRoutes(app)` and the static fallback.

  Write `src/server/api/processed_messages.test.ts`:
  - `:id` non-integer → 400.
  - Account not found → 404.
  - Empty list → 200 `{ rows: [] }`.
  - One row inserted → 200 with the row's 10 fields populated correctly.
  - Multiple rows → ordered `processed_at DESC`. Use distinct `processed_at` strings so ordering is deterministic.
  - `?limit=200` → 400.
  - `?limit=10` → returns at most 10 rows.
  - Default (no `?limit`) → returns at most 50 rows; insert 60, assert 50 returned.
  - Account-scoping: rows for account B do not appear in account A's response.
  - Returns the row even when `account.status === 'needs_reauth'` (no status gate).

  Run vitest — **red**. Implement the route + register. Re-run **green**.

  Verification: `npx vitest run src/server/api/processed_messages.test.ts` passes (~10 tests).

  _Done: 12 tests passing — 400 on non-integer id, 400 on id=0, 404 on missing account, 200 `{rows: []}` on empty list, 10-field row shape (the spec-named API column set is locked in via `Object.keys(...).sort()`), `processed_at DESC` ordering, 400 on `?limit=200` and `?limit=0`, `?limit=2` returns 2 rows, default cap of 50 against 60 inserted rows, account-scoping (Bob's rows invisible from Alice's call), returns rows even for an account in `needs_reauth` (no status gate — confirms the design choice from the research doc; the Audit view in Slice 010 will consume this same path). Implementation: 30 lines, no `deps` parameter — the route reads only the local DB and the existing `accounts` repo. Wired in `app.ts` between `registerDevRoutes` and the static fallback. The `MAX_LIMIT = 50` constant differs from `messages.ts`'s `MAX_LIMIT = 100` per the spec (this slice's read endpoint caps at the same value as the default for paranoia — sliding window stays small until the Audit view in Slice 010 picks a larger ceiling). Full suite: 29 files / 242 tests passing in 18.53 s. `tsc --noEmit` clean._

- [x] **Step 9: `ProcessedMessage` client type + `DevSeedPanel` component.** Add the `ProcessedMessage` type to `src/client/types.ts` matching the API row shape: `{ message_id: string, thread_id: string, internal_date: string, processed_at: string, model_used: string, status: 'success' | 'failed', classification: 'invoice' | 'receipt' | 'other' | null, confidence: 'high' | 'medium' | 'low' | null, sender_domain: string | null, subject: string | null }`.

  Write `src/client/views/DevSeedPanel.test.tsx` (jsdom + RTL). Pattern matches Slice 003's `Inbox.test.tsx`: stub `globalThis.fetch` per test with a `Map<URL pattern, Response factory>` so the test file isn't a stack of `mockResolvedValueOnce` chains. Cases:
  - `/api/dev/enabled` returns 404 → component renders nothing (assert `container.firstChild === null`).
  - `/api/dev/enabled` returns 200 → component fetches `/api/accounts` and `/api/accounts/<id>/processed-messages`. With one connected account and an empty rows list: renders the `<AccountPicker>` with that account preselected, an inline status line "No rows yet for this account.", a "Mark first 10 messages as processed" button, and the empty `<table>` (header row only).
  - With one connected account and three rows seeded in the fake `/api/accounts/:id/processed-messages` response: renders the table with 3 rows showing Subject, Sender (extracted from `sender_domain`), Processed at, Classification, Confidence, Model.
  - Click the seed button → POSTs to `/api/dev/processed-messages/seed` with `{ account_id, count: 10 }`. On `{ inserted: 10, skipped: 0 }`: status line reads `inserted 10, skipped 0`, the table refetches and renders the new rows.
  - Second click on the same account → status line reads `inserted 0, skipped 10`.
  - Server returns 401 → status line reads "This account needs to be reconnected — go to the Dashboard."
  - Server returns 502 with `{ message: 'rate limit' }` → status line reads "Gmail returned an error: rate limit."
  - Server returns 409 → status line reads "Account is not currently connected — try Reconnect on the Dashboard."
  - Picker change → table refetches for the new account; the status line clears (it was specific to the previous account's last action).
  - Loading state during the seed click — button is disabled while the request is in flight; re-enabled on response (success or error).
  - No connected accounts (`/api/accounts` returns one row in `needs_reauth`) → renders the `<AccountPicker>`'s empty state ("No connected accounts. Connect one on the Dashboard.") and no seed button.

  Run vitest — **red**. Implement `src/client/views/DevSeedPanel.tsx`:
  - Top-level state: `enabled: boolean | null`, `accounts: Account[] | null`, `selectedAccountId: number | null`, `rows: ProcessedMessage[] | null`, `status: PanelStatus`, `seeding: boolean`. The `PanelStatus` discriminated union mirrors `Inbox.tsx`'s pattern: `{ kind: 'idle' } | { kind: 'success', inserted, skipped } | { kind: 'needs_reauth' } | { kind: 'gmail_error', message } | { kind: 'not_connected' } | { kind: 'unexpected', message }`.
  - Effect 1: on mount, `getJson('/api/dev/enabled')` → on 200 set `enabled=true`; on 404 set `enabled=false` and stop. (Catch the `getJson` throw — it throws on non-2xx; the catch sets `enabled=false`.)
  - Effect 2: when `enabled === true`, fetch `/api/accounts`; pre-select first connected account.
  - Effect 3: when `selectedAccountId` changes (and not null), fetch `/api/accounts/<id>/processed-messages?limit=50` and set `rows`. Reset `status` to `idle` on account change.
  - Click handler: set `seeding=true`, POST to seed, update `status` from response or error, if success refetch rows, set `seeding=false`.
  - Render: when `enabled === null` → `<p>Loading…</p>` — but actually, the panel is meant to be invisible during the dev-enabled probe; render nothing instead. (Match the spec's "panel only renders when GET /api/dev/enabled returns true".) When `enabled === false` → render nothing. When `enabled === true && accounts === null` → `<p>Loading…</p>`. Otherwise render `<section><h2>Dev tools</h2><AccountPicker .../><button disabled={seeding} onClick={...}>Mark first 10 messages as processed</button><p>{statusLine}</p><table>...</table></section>`.
  - Sender column renders `sender_domain ?? '—'`. Subject column renders `subject ?? '—'`.

  Re-run **green**. Verification: `npx vitest run src/client/views/DevSeedPanel.test.tsx` passes (~12 tests).

  _Done: 11 tests passing — 404 → renders nothing, enabled → picker+button+empty-table state, rows render with subjects + sender_domains, click seeds and refetches the table (status `inserted 10, skipped 0`), no-op shows `inserted 0, skipped 10`, 401 → "needs to be reconnected", 502 → "Gmail returned an error: rate limit", 409 → "Account is not currently connected", picker change → table refetches + status clears, button is disabled while seed is in flight (held open via a controlled promise), only-needs_reauth accounts → AccountPicker's empty-state ("No connected accounts. Connect one on the Dashboard.") with no seed button. Implementation: three `useEffect`s (dev-enabled probe → accounts fetch → rows fetch on `selectedAccountId` change), discriminated-union `SeedStatus` for the inline status line (idle/success/needs_reauth/gmail_error/not_connected/unexpected), `<AccountPicker accounts={accounts} value={selectedAccountId} onChange={...} includeDisconnected={false} />` because seeding requires a live Gmail call. Status line clearing on picker change is handled by resetting to `{ kind: 'idle' }` inside the rows-fetch effect — same lifecycle as the rows themselves. The button row + table only render when `accounts.some(a => a.status === 'connected')` is true; otherwise the AccountPicker's own empty state takes over. Idle empty-state text "No rows yet for this account." appears in `statusLine(status, rows)` when `rows !== null && rows.length === 0` — not before the rows fetch resolves; the test for that case waits on it via `await waitFor(...)`. `ProcessedMessage` type added to `src/client/types.ts` matching the API row shape verbatim. `tsc --noEmit` clean. Full suite: 30 files / 253 tests passing in 19-23 s across multiple runs._

- [x] **Step 10: Dashboard integration.** Edit `src/client/views/Dashboard.tsx` to render `<DevSeedPanel />` as a third child of `<main>`, below `<AccountList />` and `<AddAccountButton />`. The panel is fully self-contained — no props from Dashboard, no state lifted up. Update `src/client/views/Dashboard.test.tsx`:
  - Existing tests stay green. The Dashboard test fixture stubs `fetch` for `/api/accounts`; add stubs for `/api/dev/enabled` (→ 404 by default in this test file, so the panel renders nothing) so the existing tests don't break. The 404 default keeps the panel invisible during all the carry-over Dashboard cases, exactly like production.
  - Add one new test: with `/api/dev/enabled` mocked to return 200 + accounts mocked to one connected row + processed-messages mocked to empty, the Dashboard renders both the existing `AccountList` content *and* the DevSeedPanel's `<h2>Dev tools</h2>` heading.

  Run vitest — **red** (the new Dashboard test fails because the panel isn't wired). Wire `<DevSeedPanel />` into the JSX tree. Re-run **green**.

  Verification: `npx vitest run src/client/views/Dashboard.test.tsx` passes; the rest of the client suite is unaffected.

  _Done: `<DevSeedPanel />` is now the third child of `<main>` in `Dashboard.tsx`, below `AccountList` and `AddAccountButton`. One new test added to `Dashboard.test.tsx` ("renders the Dev tools panel when /api/dev/enabled returns 200") that asserts the panel's `<h2>Dev tools</h2>` heading + the seed button are rendered alongside the existing accounts list. The existing 6 Dashboard tests required restructuring beyond what the plan anticipated: the Dashboard's loading state defers DevSeedPanel mount until `accounts` resolves, so `/api/accounts` is **the first** fetch (not `/api/dev/enabled`). Three tests previously used `mockResolvedValue` (without "Once") as a trailing default for polling/reconnect flows — that override silently consumed the panel's `/api/dev/enabled` request and broke the next-step assertions. Refactored those three tests (Reconnect, reconnect-polling, append-new-account) to use URL-routed `mockImplementation` with per-test counters where polling sequences matter. The simpler tests (loading state, empty list, error path) keep their `mockResolvedValueOnce` chains and rely on the `beforeEach` default `mockImplementation` to handle the panel's `/api/dev/enabled` after the queue empties. Full suite: 30 files / 254 tests passing in 12-15 s across multiple runs. `tsc --noEmit` clean._

- [x] **Step 11: Wrap-up — `.env.example` note + typecheck + full build.** Update `.env.example` to add a one-line comment under the existing entries:
  ```
  # NODE_ENV gates dev-only endpoints (POST /api/dev/processed-messages/seed,
  # GET /api/dev/enabled). Set to "production" to disable; defaults to
  # "development". Production builds set this automatically.
  ```
  Then run the full toolchain checks:
  - `npx tsc --noEmit -p tsconfig.json` → 0.
  - `npx vitest run` → all green.
  - `npm run build` → 0 (`check:gmail-readonly` → `vite build` → `tsc -p tsconfig.server.json` → `cpSync` of migrations).
  - `ls dist/server/db/migrations/` → confirm `0001_create_accounts.sql`, `0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql` are all copied to dist.
  - `ls dist/server/api/dev.js dist/server/api/processed_messages.js dist/server/db/repositories/` → all present.
  - `ls dist/client/index.html` → present.

  No new code in this step — it's the gate that catches anything Steps 1-10 missed at the cross-tree level.

  Verification: all four checks pass on a clean tree (`rm -rf dist && npm run build`). Record the dist contents in the step's done-note for the review.

  _Done: `.env.example` updated with the `NODE_ENV` documentation block (commented `# NODE_ENV=production` with a one-line explainer above the existing OAuth credentials block). All four toolchain checks pass on a clean tree:
  - `npx tsc --noEmit -p tsconfig.json` → exit 0.
  - `npx vitest run` → 30 files / 254 tests / 13.07 s.
  - `rm -rf dist && npm run build` → exit 0. Build chain: `check:gmail-readonly` (`OK: no forbidden Gmail-write substrings in src/`) → `vite build` (42 modules → 228.04 kB / 72.14 kB gzipped, +3.34 kB raw / +0.71 kB gzipped over Slice 003 — the DevSeedPanel + `ProcessedMessage` type) → `tsc -p tsconfig.server.json` → `cpSync` of migrations.
  - `ls dist/...` confirms: all four migration SQL files (`0001_create_accounts.sql`, `0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql`) copied through to `dist/server/db/migrations/`; `dist/server/api/dev.js` and `dist/server/api/processed_messages.js` present; `dist/server/db/repositories/` has `app_config.js`, `processed_messages.js`, `sync_state.js`; `dist/client/index.html` present.

  No further fixes needed in this step — Steps 1-10 already kept the trees consistent on each iteration._

## Smoke test recipe

The exact sequence the loop will run after all plan steps are checked. The recipe is adapted to the post-devcontainer-migration state (no `docker compose`); the substance — rows persist across process restarts on the same on-disk DB — is preserved.

All commands run from the repo root, inside the devcontainer.

1. Stop any running `npm run dev`. Move aside an existing `data/app.db` (`mv data/app.db data/app.db.backup` — or delete if no Slice 002/003 state matters) so the smoke starts from a fresh schema.
2. Confirm `.env` has non-empty `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (carry-over from Slice 002's smoke).
3. `npm run dev` (server on 3737, Vite on 5173). Poll `curl -fsS http://localhost:3737/health` until 200.
4. **AC #1 — schema present.** `sqlite3 data/app.db ".schema"` shows `accounts`, `processed_messages`, `sync_state`, `app_config`, `_migrations`. Specifically:
   - `processed_messages` has the spec's column set + the two indices.
   - `sync_state(account_id PRIMARY KEY, last_history_id, last_synced_at)`.
   - `app_config(id PRIMARY KEY CHECK id=1, fiscal_year_start_month CHECK 1..12)`.
5. **AC #2 — pragmas active.** `sqlite3 data/app.db "PRAGMA journal_mode;"` → `wal`. `sqlite3 data/app.db "PRAGMA foreign_keys;"` → `1`. (FK is per-connection so the `sqlite3` CLI sees its own setting; assert via `getDb()` in a small Node REPL or via the unit test instead. The CLI assertion is included for the human; the test is the authoritative one.)
6. **AC #3 — Dev tools panel renders + seed works.** Open `http://localhost:5173/` in the host browser. Confirm a "Dev tools" panel appears below the existing accounts list. Pick a connected account. Click "Mark first 10 messages as processed". Status line: `inserted 10, skipped 0` within a few seconds. The table immediately shows 10 rows with real Subject values, `sender_domain` like `stripe.com` (or whatever the account's recent senders are), `model_used='dev-seed'`, `classification='other'`, `confidence='low'`, `status='success'`.
7. **AC #4 — re-click idempotency.** Click the seed button again on the same account. Status line: `inserted 0, skipped 10`. Row count stays at 10. `sqlite3 data/app.db "SELECT COUNT(*) FROM processed_messages WHERE account_id = 1;"` → 10.
8. **AC #5 — second account.** Connect a second Google account (or pre-existing). Switch the picker. Click seed. Status line: `inserted 10, skipped 0`. `sqlite3 data/app.db 'SELECT account_id, COUNT(*) FROM processed_messages GROUP BY account_id;'` shows two distinct `account_id`s each with 10 rows. The first account's rows are unchanged: `sqlite3 data/app.db "SELECT message_id FROM processed_messages WHERE account_id=1 ORDER BY processed_at DESC LIMIT 1;"` is the same as in step 6.
9. **AC #6 — restart persistence.** Stop the dev server (Ctrl-C). Start it again (`npm run dev`). Reload `http://localhost:5173/`. The Dev tools panel's table for both accounts still shows their 10 rows each. (Substitutes for `docker compose down && docker compose up`; the property under test is "rows persist on disk across process restart" and that's preserved.)
10. **AC #7 — production gate.** Stop `npm run dev`. `npm run build`. `NODE_ENV=production node dist/server/index.js` against the same `data/app.db` (set `APP_PORT=3738` to avoid colliding with any leftover dev server on 3737). From the host: `curl -i http://localhost:3738/api/dev/enabled` → 404. `curl -i -X POST http://localhost:3738/api/dev/processed-messages/seed -H 'Content-Type: application/json' -d '{"account_id":1,"count":10}'` → 404. Open `http://localhost:3738/` in the browser. The Dashboard renders without the Dev tools panel. The existing `AccountList` and `AddAccountButton` are visible as before.
11. **AC #8 — `app_config` invariant.** `sqlite3 data/app.db 'SELECT COUNT(*) FROM app_config; SELECT * FROM app_config;'` → `1` and `1|1`. Restart the production server. Re-run the same query → still `1` and `1|1`. (Migrations are idempotent and `INSERT OR IGNORE` does not duplicate.)
12. **AC #9 — read-only Gmail check still passes.** `npm run check:gmail-readonly` exits 0 with `OK: no forbidden Gmail-write substrings in src/`. `npm run build` — the build chain runs the check first; the build log shows the OK line.
13. `git status` clean.
14. Restore the previous `data/app.db.backup` if applicable (`mv data/app.db.backup data/app.db`), or leave the smoke-state DB in place — the human accepts.

## Test run

- **Date:** 2026-05-09
- **Command:** `npx vitest run`
- **Result:** 30 test files, **254 tests, all passing**. Duration 22.19 s.
  - Server (20 files, 198 tests):
    - `scripts/check-gmail-readonly.test.ts` — 7 (carried over from Slice 003)
    - `src/server/config.test.ts` — 13 (was 11 in Slice 003; +2 for `nodeEnv` default + production-override)
    - `src/server/app.test.ts` — 3 (carried over)
    - `src/server/db/index.test.ts` — 6 (was 3; +3 for WAL pragma, foreign_keys pragma, both re-applied after `setDbPathForTest` reopens)
    - `src/server/db/migrate.test.ts` — 4 (carried over)
    - `src/server/db/migrations.test.ts` — 21 (was 4; +17 across new `describe` blocks for `0002`, `0003`, `0004` — column shape, FK declarations, indices on processed_messages, AUTOINCREMENT presence via `sqlite_sequence`, all CHECK constraints, append-only proof, single-row enforcement on app_config, idempotent seed)
    - `src/server/db/repositories/processed_messages.test.ts` — 15 (new — `existsForMessage` × 4, `insert` × 5 incl. FK enforcement, `listForAccount` × 3 incl. ordering + scoping, `countForAccount` × 3)
    - `src/server/db/repositories/sync_state.test.ts` — 5 (new — get-undefined, upsert+get, upsert-updates-in-place, FK enforcement, accepts null both columns)
    - `src/server/db/repositories/app_config.test.ts` — 6 (new — seeded singleton, update flips value, CHECK above range, CHECK below range, empty partial no-op, missing-row throw)
    - `src/server/auth/slug.test.ts` — 8 (carried over)
    - `src/server/auth/accounts.test.ts` — 8 (carried over)
    - `src/server/auth/oauth.test.ts` — 7 (carried over)
    - `src/server/auth/session.test.ts` — 8 (carried over)
    - `src/server/api/accounts.test.ts` — 2 (carried over)
    - `src/server/api/oauth.test.ts` — 16 (carried over)
    - `src/server/api/messages.test.ts` — 14 (carried over; `extractHeader` import path changed but behavior unchanged)
    - `src/server/api/dev.test.ts` — 20 (new — production gate × 2, GET /api/dev/enabled × 1, body validation × 6, account discriminators × 3, happy path + idempotency × 4 incl. sender-domain edges, error mapping × 3, cross-account isolation × 1)
    - `src/server/api/processed_messages.test.ts` — 12 (new — invalid id × 2, account not found, empty list, 10-field row shape, DESC ordering, `?limit` bounds × 2, `?limit=2` returns 2, default cap of 50 against 60 inserted rows, account scoping, returns rows for `needs_reauth` accounts)
    - `src/server/gmail/client.test.ts` — 7 (carried over)
    - `src/server/gmail/headers.test.ts` — 16 (new — `extractHeader` × 5 incl. case-insensitive + missing `payload`, `parseFromAddressDomain` × 11 covering name+addr forms, bare addresses, lowercased domains, subdomains, empty/whitespace, no-`@`, RFC-5322 group syntax → null, quoted display name with comma, whitespace inside angle brackets)
  - Client (10 files, 56 tests):
    - `src/client/api.test.ts` — 6 (carried over)
    - `src/client/jsdom-env.test.tsx` — 1 (carried over)
    - `src/client/components/AccountList.test.tsx` — 6 (carried over)
    - `src/client/components/AccountPicker.test.tsx` — 6 (carried over)
    - `src/client/components/AddAccountButton.test.tsx` — 4 (carried over)
    - `src/client/components/Nav.test.tsx` — 3 (carried over)
    - `src/client/router.test.tsx` — 3 (carried over)
    - `src/client/views/Dashboard.test.tsx` — 7 (was 6; +1 for "renders the Dev tools panel when /api/dev/enabled returns 200"; three existing tests refactored to URL-routed `mockImplementation` so the panel's `/api/dev/enabled` probe doesn't consume responses queued for the dashboard's flows)
    - `src/client/views/Inbox.test.tsx` — 9 (carried over)
    - `src/client/views/DevSeedPanel.test.tsx` — 11 (new — disabled-renders-nothing, enabled+empty-rows surface, rows render, click seeds + table refetch, no-op skipped count, 401 needs_reauth message, 502 gmail_error message, 409 not_connected message, picker change refetches + clears prior status, button disabled while seeding, AccountPicker empty state for only-needs_reauth accounts)
- **Coverage of acceptance criteria** (per spec § "Acceptance criteria"):
  - **AC #1** (DB schema after migration shows `accounts`, `processed_messages`, `sync_state`, `app_config`, plus `_migrations`) — `migrations.test.ts` verifies each table's `PRAGMA table_info(...)` matches the spec's column shape; `migrate.test.ts` verifies the runner records applied filenames in `_migrations`.
  - **AC #2** (`PRAGMA journal_mode` returns `wal`; `PRAGMA foreign_keys` returns `1`) — `db/index.test.ts` "opens the connection in WAL mode" and "enables foreign_keys on the connection" exercise both pragmas after `setDbPathForTest` + `getDb()`. The "re-applies WAL and foreign_keys after setDbPathForTest reopens the handle" test pins durability across handle swaps.
  - **AC #3** (Dashboard renders Dev tools panel in dev; click responds with `inserted: 10, skipped: 0`; rows show real Subject + sender_domain) — `Dashboard.test.tsx` "renders the Dev tools panel when /api/dev/enabled returns 200" pins panel mount; `DevSeedPanel.test.tsx` "seeds and renders inserted/skipped status, then refetches the table" pins the click → POST → `inserted/skipped` flow; `dev.test.ts` "inserts 10 rows on first call with the dev-seed defaults" pins the row shape + values (subject, sender_domain, model_used='dev-seed', classification='other', confidence='low', status='success').
  - **AC #4** (re-click responds `inserted: 0, skipped: 10`; row count stays 10) — `dev.test.ts` "returns inserted: 0, skipped: 10 on a second call against the same fixture"; `DevSeedPanel.test.tsx` "shows the inserted: 0, skipped: 10 status on a no-op call".
  - **AC #5** (second account adds 10 separate rows; first account unchanged) — `dev.test.ts` "cross-account isolation > seeding account B leaves account A rows unchanged"; `processed_messages.ts` repo "is account-scoped — rows under another account are not returned" + "is account-scoped" (count); `processed_messages` route "is account-scoped" + "returns rows even for an account in `needs_reauth` state".
  - **AC #6** (rows persist across container restart on the same bind-mounted DB) — structural: `processed_messages` is a real SQLite table, persisted to `./data/app.db`. The `migrations.test.ts` cases prove the schema is created idempotently; the `getDb()` singleton + bind-mount preserve rows across process restarts. End-to-end persistence is a smoke step (priority 5).
  - **AC #7** (`NODE_ENV=production` → both dev endpoints return 404) — `dev.test.ts` "production gate > GET /api/dev/enabled returns 404 in production" and "production gate > POST /api/dev/processed-messages/seed returns 404 in production". `config.test.ts` "reads nodeEnv from NODE_ENV env var when set to 'production'" pins the upstream contract.
  - **AC #8** (`app_config` has exactly one row with `fiscal_year_start_month=1` after first migration; subsequent restarts do not re-insert) — `migrations.test.ts` "seeds exactly one row with id=1 and fiscal_year_start_month=1", "rejects rows with id != 1 (single-row CHECK)", "rejects a second row with id=1 (PK uniqueness)", "does not duplicate the seed row when migrate runs again on the same DB". `app_config` repo tests pin the `get()` return shape and `update()` CHECK behavior.
  - **AC #9** (build-time read-only Gmail check still passes) — `scripts/check-gmail-readonly.test.ts` 7 tests still green; the `check:gmail-readonly` step runs first in `npm run build` and printed `OK: no forbidden Gmail-write substrings in src/` during Step 11's clean-build verification.

- **Stability fix this slice introduced.** `vitest.workspace.ts` server project switched from default `pool: 'threads'` to `pool: 'forks'`; `vitest.config.ts` `testTimeout` raised from the default 5 s to 15 s. Background: once the server suite crossed ~200 tests, the first test in each file occasionally pushed past 5 s on `vi.resetModules()` + dynamic-import + `better-sqlite3` native binding init, producing flaky `Database connection is not open` failures from the module-level `_db` singleton being shared across test files in the same worker. Forks fully isolate module state per file at the cost of slower startup; 15 s is generous enough to ride out the worst-case startup but tight enough that genuine regressions still surface promptly. Three full-suite runs in a row are stable at 13–22 s. Pre-flight: `npm rebuild better-sqlite3` was needed once to rebuild the native binding against the devcontainer's Node 24 (the cached binary was for an earlier ABI from the pre-devcontainer install).

## Smoke run

- **Date:** 2026-05-09
- **Result:** Pass for everything verifiable from the agent shell (schema upgrade against real existing DB, both pragmas, app_config invariant, production gate end-to-end via curl, build-time check). The browser-driven and real-Gmail portions are recorded as deferred — they need a person at the keyboard with a connected Google account.

**What was exercised**

The Docker portion of the recipe was substituted with the equivalent direct-on-disk and `node dist/server/index.js` paths because the project no longer has a `Dockerfile` / `docker-compose.yml` (the devcontainer migration commit dropped them in favour of a Claude Code devcontainer). The substance of the recipe — "schema is created, pragmas stick, dev endpoints disappear in production, rows persist on disk across process restarts" — is preserved.

1. **AC #1 — schema present (real upgrade path).** The user's existing `data/app.db` was at the Slice-002 baseline (only `accounts` and `_migrations` tables, two real Google accounts, `journal_mode=delete`). Ran the migrate logic via a small node script (since the devcontainer has no `sqlite3` CLI; `better-sqlite3` is already a runtime dep). Output:
   - `skip (already applied): 0001_create_accounts.sql`
   - `applied: 0002_create_processed_messages.sql`
   - `applied: 0003_create_sync_state.sql`
   - `applied: 0004_create_app_config.sql`
   - Tables after migration: `_migrations, accounts, app_config, processed_messages, sync_state` ✓
   - Pre-existing 2 `accounts` rows (`rbuskov@gmail.com`, `rasmus@toneworks.io`, both `connected`) preserved ✓
2. **AC #2 — pragmas active.** Same script reported `journal_mode: wal`, `foreign_keys: 1` after `getDb()`-equivalent open. The journal-mode flip is **sticky on disk** — the file is now in WAL mode for all future opens, including the production server smoke and the devcontainer dev server. ✓
3. **AC #8 — `app_config` invariant.** `SELECT * FROM app_config` after migration returned `[ { id: 1, fiscal_year_start_month: 1 } ]`. Single row, the seed value. ✓
4. **AC #6 — persistence at the SQLite layer.** Inserted a synthetic `processed_messages` row via one `Database` handle, closed it, opened a fresh `Database` against the same on-disk file, queried — the row was returned with all 5 surfaced fields (`message_id`, `model_used`, `classification`, `sender_domain`, `subject`) intact. Cleaned up the synthetic row afterward (so the user's DB returns to zero processed_messages). The full "click seed → restart → row still in panel" version requires real OAuth and is deferred to human acceptance; the SQLite-durability property under test is what's preserved across process restarts and is proven here. ✓ (synthetic; full-flow deferred)
5. **AC #7 — production gate end-to-end via curl.** `npm run build` completed clean (228.04 kB / 72.14 kB gzipped client bundle, all four migrations and both new server modules in `dist/`). Booted `APP_PORT=3738 NODE_ENV=production node dist/server/index.js` in the background, waited for `/health` to return 200, then curl'd:
   - `GET /health` → `200 OK` ✓
   - `GET /api/dev/enabled` → `404 Not Found`, content-type `application/json`, body length 21 (`{"error":"not_found"}`) ✓
   - `POST /api/dev/processed-messages/seed` with valid JSON body → `404 Not Found`, same shape ✓
   - `GET /api/accounts` → `200 OK`, content-type `application/json`, body length 402 (the two real connected accounts; sanity that production still serves non-dev endpoints) ✓
   - Killed the background process; tree clean.
6. **AC #9 — read-only Gmail check still passes.** `npm run check:gmail-readonly` → `OK: no forbidden Gmail-write substrings in src/`. The full `npm run build` ran the check as its first step during AC #7's build above, so this is the third independent verification this slice. ✓
7. **`git status`** — only this slice's expected diff: `.env.example`, `.gitignore` (the `.claude/ralph-loop.local.md` user edit from iteration 2), `src/client/types.ts`, `src/client/views/Dashboard.test.tsx`, `src/client/views/Dashboard.tsx`, `src/server/api/messages.ts`, `src/server/app.ts`, `src/server/config.test.ts`, `src/server/config.ts`, `src/server/db/index.test.ts`, `src/server/db/index.ts`, `src/server/db/migrations.test.ts`, `vitest.config.ts`, `vitest.workspace.ts`, plus untracked files for the new repositories, route handlers, panel, headers helper, the three new SQL migrations, and the spec's research + plan documents.

**Deferred (require human + real Google account + browser)**

These are not failures; they are the parts of the recipe that need a person at the keyboard with a connected Google account.

- **AC #3 — Dev tools panel renders + click → `inserted: 10, skipped: 0` with real Subject + sender_domain.** Requires opening `http://localhost:5173/` (or `:3737/` against the production binary), letting the panel mount, picking a connected account, clicking "Mark first 10 messages as processed", and observing the inline status line + the table rendering 10 real rows. The contract is fully pinned at the unit-test layer: `dev.test.ts` "inserts 10 rows on first call with the dev-seed defaults" pins the row shape and field values; `Dashboard.test.tsx` "renders the Dev tools panel when /api/dev/enabled returns 200" pins the panel mount; `DevSeedPanel.test.tsx` "seeds and renders inserted/skipped status, then refetches the table" pins the click → POST → table refetch flow.
- **AC #4 — re-click responds `inserted: 0, skipped: 10`.** Same caveat. `dev.test.ts` "returns inserted: 0, skipped: 10 on a second call against the same fixture" + `DevSeedPanel.test.tsx` "shows the inserted: 0, skipped: 10 status on a no-op call" cover the contract; the in-browser version is the human's read.
- **AC #5 — second account adds 10 separate rows; first account unchanged.** `dev.test.ts` "cross-account isolation > seeding account B leaves account A rows unchanged" pins the application-level scoping; the in-browser version exercises the same path against real Gmail messages.
- **AC #6 (full version) — `docker compose down && docker compose up`-style restart with rows still visible.** The spec's literal wording references Docker; the post-devcontainer-migration substitute is "stop + restart `npm run dev`" or "stop production binary, restart against the same `data/app.db`". The SQLite-durability property is proven (step 4 above). The end-to-end "panel still shows 10 rows after restart" needs the in-browser flow.

**Caveats**

- The smoke ran against the user's live `data/app.db` (which had the two real Google accounts from earlier). Migrations were applied additively; no existing rows were rewritten. The synthetic `processed_messages` row inserted for AC #6 was deleted before the smoke ended, so `processed_messages` is now empty for both accounts — exactly the state a fresh post-migration Slice-004 install would be in.
- The devcontainer's `npm rebuild better-sqlite3` (Step 1's done-note) was a one-time fix; the binary is now compiled for the current Node 24 ABI and won't need to be redone unless the devcontainer's Node version changes.
- The two React Router future-flag warnings (`v7_startTransition`, `v7_relativeSplatPath`) print during client tests and during in-browser navigation. Carried over from Slice 003; deferred as a follow-up.
- `vitest.config.ts` and `vitest.workspace.ts` were modified beyond strict spec scope (forks pool + 15 s testTimeout). Without those changes, the suite is flaky once it crosses ~200 tests. Flagged for the review under "Decisions worth flagging."
