# Slice 002: Connect Gmail accounts — Research

**Spec:** `docs/specs/002-connect-gmail-accounts.md`

## Summary of what the spec asks for

The Dashboard is born. From the placeholder `<main>Docurator</main>` from Slice 001, this slice grows it into a list of connected Gmail accounts with an "Add Gmail account" button that runs Google's OAuth flow (`gmail.readonly` + `openid` + `userinfo.email` only), persists each account to a new `accounts` table in SQLite, holds the resulting access/refresh tokens in memory keyed by `accounts.id`, and exposes a "Reconnect" button on rows whose `status === 'needs_reauth'`. The Observable result is "I can click Add Gmail account, complete Google's consent flow, and see the connected address listed". Headline deliverables are the `accounts` table + `0001_create_accounts.sql` migration, a tiny migration runner, the OAuth + token-store + accounts-repo + slug modules, three OAuth-related API endpoints + one accounts endpoint, and the Dashboard / AccountList / AddAccountButton React trio. New env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_PORT` (defaulting to `APP_PORT`); `.env.example` documents all four (including the slice-001 `APP_PORT`); `docker-compose.yml` learns to pass through the two Google secrets and to bind-mount `./data` so `app.db` survives restarts.

## Existing code that this spec touches

What's actually in the tree today (post-Slice 001):

- `src/server/index.ts` — boots the Hono listener via `serve(...)`. Will need to call `migrate()` before `serve()` so the schema exists when the first request lands. Edit, don't replace.
- `src/server/app.ts` — exports `createApp({ staticDir? })`. Will register the new OAuth + accounts routes. The shape (a factory that returns a `Hono`) is what tests already lean on; route registration goes inside.
- `src/server/config.ts` — exports `Object.freeze({ port })`. Adds `googleClientId`, `googleClientSecret`, `oauthRedirectPort` (defaults to `port`). Stays a frozen, eager-read snapshot so tests can `vi.resetModules()` to re-evaluate per-test as `config.test.ts` already does.
- `src/server/api/.gitkeep` — placeholder from Slice 001. Stays. The new `oauth.ts` and `accounts.ts` API modules go alongside it.
- `src/client/App.tsx` — currently `<main>Docurator</main>`. Replaced by a Dashboard that renders the same heading text plus the accounts UI. Slice 001's "page contains 'Docurator'" criterion still holds, by design (spec: "the literal 'Docurator' placeholder text is now the Dashboard's heading").
- `src/client/main.tsx` — unchanged; just keeps mounting `<App />`.
- `src/client/index.html` — unchanged.
- `docker-compose.yml` — currently `build: .`, port mapping, `extra_hosts`. Adds `environment: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET` (passthrough from host) and `volumes: ./data:/app/data`.
- `Dockerfile` — multi-stage. **Risk:** runtime stage installs deps with `npm ci --omit=dev` but the build context only `COPY`s `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `src/`. We'll need to add `src/server/db/migrations/` (already covered by `COPY src ./src`, but `*.sql` needs to make it through TypeScript's emit untouched — see "Risks" below). The runtime image will need to include `better-sqlite3`'s native binary; see the Alpine risk below.
- `package.json` — adds runtime deps `better-sqlite3`, `googleapis`, `google-auth-library`, plus the React Router family **deferred to Slice 003** (not added here). Adds dev deps `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `jsdom`, `@types/better-sqlite3`. Also adds a `migrate` script (optional, for ergonomics).
- `.gitignore` — already has `/data/`. Force-add `data/.gitkeep` is the trick to keep the directory present without un-ignoring user data files.
- `vitest.config.ts` — currently a single Node-env config. Adds a Vitest *project* (or per-file `// @vitest-environment jsdom`) for client-side React tests. The plan picks one of the two; both work. Project config is more discoverable.
- `tsconfig.json` — fine as-is (Bundler resolution, both trees, `noUncheckedIndexedAccess`).
- `tsconfig.server.json` — fine as-is; SQL migration files are not TypeScript so they're simply untouched by the emit. Server build needs to *include* them at runtime, though — see "Risks".
- `docs/adr/000-adr-template.md` — populated in Slice 001; reused as-is.

Files / modules the spec creates from scratch (no existing analogue):

- `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/migrations/0001_create_accounts.sql`
- `src/server/auth/accounts.ts`, `src/server/auth/oauth.ts`, `src/server/auth/session.ts`, `src/server/auth/slug.ts`
- `src/server/api/oauth.ts`, `src/server/api/accounts.ts`
- `src/client/views/Dashboard.tsx`, `src/client/components/AccountList.tsx`, `src/client/components/AddAccountButton.tsx`, `src/client/api.ts`
- `data/.gitkeep`
- `.env.example`

## Patterns to follow

This slice introduces several patterns that subsequent slices will reuse. Each is the simplest viable choice that doesn't paint future specs into a corner.

- **DB connection (`src/server/db/index.ts`).** A module-scoped singleton: `let db: Database.Database | undefined; export function getDb(): Database.Database { return db ??= new Database(config.dbPath) }`. Lazy so tests can swap `config.dbPath` first; idempotent so re-imports under `vi.resetModules()` don't open new handles. **No WAL mode** in this slice — Slice 004 turns it on, and a subsequent ADR will pin the choice. The path is fixed at `./data/app.db` (relative to process CWD, which Docker sets to `/app`); tests override via a temp-file path. Repository modules import `getDb()` rather than receiving a connection — keeps call sites terse, matches the "one module per table on prepared statements" pattern from `architecture.md` § "Project structure".

- **Migration runner (`src/server/db/migrate.ts`).** Bare-bones: read `*.sql` files from `./migrations/` in lexical order; each file's filename is recorded in a `_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` table; unapplied files run inside a single transaction (`db.transaction(...)`), with the filename insert appended to that transaction so a partial failure rolls back cleanly. Runs once at server startup before `serve(...)`. No down-migrations, no checksums, no out-of-order detection — Slice 004 may revisit if it adds enough migrations to make those features pull weight. **This pattern warrants an ADR** (see "Risks").

- **Repository layer (`src/server/auth/accounts.ts`).** One file per logical table. Exports plain functions, each calling a prepared statement. Statements are lazily prepared the first time the function runs (to keep tests' temp-DB setup simple) and cached in a `WeakMap<Database, Statement>` so swapping `getDb()` between tests doesn't leak. Functions for this slice:
  - `findByEmail(email): Account | undefined`
  - `findById(id): Account | undefined`
  - `insert({ email, display_name, slug, connected_at }): { id, slug }`
  - `updateStatus(id, status: 'connected' | 'needs_reauth')`
  - `touchLastSeen(id, at: string)`
  - `list(): Account[]`
  Where `Account` is a TypeScript type matching the column names verbatim — `id`, `email`, `display_name`, `slug`, `connected_at`, `last_seen_at`, `status`. **Pure DB access**, zero OAuth knowledge — tested by inserting + reading rows on a temp SQLite file, no mocks needed.

- **Slug derivation (`src/server/auth/slug.ts`).** `slugify(email): string` is pure (no DB access). The DB-aware uniqueness loop lives in `accounts.ts`'s insert path, calling `slugify(email)` and then probing for collisions. Algorithm:
  1. Lowercase
  2. Replace `@` with `-at-` (so `alice@example.com` → `alice-at-example.com`, then step 3 normalizes)
  3. Replace each character outside `[a-z0-9-]` with `-`
  4. Collapse runs of `-` into a single `-`, trim leading/trailing `-`
  5. (At call site, in `accounts.insert`) — append `-2`, `-3`, … if `slug` is already taken
  This produces the architecture's canonical example `alice-at-example-com`. The spec's bullet text ("replaces `@` and `.` with `-`") is a loose paraphrase and conflicts with the example given two paragraphs later ("alice@example.com → alice-at-example-com"); the **example wins** because (a) it's the more concrete description, (b) it's used consistently in `architecture.md` (§ "Storage", § "File store", § "Project structure"), and (c) `-at-` is more readable for filesystem paths, which is the stated purpose ("Used for the file-store path in Slice 006"). Flagged in the review under "Decisions worth flagging".

- **OAuth wrapper (`src/server/auth/oauth.ts`).** Wraps `google-auth-library`'s `OAuth2Client` per call rather than caching. Exports:
  - `buildConsentUrl({ state }): string` — internally constructs an `OAuth2Client` with `(googleClientId, googleClientSecret, redirectUri)`, calls `generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [GMAIL_READONLY, OPENID, USERINFO_EMAIL], state })`. Scopes are exported constants used elsewhere in tests so the build-time grep guard from Slice 003 has a single canonical reference.
  - `exchangeCode(code): Promise<{ tokens, email }>` — constructs a fresh `OAuth2Client`, calls `getToken(code)`, then decodes the `id_token` to read the `email` claim (no separate `userinfo` HTTP call). Returns `{ tokens: { access_token, refresh_token, expiry_date, id_token }, email }`. Decoding is a `JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))` — the ID token came from Google over TLS so we don't need to verify the signature in this slice; we trust the channel. (The spec doesn't require signature verification for an authorization-code result; Google's library would have done its own RTT verification when exchanging the code.)
  - The `redirect_uri` is `http://localhost:${oauthRedirectPort}/oauth/callback` — built from `config.oauthRedirectPort` so tests can override.

- **Token store (`src/server/auth/session.ts`).** A `Map<accountId, { client: OAuth2Client, refreshToken: string }>` in module scope. `set(accountId, { tokens, refreshToken })` constructs an `OAuth2Client`, calls `client.setCredentials(tokens)`, registers `client.on('tokens', (refreshed) => ...)` to keep our cached `refresh_token` and the client's internal credentials in sync, and stores the entry. `get(accountId)`, `clear(accountId)` are mechanical. `withFreshTokens(accountId, callback)` calls `client.getAccessToken()` (which auto-refreshes if needed) inside a `try / catch (err)` — on `err.response?.data?.error === 'invalid_grant'` (or `err.message.includes('invalid_grant')` as a fallback) we `clear(accountId)`, call `accounts.updateStatus(accountId, 'needs_reauth')`, and **rethrow** so the API caller can return a meaningful response to the UI. The `tokens` event listener pattern is the canonical way `google-auth-library` surfaces refreshes; we don't poll for expiry.

- **OAuth state map (in `src/server/api/oauth.ts`).** Local `Map<state, { kind: 'add' | 'reconnect', accountId?: number, expiresAt: number }>`. `expiresAt = Date.now() + 10 * 60_000`. Pruned lazily on every read (and on state insert if the map grows beyond, say, 100 entries — a soft cap to keep memory bounded; OAuth flows are never bursty in this app). State strings are `crypto.randomUUID()` — opaque, 122 bits of randomness, enough for an OAuth nonce given that no business-critical secret is gated by the state parameter (it's only used for "is this callback ours?" + "which row to update?"). Process-restart wipes the map; in-flight OAuth sessions older than the restart are simply re-tried by clicking Add again.

- **API endpoints (Hono routes).**
  - `POST /api/oauth/start` — handler reads nothing from the body, generates a state, records `{ kind: 'add', expiresAt }`, returns `{ consent_url, state }` as JSON. **Response body parity with the spec is exact**: `consent_url` (snake_case), `state`.
  - `GET /oauth/callback?code=...&state=...` — non-`/api`-prefixed because Google redirects here; the `architecture.md` § "Sync (manual trigger)" sentence ("only non-prefixed backend path is `/oauth/callback`") makes this explicit. Validates state, exchanges code, decodes email from id_token. If state's `kind === 'add'` and an `accounts` row already exists for that email: this is a *re-add* of the same address; treat as the reconnect path (update `status='connected'`, refresh `last_seen_at`). If `kind === 'reconnect'`, the row at `accountId` must exist; update it. Otherwise insert. Stores tokens in the session map. Returns HTTP 302 to `/`. On any thrown error during exchange / id-token decoding, returns a small HTML page (`<!doctype html><html><body><h1>Couldn't connect this account</h1><p>{message}</p><p>You can close this tab.</p></body></html>`) with status 400 — matches the spec's "small HTML page summarizing the error".
  - `GET /api/accounts` — returns `{ accounts: list().map(toApi) }` where `toApi` strips internal fields (none, currently — every column the table has is in the spec's response shape). JSON Content-Type.
  - `POST /api/accounts/:id/reconnect` — verifies the account exists, generates a state recording `{ kind: 'reconnect', accountId, expiresAt }`, returns `{ consent_url, state }`. 404s on unknown id.

- **React structure.** `src/client/App.tsx` becomes the layout shell rendering `<Dashboard />`. There is no router yet — Slice 003 introduces React Router. `Dashboard.tsx` is a function component that fetches `GET /api/accounts` on mount via `src/client/api.ts` (a tiny `fetch` wrapper exporting `getJson(url)` and `postJson(url, body?)`), tracks `{ accounts, error, loading }` in `useState`, and renders:
  - `<h1>Docurator</h1>` (preserves the slice-001 visible text)
  - `<AccountList accounts={...} onReconnect={...} />` (or empty-state CTA when `accounts.length === 0`)
  - `<AddAccountButton onAdded={refetch} />`
  Component tests cover the rendering + the polling helper. **Polling.** The Add button opens `consent_url` in a new tab via `window.open`, then sets a 2-second `setInterval` that calls `getJson('/api/accounts')` and compares the returned ids against the pre-Add snapshot; first time a new id appears, fire `onAdded(newAccount)` and stop polling. A 5-minute timeout (`setTimeout`) clears the interval and surfaces a "took too long, click Add again" message. The same mechanism powers Reconnect, but instead of "new id appears" the trigger is "this id's `status` flips from `needs_reauth` to `connected`".

- **Test setup additions.**
  - **Vitest projects.** Add `projects: [{ name: 'server', environment: 'node' }, { name: 'client', environment: 'jsdom' }]` (or use `environmentMatchGlobs`) so server tests stay fast under Node and client tests get a DOM. Picking projects (rather than per-file `// @vitest-environment jsdom`) makes the convention discoverable and keeps a global env switch cost-free.
  - **DOM utilities.** `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `jsdom`. Picked over `happy-dom` because RTL's docs and most React community examples assume jsdom; `happy-dom`'s speed advantage is small at our test count.
  - **HTTP mocking.** No `msw` for now — `vi.fn().mockResolvedValue(new Response(...))` on `globalThis.fetch` is enough at this scale, and avoids an extra dependency for one slice. Revisit if mocking turns gnarly in Slice 003.

- **`.env.example` format.** Plain-shell-style key/value, no `=value` for secrets, with a `#` comment block at the top pointing the reader at the README walkthrough (which doesn't exist yet but will arrive in Slice 016). Documenting the four keys: `APP_PORT=3737`, `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `OAUTH_REDIRECT_PORT=` (with a comment that says "defaults to APP_PORT").

## Refactors needed before adding the new feature

Three small ones, none big enough to be a separate slice:

- **`src/server/index.ts` calls `migrate()` before `serve()`.** The current entrypoint just constructs the app and starts the listener. Insert one line after the imports: `await migrate()` (or sync if we go sync-only — `better-sqlite3` is sync, and we can keep the runner sync to match). Failure to migrate aborts startup with a clear error to stderr — `architecture.md` § "Components — Storage" expects a single durable schema; a half-migrated DB would be worse than not starting.

- **`src/server/config.ts` adds OAuth-related fields.** Currently exports `Object.freeze({ port })`. Adds `googleClientId`, `googleClientSecret`, `oauthRedirectPort`, `dbPath`. Reads from `process.env`; required values throw on import if missing **only when the env var is referenced** — i.e. lazy validation via getter functions, not throw-on-import. Otherwise unit tests that don't touch OAuth would fail to import the module. The simpler shape: `config.googleClientId` is a getter that throws if unset on read; tests stub `process.env` before import. Or: read eagerly with a non-empty-string default in `process.env.NODE_ENV === 'test'`. The latter is uglier; lazy getters are cleaner. Decide in the plan.

- **`src/client/App.tsx` replaced with the Dashboard composition.** The old `<main>Docurator</main>` becomes `<Dashboard />` (which itself renders the heading). One-file edit; no API breakage.

## Risks and open questions

- **`better-sqlite3` on `node:20-alpine` (native modules).** Slice 001's review explicitly flagged this as the moment of truth: "Slice 004 (when SQLite arrives) … is the natural moment to confirm Alpine still works or flip to `node:20-bookworm-slim` with a fresh ADR." Slice 002 hits it earlier than the review predicted. `better-sqlite3` ships prebuilt binaries for Linux/musl on x64 and arm64 via `prebuild-install`, but if the prebuild for the resolved Node 20 + abi version is missing, npm falls back to building from source — which needs `python3`, `make`, `g++`, none of which `node:20-alpine` ships. If the prebuild covers our case (it usually does for current LTS Node), we add nothing to the Dockerfile. If not, we add a one-line `apk add --no-cache python3 make g++` to the builder stage and rely on `npm ci --omit=dev` in the runtime stage to copy the prebuilt `node_modules/better-sqlite3/build/` over. The cleanest fallback is `node:20-bookworm-slim` (glibc, prebuilds always work) at the cost of ~50 MB image size. **Plan stance:** try Alpine first. If it works, no ADR. If we have to add build tools or flip the base image, that's a fresh ADR (`adr/002-...`) co-shipped with the spec's commit.

- **SQL migration files at runtime.** The Dockerfile's runtime stage copies `dist/`, not `src/`. The migration files live under `src/server/db/migrations/*.sql`. Two options:
  1. **Copy migrations into `dist/` during the build** — extend the build script: `vite build && tsc -p tsconfig.server.json && cp -r src/server/db/migrations dist/server/db/migrations`. The migration runner then resolves paths relative to `dist/server/db/`. Simple, explicit.
  2. **Move migrations under `dist/` in the runtime stage's `COPY`** — the Dockerfile adds a separate `COPY src/server/db/migrations /app/dist/server/db/migrations` line.
  Option 1 wins because it keeps the development behavior (`npm run dev` running `tsx`) and the production behavior aligned: both look in `dist/server/db/migrations/` (in dev, `tsx` would still look in `src/...` — the runner uses `import.meta.url` to compute the path, so it falls naturally into `src/server/db/migrations/` under dev and `dist/server/db/migrations/` after build). The exact resolution: `path.resolve(fileURLToPath(import.meta.url), '../migrations')`. Test it explicitly with a vitest case that points the runner at a fixture migrations dir.

- **`tsconfig.server.json`'s `rootDir: src/server` excludes `*.sql`.** Even with the cp step above, `tsc` doesn't copy non-TS files. So we **must** use option 1's `cp -r` step. There's no risk of regression — adding a build step is additive — but the build script gets longer. `npm run build`'s exit code 0 (and presence of `dist/server/db/migrations/0001_create_accounts.sql`) is the verification.

- **`google-auth-library` ID token decoding.** We trust the channel rather than verifying the signature on the ID token — no JWKS fetch, no JWT signature check. This is acceptable here because (a) the ID token came back over TLS as the response to `getToken(code)`, which `google-auth-library` itself verifies the response of; (b) we never use the ID token outside of the synchronous decode in the same callback. We do *not* persist the ID token. If a future slice wants to use the ID token after the OAuth callback completes, it should verify the signature via Google's certs. Flag in review as "Decisions worth flagging".

- **`oauth2.tokens` listener and refresh-token retention.** When `google-auth-library` refreshes, the new credentials may *omit* `refresh_token` (Google only returns it on the first consent + when `prompt=consent` is forced; subsequent refreshes return only `access_token` + `expiry_date`). The `tokens` event handler must preserve the original `refresh_token` if the new payload doesn't include one. The library handles this internally for `setCredentials` invocations, but our shadow `Map` entry must do it too. Test explicitly with a stubbed event payload.

- **AC #5 is end-to-end-only.** "Manually revoking the app's access … produces an `invalid_grant` … flips that row's `status` to `needs_reauth`." Slice 002 has no Gmail-touching path that would *trigger* a refresh, so this AC is verifiable only via unit tests of `session.withFreshTokens` with a stubbed `OAuth2Client` that throws `invalid_grant`. The smoke test cannot exercise it. **Plan stance:** add a unit test that stubs `client.getAccessToken()` to throw `invalid_grant`, asserts that `withFreshTokens` calls `accounts.updateStatus(accountId, 'needs_reauth')` and `clear(accountId)`, and rethrows. Note in the review that the end-to-end exercise of AC #5 lands in Slice 003 (the first slice that calls `withFreshTokens` from a request handler).

- **`/oauth/callback` redirect target with custom port.** Spec mandates the redirect URI is `http://localhost:{APP_PORT}/oauth/callback` (or `OAUTH_REDIRECT_PORT` if set). When the user runs Docker with a non-default `APP_PORT`, Google's consent screen will show that port in the URL, and the user's host machine must have the same port mapped through Docker. The spec's `docker-compose.yml` change passes `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` but **does not** template the port mapping (`"3737:3737"` is hard-coded in the existing compose file). For Slice 002 this is fine because everyone uses the default; in a future slice that supports overriding `APP_PORT`, we'd need to template the compose port mapping or document the constraint. Not a blocker; flag in review followups.

- **No `dotenv` library.** `docker compose up` reads `.env` from the project root automatically (Compose's default behavior); the variables flow into the container's environment. Slice 002 doesn't need `dotenv` in `package.json`. For host-side `npm run dev` (i.e. when developing without Docker), we'll either rely on the developer's shell `.env` sourcing or document one of `npm run dev` invocations exporting the vars manually. Flag in review.

- **`data/.gitkeep` and `.gitignore`.** `/data/` is currently ignored. Force-tracking `data/.gitkeep` requires `git add -f data/.gitkeep` at first commit and stays tracked thereafter. The `data/.gitkeep` file is committed via the slice's standard commit (priority 7) — the commit slash command handles staging, but we should ensure the `-f` flag is used or add a `!data/.gitkeep` rule to `.gitignore`. The latter is cleaner long-term: append `!data/.gitkeep` to `.gitignore` so `git add` of any file in `data/` requires `-f` *except* `.gitkeep`. **Plan stance:** add the `!data/.gitkeep` exception to `.gitignore`, then `git add data/.gitkeep` works without `-f`.

- **Migration runner ADR.** The migration runner is tiny but it's a project-wide pattern that future slices (004, 008, 009, 011, 013, …) will all hit. Drizzle, kysely-migrator, knex, custom — alternatives exist, and the choice has consequences for how schemas are evolved. **This warrants ADR-002.** Co-shipped with the slice's commit. Captures: pure-SQL files, lexical order, single `_migrations` table, no down-migrations, runner runs at startup inside one transaction. Alternatives rejected: Drizzle Kit (we don't yet need an ORM, and the runner is ~30 lines), kysely-migrator (same reason), `db-migrate` (heavier, less idiomatic for `better-sqlite3`).

- **React Router not introduced here.** Spec 003 lists `src/client/router.tsx` as a deliverable — Slice 002's Dashboard lives at `/` rendered by `App.tsx` with no router. Don't add `react-router-dom` to deps in this slice; it would be wasted work that Slice 003 redoes more carefully.

- **Spec internal contradiction on slug derivation.** Files/modules: "replaces `@` and `.` with `-`". Detailed design + architecture: `alice@example.com → alice-at-example-com`. Resolved as documented under "Patterns to follow" — the example wins. Captured here as a risk because if the spec author's intent was actually the literal "replace `@` with `-`", we'd produce `alice-example-com`, which would diverge from architecture's `alice-at-example-com` example used in `architecture.md` lines 189, 269, 312. Flag in review as a deviation-from-spec-text-but-not-spec-intent.

- **`needs_reauth` UI affordance vs. polling completeness.** The spec says the Reconnect polling looks for `status` flipping to `connected`. The `AddAccountButton`'s polling looks for a *new* account id. The two paths share the polling helper but have different "we're done" conditions. Worth a single shared `useAccountsPoll({ done: (accounts) => boolean })` hook that takes the predicate, so the duplication is at the call site (the predicate) not the timer logic.

## Test strategy

Following the loop's "TDD where applicable" rule. The Hono `app.fetch` pattern from Slice 001 carries through for route tests. SQLite tests use temp files via `mkdtempSync`; OAuth tests use injected fakes for `OAuth2Client`.

**Unit tests planned (vitest, Node env):**

- `src/server/auth/slug.test.ts` — `slugify('alice@example.com') === 'alice-at-example-com'`; trims trailing/leading hyphens; collapses runs; preserves digits; handles unusual emails (uppercase, `+aliases`, `_underscores`).
- `src/server/db/migrate.test.ts` — given a temp DB and a fixture dir with two `*.sql` files (`0001_*.sql` creates a table, `0002_*.sql` adds a column), running `migrate()` once applies both and creates `_migrations` with two rows; running it a second time is a no-op (zero new rows in `_migrations`); running it after manually inserting `0001_*.sql` into `_migrations` only applies `0002_*.sql`; if `0002_*.sql` errors, `_migrations` has only the `0001_*.sql` row (transaction rollback verified).
- `src/server/db/index.test.ts` — `getDb()` returns the same instance on repeated calls; calling `setDbPathForTest(path)` (a test-only helper) before first `getDb()` opens the DB at that path.
- `src/server/auth/accounts.test.ts` — covers the repository functions on a temp DB. `insert` produces unique slugs (e.g. inserting `bob@example.com` then `bob+work@example.com` after the slug normalizer collapses both to `bob-at-example-com` produces `bob-at-example-com` and `bob-at-example-com-2`); `findByEmail` returns the row; `updateStatus('needs_reauth')` flips it; `touchLastSeen` writes the ISO 8601 timestamp; `list` returns rows in insertion order (or by `id ASC`).
- `src/server/auth/oauth.test.ts` — `buildConsentUrl({ state })` produces a URL whose query string includes the three required scopes (asserted by parsing `searchParams`), `state`, `access_type=offline`, `prompt=consent`, and `redirect_uri` matching `config.oauthRedirectPort`. `exchangeCode` is tested with a stubbed `OAuth2Client.getToken` (`vi.spyOn` on a constructed instance, or by injecting a factory) — verifies the email is correctly read from the id_token's payload claim.
- `src/server/auth/session.test.ts` — `set` registers the `tokens` listener; `withFreshTokens` calls `getAccessToken` and returns the result; on `invalid_grant`, calls `accounts.updateStatus(id, 'needs_reauth')` and `clear(id)` and rethrows. The `tokens` listener preserves the original `refresh_token` when the refresh response omits one. All using a fake `OAuth2Client` (constructor swap).
- `src/server/api/accounts.test.ts` — registers the route on a test app with a seeded DB and asserts `GET /api/accounts` returns the expected JSON shape.
- `src/server/api/oauth.test.ts` — `POST /api/oauth/start` returns `{ consent_url, state }`, the state is recorded in the in-memory map. `GET /oauth/callback` with a stubbed code-exchange path inserts a new accounts row (when email is new) and redirects to `/`; with the same email and `kind=add`, updates the existing row's `status`/`last_seen_at` and does not duplicate. `POST /api/accounts/:id/reconnect` records the state with `kind=reconnect, accountId=id` and returns the consent URL; `:id` not in DB → 404. Bad state on callback → 400 HTML page with the error message.

**Client tests planned (vitest, jsdom env, `@testing-library/react`):**

- `src/client/api.test.ts` — `getJson` and `postJson` correctly encode bodies and parse responses; throw on non-2xx with the response body in the error message.
- `src/client/components/AccountList.test.tsx` — renders an empty-state CTA when `accounts.length === 0`; renders one row per account; renders the Reconnect button only when `status === 'needs_reauth'`; renders `display_name` when set, falls back to `email`.
- `src/client/components/AddAccountButton.test.tsx` — clicking the button calls `postJson('/api/oauth/start')`, opens `consent_url` (`window.open` mocked), starts polling. When polling sees a new account id, calls `onAdded(newAccount)` and stops polling. On 5-minute timeout (advanced via `vi.useFakeTimers()`), clears the interval and surfaces an error message.
- `src/client/views/Dashboard.test.tsx` — fetches `GET /api/accounts` on mount, renders the heading "Docurator", renders the `<AccountList />` with the returned accounts, renders the `<AddAccountButton />`. Loading state covered, error state covered.

**Integration tests:** the `app.fetch` tests already cross the request/response boundary — sufficient at this scale. No supertest needed.

**Smoke test outline (manual, run by priority 5):**

1. `docker compose down -v` (idempotent).
2. Confirm `.env` exists with the user's real `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set.
3. `docker compose up --build -d`. Poll `curl -fsS http://localhost:3737/health` until 200 (cap ~60s). Confirm `data/app.db` exists on the host (bind-mount working) and contains the `accounts` and `_migrations` tables (`sqlite3 data/app.db .tables`).
4. Open `http://localhost:3737/` in a browser. Confirm: heading "Docurator", empty-state CTA, "Add Gmail account" button.
5. Click "Add Gmail account". A new tab opens to Google's consent screen. Confirm the requested permissions are exactly: "Read your email messages and settings" and "See your primary Google Account email address". No write permissions appear. Approve.
6. Tab returns to a page that says "You can close this tab" (or a thin success page that links back to `/`). The Dashboard tab now shows one row with the just-authenticated email, status `connected`. Close the consent tab.
7. Sign out of that Google account in another browser tab; sign into a *different* Google account. Click "Add Gmail account" again on the Dashboard. Approve consent. The Dashboard now shows two rows.
8. `sqlite3 data/app.db 'SELECT email, slug, status FROM accounts;'` — both rows, both `connected`, slugs are correct.
9. `docker compose down`, then `docker compose up -d` (no `--build`). Browser: both accounts still listed (they were persisted to `app.db`). Tokens are gone in memory (no Gmail-touching path exercises this in Slice 002).
10. In Google account settings (https://myaccount.google.com/permissions), revoke the app's access for the *first* of the two connected accounts. Wait for the access token to expire (~1h) — or, more practically, document this as future-slice-only and skip in Slice 002's smoke. (AC #5's smoke verification arrives with Slice 003's Inbox, where a Gmail call triggers the refresh.) Mark in the smoke run as "deferred to Slice 003".
11. Click "Reconnect" on a row whose `status === 'needs_reauth'` (synthesized by manually `UPDATE accounts SET status='needs_reauth' WHERE id=...;` in the SQLite DB while the container is running, then refreshing the Dashboard). Approve consent. Row flips back to `connected`. No duplicate row.
12. `git status` clean (no leakage).
13. `docker compose down` to leave the host clean.
