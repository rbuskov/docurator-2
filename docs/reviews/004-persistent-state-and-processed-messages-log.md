# Slice 004: Persistent state and processed-messages log — Review

**Spec:** `docs/specs/004-persistent-state-and-processed-messages-log.md`
**Plan:** `docs/plans/004-persistent-state-and-processed-messages-log.md`

## Summary

Slice 004 lands the persistence backbone the rest of the project will rely on: three new SQLite tables (`processed_messages`, `sync_state`, `app_config`) via three append-only migrations, WAL + foreign-key enforcement on the existing connection, the repository pattern under `src/server/db/repositories/`, and a development-only "Dev tools" panel on the Dashboard that round-trips real Gmail message ids into `processed_messages` rows. The Observable result is met for everything verifiable from the agent shell — schema upgrade against the user's real `data/app.db` produces the expected tables; `PRAGMA journal_mode` returns `wal` and `PRAGMA foreign_keys` returns `1`; `app_config` is seeded with `(id=1, fiscal_year_start_month=1)`; the production binary returns 404 from both dev endpoints while still serving `/api/accounts` and `/health`. The browser-driven AC #3-#5 (clicking "Mark first 10 messages as processed", round-tripping real Gmail subjects + sender_domains, second-account isolation in the UI) are pinned at the unit-test layer and deferred to human acceptance — all 254 tests across 30 files pass on three consecutive runs.

The slice introduced one piece of test-harness work beyond strict spec scope: vitest's server project switched to `pool: 'forks'` and `testTimeout` raised from 5 s to 15 s. Without that change, the suite became flaky once it crossed ~200 tests because module-level singletons (the `_db` reference, the OAuth state map) leak between test files in the same thread-pool worker. Flagged below.

## What landed

- **DB tables / columns / migrations:**
  - `processed_messages(id, account_id, message_id, thread_id, internal_date, processed_at, model_used, status, error_message, classification, confidence, reason, sender_domain, subject)` with `INTEGER PRIMARY KEY AUTOINCREMENT`, FK on `account_id → accounts(id)`, all CHECK constraints from the spec, plus indices `(account_id, message_id, processed_at DESC)` and `(account_id, processed_at)`.
  - `sync_state(account_id PRIMARY KEY → accounts(id), last_history_id, last_synced_at)`.
  - `app_config(id PRIMARY KEY CHECK id=1, fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK 1..12)` plus an `INSERT OR IGNORE` seed of `(1, 1)`.
  - Three new files: `src/server/db/migrations/0002_create_processed_messages.sql`, `0003_create_sync_state.sql`, `0004_create_app_config.sql`. The runner from Slice 002 picks them up unchanged.
- **API endpoints:**
  - `POST /api/dev/processed-messages/seed` (404 in production, 400 on body validation, 404 / 409 / 401 / 502 / 200 on the various flows).
  - `GET /api/dev/enabled` (404 in production, `{ enabled: true }` otherwise).
  - `GET /api/accounts/:id/processed-messages` (no `nodeEnv` gate; reads from the local DB, returns the 10 spec-named fields ordered `processed_at DESC`, capped at 50).
- **UI views / components:**
  - `src/client/views/DevSeedPanel.tsx` — full self-contained panel: probes `/api/dev/enabled`, fetches `/api/accounts`, fetches `/api/accounts/:id/processed-messages` on picker change, POSTs to seed, refetches the table on success, renders inline status, disables the button while in flight.
  - `src/client/views/Dashboard.tsx` — extended with `<DevSeedPanel />` as the third child of `<main>`. Renders nothing extra in production (the panel returns `null` when `/api/dev/enabled` is 404).
- **Files / modules:**
  - `src/server/db/index.ts` — flips `journal_mode = WAL` and `foreign_keys = ON` on every fresh handle from `getDb()`.
  - `src/server/db/repositories/processed_messages.ts`, `sync_state.ts`, `app_config.ts` — the repository pattern, prepared-statement-cache via `WeakMap<Database, Map<string, Statement>>`, mirroring `src/server/auth/accounts.ts`.
  - `src/server/gmail/headers.ts` — `extractHeader` (promoted out of `messages.ts`) + new `parseFromAddressDomain` for sender-domain extraction.
  - `src/server/api/dev.ts` — the two dev routes.
  - `src/server/api/processed_messages.ts` — the row listing route.
  - `src/server/config.ts` — adds `nodeEnv` to the frozen config.
  - `src/server/app.ts` — wires the two new route registrars between `registerMessagesRoutes` and the static fallback.
  - `src/client/types.ts` — adds `ProcessedMessage` and the three enum types.
  - `.env.example` — documents `NODE_ENV` as the dev-endpoint gate.
- **Other:**
  - SQLite WAL mode is now active for all DB connections (every read/write benefits, not just this slice's writes).
  - SQLite foreign-key enforcement is on (the `account_id` references in the new tables are now enforced by the engine, not just declared).
  - `vitest.workspace.ts` server project: `pool: 'forks'`. `vitest.config.ts`: `testTimeout: 15000`. Both changes carry inline comments naming the underlying race.

## ADRs introduced

- None.

The research doc concluded that none of this slice's decisions cross the ADR bar — every choice is either named directly in `architecture.md` (WAL, FK enforcement, append-only `processed_messages`, repository pattern under `db/repositories/`) or is a routine implementation detail (substring vs regex parsing for `From`, sequential vs batched Gmail fetches in the dev tool, helper-promotion location). The judgment calls that *could* have gone differently are recorded in "Decisions worth flagging" below rather than in standalone ADRs.

## Test and smoke results

- **Test suite:** 30 test files, **254 tests, all passing**, 22.19 s end-to-end (`npx vitest run`). Of those, this slice authored 92 new tests:
  - `migrations.test.ts` +17 (3 new `describe` blocks for `0002`, `0003`, `0004`)
  - `db/index.test.ts` +3 (WAL pragma, foreign_keys pragma, both re-applied on reopen)
  - `db/repositories/processed_messages.test.ts` +15 (new file)
  - `db/repositories/sync_state.test.ts` +5 (new file)
  - `db/repositories/app_config.test.ts` +6 (new file)
  - `gmail/headers.test.ts` +16 (new file; `extractHeader` × 5, `parseFromAddressDomain` × 11)
  - `api/dev.test.ts` +20 (new file; production gate, validation, account discriminators, happy path + idempotency, error mapping, cross-account isolation)
  - `api/processed_messages.test.ts` +12 (new file)
  - `config.test.ts` +2 (`nodeEnv` default, `nodeEnv` from env)
  - `client/views/Dashboard.test.tsx` +1 (Dev tools panel renders when enabled; three existing tests refactored to URL-routed `mockImplementation`)
  - `client/views/DevSeedPanel.test.tsx` +11 (new file)
- **Smoke:** verified from the agent shell — schema upgrade against the user's real `data/app.db` produced all four tables, both pragmas, the seeded `app_config` row, and preserved the two pre-existing `accounts` rows. The production binary on `:3738` returned `404` from both dev endpoints (`GET /api/dev/enabled`, `POST /api/dev/processed-messages/seed`) while `/health` returned `200` and `/api/accounts` returned `200` with the two real accounts. SQLite-layer persistence verified by inserting + reading back through two separate `Database` handles. AC #3-#5 (browser-driven, real Gmail) are deferred to human acceptance — the contract is fully pinned at the unit-test layer; details in `plans/004-persistent-state-and-processed-messages-log.md` § "Smoke run".

## Code review notes

Findings from reviewing the diff against the spec and plan.

**Fixed during this spec**

- The plan's wording for the dev-seed transaction ("per-message transactions") contradicted its own test expectation ("502 + zero rows after a mid-loop getMessage failure"). Implemented all-or-nothing instead: Gmail fetches happen in phase 1 (no transaction), staged rows go into an in-memory list, then a single `db.transaction(() => { … })` wraps the existsForMessage/insert loop. If any Gmail call throws during phase 1, the transaction never opens and zero rows land. Test pins this contract.
- Promoted `extractHeader` from `src/server/api/messages.ts` to `src/server/gmail/headers.ts` (Step 6). The previous duplication-by-copy approach would have meant the dev seed and the Inbox listing diverged on header semantics if either was edited; a single home keeps them tight.
- Three Dashboard tests required restructuring beyond what the plan anticipated. The Dashboard's loading state defers `<DevSeedPanel />` mount until accounts resolve, so `/api/accounts` is the *first* fetch (not `/api/dev/enabled`). Tests using `mockResolvedValue` (without "Once") as a trailing default were silently consuming the panel's `/api/dev/enabled` request and breaking downstream assertions. Refactored the three affected tests (Reconnect click, reconnect-polling, append-new-account) to URL-routed `mockImplementation` with per-test counters where polling sequences matter. The simpler tests (loading state, empty list, error path) keep their `mockResolvedValueOnce` chains and rely on the `beforeEach` `mockImplementation` fallthrough for `/api/dev/enabled`.
- One TS `noUncheckedIndexedAccess` cleanup in `dev.test.ts` (`rows[0].sender_domain` → `rows[0]?.sender_domain` plus a `toHaveLength(1)` guard). Caught by `tsc --noEmit` after the test file landed.
- One flaky `DevSeedPanel.test.tsx` assertion. The "renders the picker, button, and table when enabled" test asserted on the `No rows yet for this account.` empty-state text without `waitFor` — fine in isolation, fails under full-suite parallelism because the rows fetch hadn't resolved yet. Wrapped the assertion in `waitFor`. The button-rendered assertion above it still uses `waitFor` and gates on the right state.
- Stability fix: `vitest.workspace.ts` server project switched to `pool: 'forks'`; `vitest.config.ts` `testTimeout` raised to 15 s. Once the server suite crossed ~200 tests, the first test in each file occasionally pushed past the default 5 s on `vi.resetModules()` + dynamic-import + `better-sqlite3` native-binding init. Under thread-pool sharing, that surfaced as `Database connection is not open` errors from the module-level `_db` singleton. Forks fully isolate module state per file at the cost of slower per-file startup.

**Followups for later**

- **Repository directory inconsistency.** The new repos live under `src/server/db/repositories/` (per `architecture.md` § "Project structure"); `src/server/auth/accounts.ts` stays under `auth/` for historical reasons. Moving `accounts.ts` would touch every importer (six call sites at last count) for no current functional gain — it's a cleanup follow-up, not a Slice 004 deliverable.
- **`messages.test.ts` and `dev.test.ts` first-test wall time.** Both files' first tests run in ~7-11 s on the server pool — well under the new 15 s timeout but worth investigating. The cost is dominated by `vi.resetModules()` + dynamic imports of `googleapis`'s type metadata + `better-sqlite3` native init. A cheaper test fixture (mocking the type imports earlier, or sharing a hoisted DB across tests in the same file) could reclaim several seconds per CI run.
- **Sender-domain parser coverage.** `parseFromAddressDomain` covers the common shapes (`Name <addr>`, bare `addr`, `<addr>`, quoted display name with comma, RFC-5322 group syntax bail). Pathological `From` headers — encoded MIME words (`=?utf-8?b?...?=`), comments (`(comment) addr`), nested angle brackets — return `null` rather than attempting to parse. If real Gmail data surfaces a pattern the parser bails on, expand the test fixture and the parser together.
- **`messages.ts`'s `isInvalidGrantError` is duplicated in `dev.ts`.** Slice 003's review flagged this as "extract if a third caller arrives." This slice is the third caller. Extract to `src/server/auth/invalid-grant.ts` in the Slice 005 or 006 cleanup pass.
- **`fetchMock` in `Dashboard.test.tsx` is a mix of styles now.** Four tests use `mockResolvedValueOnce` chains relying on the beforeEach fallthrough; three use URL-routed `mockImplementation`. A future cleanup could converge them on URL-routed mocks for consistency, but the current setup is correct and the test file's intent is clear from the per-test code.
- **React Router future-flag warnings.** Carried over from Slice 003; appear in the test stderr and in dev-mode browser navigation. Silenced by `future={{ v7_startTransition: true, v7_relativeSplatPath: true }}` on `<BrowserRouter>` / `<MemoryRouter>`. Not addressed here.
- **AC #6 full-flow proof.** SQLite-layer durability is covered. The "10 rows visible after a process restart, in the actual UI" version requires real OAuth + a connected account + the in-browser walkthrough, deferred to human acceptance. The same applies to AC #3-#5.

## Decisions worth flagging

- **All-or-nothing transaction for the dev seed (vs per-message).** The plan's prose said "per-message transactions" but its test expectation was all-or-nothing. The all-or-nothing implementation matches the test, satisfies AC #4 (re-click idempotency: re-clicking sees the same set of message ids and the existsForMessage check causes every one to be skipped), and is cleaner. Trade-off: if Gmail call 7 fails, calls 1-6's results are discarded — meaning the user clicks again to retry the whole batch. The opposite (per-message) would have left a partial state where calls 1-6 are inserted but the response is 502. All-or-nothing produces a more predictable post-failure state at the cost of duplicate Gmail calls on retry. A future Slice 006 sync orchestrator running across hundreds of messages may want different semantics; the dev seed's 10-message ceiling makes this a non-issue here.

- **`MAX_LIMIT = 50` for `/api/accounts/:id/processed-messages` (vs 100 for `/api/accounts/:id/messages`).** The spec's read endpoint defaults to 50 and the Slice 010 Audit view will define its own pagination ceiling. The Inbox endpoint's 100 ceiling is from Slice 003 and was a defensive bound on Gmail API calls. The two are different concerns; keeping the post-Slice-004 endpoint conservative until Slice 010 picks the real number is cheap.

- **No status gate on `GET /api/accounts/:id/processed-messages`.** The endpoint returns rows even when the account is `needs_reauth`. Locally-stored audit data is independent of OAuth state — a reconnected account in the future should still see its prior rows. The Audit view in Slice 010 will consume this same path. Pinned by a dedicated test ("returns rows even for an account in needs_reauth state").

- **`c.json({ error: 'not_found' }, 404)` for production gates (vs `c.notFound()`).** Hono's default `c.notFound()` returns a `Not Found` text body; the rest of the API uses JSON error shapes (`{error: '...'}` + status code). Picked the JSON shape for consistency.

- **Subject normalization: empty header → `null`.** The dev seed's `extractHeader(message, 'Subject') || null` collapses empty Subject values into `null` rather than storing `""`. The column is `TEXT NULL`; the spec is silent on the empty-vs-null choice. Easier downstream filtering ("rows missing a subject") and matches how `sender_domain` is stored when the parser bails.

- **Test-harness changes outside strict spec scope.** `vitest.workspace.ts` (server project → `pool: 'forks'`) and `vitest.config.ts` (`testTimeout: 15000`) are not deliverables the spec lists. They were necessary because the suite became flaky once it crossed ~200 tests on the default thread-pool config. Inline comments at both call sites name the race the change addresses. A more durable fix would refactor the singleton DB pattern itself; that's out of Slice 004's scope.

- **Repository placement: `auth/accounts.ts` stays under `auth/`.** Architecture's project structure puts repositories under `db/repositories/`. The new repos go there; `accounts.ts` remains where Slice 002 placed it because moving it would ripple through six callers. Flagged as a follow-up in this review and the next slice's research can decide whether to do the move.

- **`npm rebuild better-sqlite3` was a one-time fix.** The cached native binary was for the pre-devcontainer Node ABI; the devcontainer's Node 24 needed a rebuild. Now that the binary is in the post-devcontainer state it won't need to be redone unless the devcontainer's Node version changes. Documented in Step 1's plan note.

## Deviations from spec or architecture

- **Smoke recipe.** The spec's Observable result and several acceptance criteria reference `docker compose down && docker compose up` and `docker compose up --build`. The Dec 9 devcontainer-migration commit deleted `Dockerfile` and `docker-compose.yml`. The smoke recipe substituted (a) direct migration application + introspection against the user's existing `data/app.db`, and (b) `APP_PORT=3738 NODE_ENV=production node dist/server/index.js` for the production-gate verification. The property under test in each step (rows persist on disk; pragmas are sticky; production endpoints 404) is preserved verbatim — only the harness changed.

- **Dev-seed transaction wording.** The plan's prose said "per-message transactions"; the implementation went all-or-nothing because the plan's test assertion required it. The plan note acknowledged the contradiction; the review captures the resolved choice.

- **Repository directory consolidation.** Architecture's § "Project structure" implies all repositories live under `src/server/db/repositories/`. This slice creates the directory and places its three new repositories there but leaves Slice 002's `accounts.ts` under `src/server/auth/` (six callers, no current benefit to moving). Partial alignment; full cleanup is a future slice's call.

- No deviations from `architecture.md` § "Storage", § "Read-only Gmail access", or § "Privacy model" — every spec column landed verbatim, the Gmail surface is unchanged (the dev seed reuses the existing read-only client), and email content (body / attachments) is never persisted in `processed_messages`.
