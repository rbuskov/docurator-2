# Slice 002: Connect Gmail accounts — Review

**Spec:** `docs/specs/002-connect-gmail-accounts.md`
**Plan:** `docs/plans/002-connect-gmail-accounts.md`

## Summary

The Dashboard is born. The placeholder `<main>Docurator</main>` from Slice 001 is replaced by a real Dashboard view that lists connected Gmail accounts, exposes an "Add Gmail account" button that runs Google's OAuth flow with **only** the three required scopes (`gmail.readonly`, `openid`, `userinfo.email`), persists each account to a new `accounts` table in SQLite (with a tiny migration runner that subsequent slices will reuse), holds tokens in process memory keyed by `accounts.id`, and offers a Reconnect button on rows whose `status === 'needs_reauth'`. All eight spec acceptance criteria are covered by automated tests; the human-driven half of the smoke run (real Google consent + cross-account flow + Docker-built image) is documented as deferred and re-runnable from `.env`.

The slice ships **97 passing tests across 16 files** (server: 73, client: 24) and **one ADR** (`adr/002-bare-sql-migration-runner.md`). Three structural decisions are worth the human's eye: the `-at-` slug interpretation (resolves a contradiction inside the spec), the strict 400-on-mismatched-email behavior of the Reconnect callback, and the Real-Timer-with-injected-intervals approach the React polling tests use (after `vi.useFakeTimers` proved incompatible with vitest 2.1 + React 19 + RTL 16's promise scheduling).

## What landed

- **DB tables / columns / migrations:**
  - `accounts` table with the spec's seven columns + UNIQUE on `email`/`slug` + CHECK on `status`.
  - `_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` — managed by the new runner.
  - Migration `0001_create_accounts.sql` shipped under `src/server/db/migrations/` and copied to `dist/server/db/migrations/` by the build step.
- **API endpoints:**
  - `GET /api/accounts` — JSON list, sorted by `id ASC`.
  - `POST /api/oauth/start` — returns `{ consent_url, state }`; records state with `kind='add'`, 10-minute TTL.
  - `POST /api/accounts/:id/reconnect` — same shape, records state with `kind='reconnect', accountId=id`. 404 for unknown id, 400 for non-integer id.
  - `GET /oauth/callback?code=...&state=...` — exchanges code, decodes email from id_token, upserts (kind=add) or updates-in-place after email match (kind=reconnect), stores tokens, redirects to `/`. Returns 400 HTML on bad state, expired state, code-exchange error, or reconnect email mismatch.
- **UI views / components:**
  - `src/client/views/Dashboard.tsx` — fetches accounts on mount, renders heading + AccountList + AddAccountButton; tracks reconnectingId for the Reconnect-and-poll flow.
  - `src/client/components/AccountList.tsx` — empty-state CTA, row per account, Reconnect button only on `status='needs_reauth'`.
  - `src/client/components/AddAccountButton.tsx` — `postJson('/api/oauth/start')` + `window.open(consent_url)` + polling for new account id; surfaces a timeout alert and a postJson-failure alert.
  - `src/client/hooks/useAccountsPoll.ts` — shared poll-with-predicate-and-timeout hook.
  - `src/client/api.ts` — tiny `getJson<T>` / `postJson<T>` `fetch` wrapper with body-text-in-error-message.
  - `src/client/types.ts` — shared `Account` and `AccountStatus` types.
  - `src/client/test-setup.ts` — `afterEach(cleanup)` for RTL.
  - `src/client/App.tsx` — now `<Dashboard />`.
- **Files / modules (server):**
  - `src/server/db/index.ts` — singleton `getDb()` with `setDbPathForTest`.
  - `src/server/db/migrate.ts` — bare-SQL runner (see ADR-002).
  - `src/server/auth/slug.ts` — pure `slugify(email)`.
  - `src/server/auth/accounts.ts` — repository: `findByEmail`, `findById`, `findBySlug`, `insert` (with collision suffix loop), `updateStatus`, `touchLastSeen`, `list`. Statements cached per-`Database` via `WeakMap`.
  - `src/server/auth/oauth.ts` — `buildConsentUrl({ state })`, `exchangeCode(code)`, `redirectUri()`, `SCOPES`. Factory-injectable for tests.
  - `src/server/auth/session.ts` — in-memory `Map<accountId, { client, refreshToken }>`, `set/get/clear`, `withFreshTokens`. Module-level factory setter for tests. On `invalid_grant` flips status + clears.
  - `src/server/api/accounts.ts`, `src/server/api/oauth.ts` — route registrars.
  - `src/server/config.ts` — adds `googleClientId`, `googleClientSecret`, `oauthRedirectPort`, `dbPath`.
  - `src/server/index.ts` — `mkdirSync(data dir) → migrate(getDb(), migrationsDir) → serve(...)`.
  - `src/server/app.ts` — registers `/health`, accounts routes, oauth routes, then static fallback.
- **Tests:** 16 files / 97 tests (full breakdown in plan's `## Test run`).
- **Tooling / config:**
  - `package.json` adds runtime deps `better-sqlite3`, `googleapis`, `google-auth-library`; dev deps `@types/better-sqlite3`, `@testing-library/{react,dom,user-event}`, `jsdom`. Build script extended to `cpSync` migrations into `dist/`.
  - `vitest.workspace.ts` — server (Node) + client (jsdom) projects via plain array export.
  - `vitest.config.ts` — minimized; shared by both projects via `extends`.
  - `tsconfig.json` — `vitest.workspace.ts` added to includes.
  - `docker-compose.yml` — passthrough for `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, bind-mount `./data:/app/data`.
  - `.env.example` — documents the four env keys.
  - `data/.gitkeep` — force-included via `/data/*` + `!/data/.gitkeep` exception in `.gitignore`.
- **Loop artefacts:** `docs/research/002-connect-gmail-accounts.md`, `docs/plans/002-connect-gmail-accounts.md`, this review.

## ADRs introduced

- `docs/adr/002-bare-sql-migration-runner.md` — Pure `*.sql` files in `src/server/db/migrations/`, applied in lexical order, tracked by single `_migrations` table, transactional, no down-migrations or checksums. Rejects Drizzle Kit, kysely-migrator, db-migrate, knex-migrate.

## Test and smoke results

- **Test suite:** 16 files / 97 tests, all passing in 2.82 s (`npx vitest run` on 2026-05-09).
- **Smoke:** `node dist/server/index.js` substituted for `docker compose up` (sandbox couldn't reach Docker registry). Verified `/health`, `/`, `/api/accounts` (empty + populated), `POST /api/oauth/start` (consent URL contains exactly the three required scopes URL-encoded), `POST /api/accounts/999/reconnect` → 404, `POST /api/accounts/1/reconnect` → 200 (synthesized row), `GET /oauth/callback?state=invalid` → 400 HTML "Couldn't connect", migration ran on the local volume, `accounts` schema matches spec verbatim, **persistence across process restart** (synthesized `needs_reauth` row survives), and `grep` confirms `gmail.readonly` is the only Gmail scope in production code (AC #8). Full transcript in plan's `## Smoke run`. The Google consent screen + cross-account flow + AC #5's revoke-at-Google path are documented as human-only deferrals.

## Code review notes

**Fixed during this spec:**

- *Spec contradiction on slug derivation.* The spec's Files/modules bullet says "replaces `@` and `.` with `-`" (which would produce `alice-example-com`), but the Detailed-design example and `architecture.md` consistently say `alice-at-example-com`. Resolved in favor of the example because the architecture is consistent on `-at-` (lines 189, 269, 312) and `-at-` is the more readable filesystem-friendly form. Documented in research; recorded under "Decisions worth flagging" below.
- *vitest 2.1 + vite 6 type collision in `defineWorkspace`.* `@vitejs/plugin-react` is built against vite 6 while vitest 2.1 ships vite 5 internally; the helper's strict types reject the plugin assignment. Worked around with a plain array export from `vitest.workspace.ts`. Annotated in `vitest.workspace.ts` and the plan; ADR-001 already anticipated a vitest 3 chain update.
- *`vi.useFakeTimers` incompatible with React 19 + RTL 16 + `@testing-library/user-event` 14.* Even excluding `queueMicrotask` from the `toFake` list, click events hung indefinitely. Switched the polling tests to **real timers with short injected intervals** (new `pollIntervalMs?` / `pollTimeoutMs?` props on Dashboard + AddAccountButton). Tests run in 501 ms total; the props double as future product knobs.
- *DOM leak between RTL renders.* Added `src/client/test-setup.ts` registering `afterEach(cleanup)`, wired into the client project's `setupFiles`.
- *`tsconfig.server.json`'s `rootDir: src/server` excludes `*.sql`.* Build script now does `node -e "fs.cpSync(...)"` to copy migrations into `dist/server/db/migrations/`. Verified by `npm run build` + `ls dist/server/db/migrations/`.
- *`config.ts` validation — partially deferred.* Per research, OAuth secrets are read eagerly but stay empty when unset; validation is deferred to the OAuth route handlers. The route handlers don't currently validate non-empty before constructing the consent URL — see followups.

**Followups for later (non-blocking, captured for future slices):**

- *Empty `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` produce a confusing error.* If a user runs the app without populating `.env`, `POST /api/oauth/start` returns a consent URL with `client_id=` empty; Google's consent screen errors out with a less-clear message. Suggest adding a route-handler guard that returns 503 with a "GOOGLE_CLIENT_ID not configured — populate .env" body before constructing the URL. Not blocking because the architecture explicitly requires the user to provide their own credentials per `architecture.md` § "Open source considerations"; the README walkthrough (Slice 016) is the canonical onboarding doc.
- *No `dotenv` dependency.* `docker compose` reads `.env` natively, but `npm run dev` (host-side) does not — the developer must export `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in their shell. README will document this; Slice 016 may add a host-side `dotenv-cli` invocation if it grates.
- *No graceful SIGTERM handler in `src/server/index.ts`.* Inherited from Slice 001's review followups. Slice 004 (when WAL mode arrives) is the natural moment to wire `server.close()` + DB checkpoint on signal.
- *StrictMode-induced double-fetch on Dashboard mount in dev.* `main.tsx` wraps `<App />` in `<StrictMode>`, which causes `useEffect` to fire twice in dev mode. The Dashboard's mount effect runs `loadAccounts()` twice → two `GET /api/accounts` requests. The second overwrites the first, so behavior is correct but wasteful. Production builds don't double-fire. Not worth fixing in this slice.
- *`OAUTH_REDIRECT_PORT` not passed through docker-compose env block.* The spec's `docker-compose.yml` updates only list `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Hosts that set `OAUTH_REDIRECT_PORT` outside the container get the default `3737` instead. Acceptable for v1 because the only use case (port-mapping override) is rare; document if it surfaces.
- *`src/client/jsdom-env.test.tsx` is now redundant.* The four real client test files already exercise jsdom. Could be removed without loss; harmless to keep as a canary if the workspace ever reverts to Node-only by mistake.
- *`vitest.config.ts` reduced to `reporters: 'default'`.* Could be deleted entirely (workspace projects extend an empty config), but tsconfig already references it and the file is a natural place for future shared options. Left in.
- *AC #5 (Google revoke → invalid_grant → needs_reauth) not exercised end-to-end.* Slice 002 has no Gmail-touching path that triggers a refresh. The unit test in `session.test.ts` covers the refresh-failure → status flip → clear logic; the end-to-end exercise lands in Slice 003 once the Inbox view makes Gmail API calls.

## Decisions worth flagging

- **Slug `-at-` interpretation.** Spec text and example contradict each other; chose the example because architecture is consistent on `alice-at-example-com`. If the spec author intended the literal "@→-" reading (`alice-example-com`), this is a bug. **Reasonable disagreement zone:** human could prefer the simpler reading.
- **Reconnect with mismatched email returns 400, doesn't insert a new row.** Spec is silent on this edge case; implementation refuses to silently insert a duplicate row when the user signs in as a different Google identity during Reconnect. The error page names both the registered and signed-in addresses. Alternatives considered: (a) silently fall through to the `kind=add` path, inserting a new row — rejected because it would surprise users who clicked "Reconnect alice" and saw "bob" appear. (b) Update the existing row's `email` to the new address — rejected because `email` is the row's stable key and changing it could break sender-memory and audit log scoping in later slices.
- **No ID token signature verification.** The id_token is decoded by base64url-parsing the payload segment; the JWT signature is **not** verified against Google's JWKS. Acceptable here because the id_token came back over TLS as the response to `getToken(code)`, and we never use the token outside the synchronous decode in the same callback. If a future slice persists or forwards the id_token, signature verification should be added.
- **Real-timer-with-injected-intervals testing approach for React polling.** Plan called for `vi.useFakeTimers()`; the React 19 + RTL 16 + user-event 14 + vitest 2.1 stack hung indefinitely under fake timers (even with `queueMicrotask` excluded from `toFake`). Switched to real timers + short `pollIntervalMs`/`pollTimeoutMs` props passed in tests. **The props are a permanent part of the API**, not just a test seam — they'll be useful as production knobs (slow connection → longer interval). Human could prefer test-only `__INTERNAL_*` prefixes if they don't want them in the public surface.
- **`createApp` registers all routes by default (no DI flag).** Plan called for an option-flagged DI shape so tests could opt out of OAuth/accounts route registration. Implementation skips the flag because OAuth and accounts route handlers don't touch the DB at registration time — Slice 001's `app.test.ts` paths (`/health`, `/`) keep working without DB setup. The DI hook for tests lives at the per-route level (`registerOauthRoutes(app, deps)`, `setSessionClientFactoryForTest`, `setDbPathForTest`).
- **`pollIntervalMs`/`pollTimeoutMs` exposed on Dashboard + AddAccountButton.** Same as above — test seam doubling as product knob. Caller-injection is cleaner than a globals-shaped configuration.

## Deviations from spec or architecture

- **Slug algorithm uses `@→-at-` rather than the spec's terse "@→-".** Discussed above; the example wins.
- **`vitest.workspace.ts` (new file).** Spec doesn't enumerate test infrastructure. The two-project (server/client) workspace is the natural Vitest 2.x shape for this codebase; documented in plan step 2.
- **`pollIntervalMs?` / `pollTimeoutMs?` props on Dashboard + AddAccountButton.** Not listed in spec's component descriptions. Optional, default to 2 s / 5 min — production behavior unchanged.
- **`Object.freeze`d `config` exposes `dbPath` constant.** Spec lists `APP_PORT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_PORT`. `dbPath` is implementation detail (`./data/app.db` per architecture); kept in `config` for `setDbPathForTest`-shaped overrides at the DB layer. Not a behavioural deviation — same path the spec mandates.
- **`/data/*` + `!/data/.gitkeep`** rather than the spec's "append `!data/.gitkeep` to `.gitignore`". Gitignore semantics require ignoring the directory's contents (`/data/*`) for re-includes (`!/data/.gitkeep`) to take effect — `git check-ignore` confirms the desired behavior either way. Functionally identical to spec intent.
- **`createApp` always registers routes (no DI flag).** Discussed above.
- **No deviations from `docs/architecture.md`.** OAuth scopes match § "Read-only Gmail access" exactly. Storage shape matches § "Storage" exactly. OAuth flow matches § "OAuth (loopback redirect, no persistence, per account)" exactly. Project structure is a strict subset of § "Project structure". Compose layout matches § "Docker Compose layout" minus the env/volume entries scoped to Slices 005/006.
