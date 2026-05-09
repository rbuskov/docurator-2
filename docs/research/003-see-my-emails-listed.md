# Slice 003: See my emails listed — Research

**Spec:** `docs/specs/003-see-my-emails-listed.md`

## Summary of what the spec asks for

This slice is the first one that actually talks to Gmail. It introduces an Inbox view at `/inbox` with an account picker (driven by the slice-002 `GET /api/accounts`) and a 50-row table of `Subject / Sender / Date` headers fetched live from the Gmail API for the selected account — no local persistence. Headline deliverables: a Gmail client wrapper (`src/server/gmail/client.ts`) with exactly two read methods (`listMessages`, `getMessage`), a new HTTP endpoint `GET /api/accounts/:id/messages?limit=50`, three new React surfaces (`Nav.tsx`, `views/Inbox.tsx`, `components/AccountPicker.tsx`), React Router v6 wiring (`router.tsx`), and a build-time guard (`scripts/check-gmail-readonly.ts`) that fails `npm run build` if any forbidden Gmail-write substring shows up under `src/`. Slice-002's `session.withFreshTokens` is exercised end-to-end here for the first time, which makes Spec 002's AC #5 (revoke → `invalid_grant` → `needs_reauth`) verifiable end-to-end as a side effect of this slice.

## Existing code that this spec touches

What's actually in the tree today (post-Slice 002):

- `src/server/auth/session.ts` — `withFreshTokens(accountId, callback)` exists and already handles `invalid_grant` → `accounts.updateStatus(id, 'needs_reauth')` + `clear(id)` + rethrow. The Gmail client wrapper consumes this directly. **No changes needed**, but the Gmail client must call it.
- `src/server/auth/oauth.ts` — exports `SCOPES = ['openid', 'userinfo.email', 'gmail.readonly']`. AC #9 ("zero references to OAuth scopes other than gmail.readonly, userinfo.email, and openid") already holds; the build-time check needs a positive grep for the *only-three-scopes* property as well as a negative grep for forbidden substrings. **No changes needed.**
- `src/server/auth/accounts.ts` — `findById`, `list`, `updateStatus` are already exposed. The Gmail messages endpoint reads via `findById` to confirm the row exists before issuing the Gmail call. **No changes needed.**
- `src/server/app.ts` — `createApp()` registers `/health`, accounts, oauth, then static fallback. We add a `registerMessagesRoutes(app)` call between `registerOauthRoutes` and the static fallback. Edit, don't replace.
- `src/server/api/` — currently `accounts.ts`, `oauth.ts`. We add `messages.ts` alongside. The factory pattern (`registerMessagesRoutes(app, deps?)`) lets tests inject a fake Gmail client just like `registerOauthRoutes` accepts a fake `exchangeCode`.
- `src/client/App.tsx` — currently `<Dashboard />`. Becomes `<RouterProvider router={…} />` (or `<BrowserRouter><AppShell /></BrowserRouter>`). The Slice-001 acceptance criterion that "page contains 'Docurator'" still holds because `Nav.tsx` renders the heading on every route.
- `src/client/main.tsx` — unchanged; mounts `<App />` inside `<StrictMode>`. The router lives below `<App />`.
- `src/client/api.ts` — `getJson<T>` and `postJson<T>` carry forward. The Inbox just calls `getJson('/api/accounts/:id/messages?limit=50')`.
- `src/client/views/Dashboard.tsx` — moves under `<Routes>`. Internally unchanged, but the `<main>` wrapper might move into `Nav.tsx`'s outlet shell so the Dashboard's contents render below the nav. Decided in plan: keep `Dashboard.tsx`'s root `<main>` intact and have `Nav.tsx` render *above* the route outlet (a `<header>` element at the top of `App.tsx` next to `<Routes>`). One-file edit to Dashboard if any.
- `src/client/types.ts` — already exports `Account`. Add a `Message` type next to it (matching the API response shape). Optionally add a small `messageHeaders` helper. Decided: keep the type alongside `Account` here for now; if more domain types arrive, split into `types/account.ts` etc. in a later slice.
- `src/client/components/AddAccountButton.tsx`, `AccountList.tsx`, `hooks/useAccountsPoll.ts` — unchanged; AccountList still renders Reconnect on `needs_reauth` rows. AccountPicker is new and *separate* from AccountList — they share the same `Account` type but render differently (AccountList is the Dashboard's row-list with status badges + Reconnect button; AccountPicker is a `<select>` for choosing one connected account).
- `package.json` — adds `react-router-dom` (runtime) and a `check:gmail-readonly` script. The spec also says to add `googleapis` and `tsx` — both are already present (Slice 002 added `googleapis@171.4.0`; `tsx` is a dev dep used by `dev` and `start` scripts). Confirm and only add what's missing.
- `src/server/index.ts` — unchanged; `migrate()` already runs before `serve()`. The new messages route consumes `getDb()` only indirectly through `accounts.findById`.
- `Dockerfile` — `RUN npm run build` already runs in the builder stage. The new build-time check fires automatically because the spec wires it ahead of `vite build` in the build script chain. No Dockerfile edits.
- `docker-compose.yml` — unchanged. No new env vars or volumes for this slice.
- `vitest.workspace.ts` — unchanged; the new server tests go under `src/server/**/*.test.ts` (already matched), the new client tests under `src/client/**/*.test.{ts,tsx}` (already matched).
- `tsconfig.json`, `tsconfig.server.json` — unchanged. The `scripts/` directory needs to be type-checked, though — confirmed; if it isn't picked up by `tsconfig.json`'s `include`, decide in the plan whether to add it or to use a `// @ts-check`-only approach. Adding `scripts/**/*.ts` to `tsconfig.json`'s `include` is the simpler choice because the script imports nothing from the project; an explicit `tsx scripts/check-gmail-readonly.ts` invocation skips `tsc` entirely.

Files / modules the spec creates from scratch (no existing analogue):

- `src/server/gmail/client.ts`
- `src/server/api/messages.ts`
- `src/client/views/Inbox.tsx`
- `src/client/components/AccountPicker.tsx`
- `src/client/components/Nav.tsx`
- `src/client/router.tsx`
- `scripts/check-gmail-readonly.ts`
- The corresponding test files

## Patterns to follow

This slice introduces a small number of new patterns; most reuse what Slice 002 already established.

- **Gmail client wrapper (`src/server/gmail/client.ts`).** Per-call construction (no caching). Function signature: `createGmailClient(accountId: number): { listMessages, getMessage }`. Internally, every call wraps the actual Gmail invocation in `session.withFreshTokens(accountId, async (oauth2Client) => { const gmail = google.gmail({ version: 'v1', auth: oauth2Client as OAuth2Client }); return gmail.users.messages.list/get(...) })`. The two methods:
  - `listMessages({ maxResults, q?, pageToken? }): Promise<{ messages: Array<{ id: string, threadId: string }>, nextPageToken?: string, resultSizeEstimate?: number }>` — passes through to `users.messages.list({ userId: 'me', maxResults, q, pageToken })`. Returns the raw `messages` array (Gmail returns `[]` when there are none, or `messages` may be undefined on an empty inbox; normalize to `[]` so callers don't pattern-match nullish).
  - `getMessage(id, { format, metadataHeaders? }): Promise<gmail_v1.Schema$Message>` — passes through to `users.messages.get({ userId: 'me', id, format, metadataHeaders })`. Returns whatever the Gmail SDK returns (we don't reshape).
  - **Test seam.** Inject a `gmailFactory` (default: `(auth) => google.gmail({ version: 'v1', auth })`) so tests pass a fake. Same pattern as `OAuth2ClientFactory` in `oauth.ts` and `session.ts`. Either an optional second argument to `createGmailClient` or a module-level setter `setGmailFactoryForTest` — pick the latter for symmetry with `setSessionClientFactoryForTest`. Decision deferred to the plan; both work.
  - **No write methods exposed.** Even as a private helper. The build-time check is the canonical enforcement; the wrapper's small surface is what makes the check effective (one place to look).

- **Messages API endpoint (`src/server/api/messages.ts`).** Hono route registrar:
  - `app.get('/api/accounts/:id/messages', handler)` — handler reads `:id` (validate as positive integer), reads `?limit=` (default 50, clamp 1–100 to be safe; spec says 50, 100 is a defensive ceiling), optionally `?q=` (passthrough for slice 005's Classify-this filtering, but the Inbox itself doesn't use it yet — decided in plan: include the `q` parameter now or defer to a later slice; leaning **defer** because YAGNI and the spec doesn't list it).
  - Verifies the account exists via `accounts.findById(id)`. If not found: HTTP 404 `{ error: 'account_not_found' }`.
  - Verifies `account.status === 'connected'`. If not: HTTP 409 `{ error: 'account_not_connected', status: account.status }` (so the UI can render "Reconnect on Dashboard" without parsing a 401's `needs_reauth` body — decided to treat "configured but not connected right now" as a separate failure mode from "tokens expired during this request").
  - Verifies `session.get(account.id)` is present. If absent (container restarted, no reconnect yet): also 409 `{ error: 'account_not_connected', status: 'needs_reauth' }` — flips the row to `needs_reauth` first because the in-memory absence is functionally the same as a revoked refresh token.
  - Wraps the actual Gmail calls in `try / catch`. On `invalid_grant` (which `session.withFreshTokens` already converts to a thrown error after flipping the row to `needs_reauth`): HTTP 401 `{ error: 'needs_reauth', account_id: id }`. On any other error: HTTP 502 `{ error: 'gmail_error', message }`.
  - Inside the success path: `client.listMessages({ maxResults: limit })` returns `{ messages: [{ id, threadId }, ...] }`. Then issues `getMessage(id, { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })` for each message, **sequentially** (per the spec's "N+1 fetch pattern" note — concurrency lives in Slice 006). Parses headers from `payload.headers` (a list of `{ name, value }`).
  - Response shape: `{ messages: [{ id, thread_id, subject, from, date, internal_date }, ...] }` where `subject`/`from`/`date` come from the headers (default to empty string if a header is missing — Gmail messages without a Subject are valid; treat absent as empty), `internal_date` from `Schema$Message.internalDate` (Gmail returns it as a string of epoch milliseconds).
  - Test seam: inject the `createGmailClient` factory just like `registerOauthRoutes` injects `exchangeCode` / `buildConsentUrl`.

- **Header parsing helper.** `extractHeader(message, name): string` — case-insensitive lookup in `message.payload.headers ?? []`. Pure function. Lives inside `src/server/api/messages.ts` (or a small `src/server/gmail/headers.ts` if it's needed by future slices — for now keep it module-private).

- **AccountPicker component (`src/client/components/AccountPicker.tsx`).** Reusable across views (Inbox here, Sync/Review/etc. later). Props: `{ accounts, value, onChange, includeDisconnected? }`. Uses a native `<select>`:
  - Filters out accounts with `status !== 'connected'` by default. If `includeDisconnected === true`, shows all but disables the `<option>` for non-connected ones with a `(needs reauth — reconnect on Dashboard)` suffix.
  - Spec says "Accounts in needs_reauth status appear in the dropdown but are visually disabled with a 'Reconnect on Dashboard' hint". So the *default* inside the Inbox view is `includeDisconnected={true}` (the spec's described behavior). The prop exists to let future views skip the disabled rows entirely if they want to.
  - Empty state: render `<p>No connected accounts. Connect one on the Dashboard.</p>` when `accounts.filter(a => a.status === 'connected').length === 0`. Inbox view consumes this empty state directly (the picker renders it inline).

- **Inbox view (`src/client/views/Inbox.tsx`).** Component state: `{ accounts, selectedAccountId, messages, loading, error }`. Lifecycle:
  - On mount: `getJson('/api/accounts')` → set `accounts`. Initialize `selectedAccountId` from `localStorage['docurator.lastInboxAccountId']` if present *and* still connected, else first `connected` account, else `null`.
  - When `selectedAccountId` changes: write to `localStorage`, set `loading=true`, `getJson('/api/accounts/:id/messages?limit=50')`, then either `setMessages(data.messages)` or `setError(data.error)`.
  - Empty state when `accounts.length === 0`: "No accounts connected — connect one on the Dashboard" + a `<Link to="/">Dashboard</Link>`.
  - Empty state when no `connected` accounts: same pointer back to the Dashboard.
  - Error state when the messages call returns `{ error: 'needs_reauth', account_id }`: "This account needs to be reconnected — go to the Dashboard."
  - Error state when `{ error: 'gmail_error', message }`: "Gmail returned an error: {message}. Try again."
  - Table of 50 rows with columns `Subject / Sender / Date` — three `<th>`s and one `<tr>` per message. Use the message's `id` as the React key. **No body rendering**, **no attachment rendering** — just the three header strings.

- **Nav (`src/client/components/Nav.tsx`).** Top-of-page nav. Renders `<h1>Docurator</h1>` + two `<Link>`s (`/` Dashboard, `/inbox` Inbox). Uses `react-router-dom`'s `useLocation` (or `NavLink`'s `isActive`) to highlight the current route — spec doesn't require this, but it's a 3-line ergonomics win that's hard to leave out. The `<h1>` here means `Dashboard.tsx` should drop its own `<h1>` (or the page would render two `Docurator` headings). Decision: move the `<h1>` from `Dashboard.tsx` into `Nav.tsx`. Slice-001's "page contains 'Docurator'" criterion still holds — the heading just lives in the nav now.

- **Router (`src/client/router.tsx`).** `BrowserRouter` is the simplest fit (data-router APIs would buy us nothing for two static routes). Exports a `<AppRoutes />` component that returns `<Routes><Route path="/" element={<Dashboard />} /><Route path="/inbox" element={<Inbox />} /></Routes>`. `App.tsx` becomes `<BrowserRouter><Nav /><AppRoutes /></BrowserRouter>`. Tests use `<MemoryRouter initialEntries={['/inbox']}>` to render at a specific route.

- **Build-time check (`scripts/check-gmail-readonly.ts`).** Walk `src/` recursively (skip `node_modules/`, `dist/`, anything under `docs/` if it ever ended up here), read each `.ts`/`.tsx`/`.js`/`.jsx` file, check for any of the forbidden substrings. Skip the script itself. The substring list is **literal text**, not regex — `messages.modify` matches `users.messages.modify(...)` and `gmail.modify` and even a comment that says `messages.modify`. Per the spec, false positives are addressed by fixing the comment, not loosening the check.
  - **Implementation.** A single self-contained TypeScript file run via `tsx`. No external deps beyond `fs`/`path`. Walks `src/` with a small recursive `readdir` loop (or `fs.readdirSync(..., { recursive: true })` — Node 20.12+ supports it). The forbidden list is a `const FORBIDDEN: readonly string[]` at the top of the file. On a hit: `console.error('FAIL: src/foo/bar.ts contains forbidden substring "messages.modify"')` and `process.exitCode = 1`. On no hits: `console.log('OK: no forbidden Gmail-write substrings in src/')` and exit 0.
  - **Self-exemption.** The file's own path (`scripts/check-gmail-readonly.ts`) is filtered out before the loop. Spec says this explicitly.
  - **Wired into `package.json`.** Adds `"check:gmail-readonly": "tsx scripts/check-gmail-readonly.ts"`. Updates `"build"` to run `npm run check:gmail-readonly && <existing build chain>` so a hit fails the Docker build.
  - **Verified by an integration test.** `scripts/check-gmail-readonly.test.ts` (server-project) creates a temp dir with a fixture file containing `messages.modify`, points the check function at it (script exposes its core function for testability), expects exit code 1. Plus a positive case where the temp dir contains only clean files, exit code 0. The test imports the function rather than spawning a subprocess — faster, deterministic. The script itself runs the function with `process.cwd() + '/src'` as the root.

- **Routing imports.** Use the `react-router-dom` v6 named imports (`BrowserRouter`, `Routes`, `Route`, `Link`, `NavLink`, `MemoryRouter`, `useLocation`). v7 reuses the same names; if `react-router-dom@^7` resolves, no code changes needed. **Pin to v6** in `package.json` (`"react-router-dom": "^6"`) for now — v7 adds future flags that are easy to enable later but might destabilize tests today. Decision flagged for the review.

- **`Schema$Message` typing.** `googleapis` exports types under `gmail_v1.Schema$Message`, etc. Import via `import type { gmail_v1 } from 'googleapis'`. The Gmail client wrapper's return types alias these to keep call-site types narrow.

- **localStorage interaction.** Single key `docurator.lastInboxAccountId`, stored as the stringified account id. Read once on Inbox mount inside a `try` (catches `localStorage` being unavailable in private mode). Write on every `selectedAccountId` change. **No email content stored** — only the numeric id. Architecture is silent on client storage; this is the first place we need it. Flagged for the review under "Decisions worth flagging".

- **Test infrastructure.** Existing `vitest.workspace.ts` already routes server tests to Node and client tests to jsdom. New tests slot in:
  - Server: `src/server/gmail/client.test.ts`, `src/server/api/messages.test.ts`, `scripts/check-gmail-readonly.test.ts` (decide if `scripts/` is included by the workspace's `src/server/**/*.test.ts` glob — it's not; the test moves to `src/server/scripts/check-gmail-readonly.test.ts` or the workspace include grows to `{src/server,scripts}/**/*.test.ts`. Plan: keep the script under `scripts/` and add it to the include glob — keeps the script colocated with build tooling rather than mixed into server source.).
  - Client: `src/client/components/AccountPicker.test.tsx`, `src/client/components/Nav.test.tsx`, `src/client/views/Inbox.test.tsx`. The router itself is integration-tested through these (each test wraps the component in `<MemoryRouter>`).

## Refactors needed before adding the new feature

Three small ones, none big enough to be a separate slice:

- **Move the `<h1>Docurator</h1>` from `Dashboard.tsx` into `Nav.tsx`.** Nav now renders the heading on every route, so the Dashboard's local heading would duplicate. One-line edit to `Dashboard.tsx`. Slice-001's heading-text criterion is preserved because Nav is rendered above the route outlet on every page.
- **`createApp` registers `registerMessagesRoutes`.** Single line in `src/server/app.ts`. Existing route order is `/health` → accounts → oauth → static fallback; messages slots in between oauth and the static fallback so it precedes the catch-all `*`. Tests for `app.test.ts` continue to pass — they don't exercise messages, but the static-fallback test still hits the catch-all because `/api/accounts/:id/messages` is a more specific route.
- **Add `scripts/**/*.ts` to `tsconfig.json`'s include.** Keeps the build-time check in TypeScript and `tsc --noEmit`-clean. Otherwise the `tsx`-only invocation works at runtime but the script can drift without the typechecker noticing.

## Risks and open questions

- **`googleapis` size and tree-shaking.** The `googleapis` package exports the entire Google API surface (~1 GB unzipped, including discovery docs for hundreds of services). Importing `import { google } from 'googleapis'` pulls in the full set under most bundler configs, which could bloat the runtime image. **Mitigation:** import the narrow Gmail subentry: `import { google } from 'googleapis'` and use only `google.gmail(...)`. The package has prebuilt scope-narrowing entrypoints (`googleapis/build/src/apis/gmail`) that some teams use, but they're not part of the public API. Plan stance: use `google.gmail(...)` from the main entry first; if the runtime image grows materially, add a follow-up note. **Not a blocker** because the package is already a runtime dep from Slice 002.

- **`OAuth2Client` shape compatibility.** `session.withFreshTokens` exposes a `SessionClientLike` (a small structural subset). `google.gmail({ version: 'v1', auth })` expects an `OAuth2Client` (or any `auth: GoogleAuth | OAuth2Client | ...` shape). The session module stores `client: SessionClientLike`; in production this is always a real `OAuth2Client` from `google-auth-library`, but TypeScript-wise the `gmail()` call needs an assertion or a wider type. **Plan stance:** narrow the test-only `SessionClientLike` to allow the production `OAuth2Client` to satisfy it (it already does structurally), and at the Gmail call site cast via `client as OAuth2Client`. Document the cast inline. If the cast feels gross enough to fix structurally, add an `OAuth2Client`-compatible field to `SessionEntry` and have tests stub a wider client. Defer the structural fix to the plan.

- **Build-time check semantics.** Substring matching is dumb on purpose, but it's also dumb in ways that matter. Examples:
  - A clean test file that mocks Gmail might want a comment like `// users.messages.modify is forbidden — verifying we never call it`. The check fails. Fix the comment, not the check.
  - Generated TypeScript declaration files under `node_modules/` mention `messages.modify` (the `googleapis` types include the write methods). The check is scoped to `src/`, so this is a non-issue, but flag explicitly so the plan doesn't accidentally widen the search.
  - The `googleapis` runtime resolves these methods dynamically; a forbidden write method called via `gmail['users']['messages']['modify']({...})` would *not* be caught by substring matching. The check is a guardrail, not a proof. Acceptable for v1, flag for the review's follow-ups.

- **React Router v6 vs v7.** v7 is fully released as of mid-2025 and is mostly source-compatible with v6 if you don't use the data-router APIs. The spec says v6 explicitly. **Plan stance:** pin to `react-router-dom@^6`. v7 migration is a small follow-up.

- **`StrictMode` and useEffect double-invocation.** Slice 002's review noted that the Dashboard double-fetches `/api/accounts` on mount in dev. The same is true for the Inbox — double-fetching `/api/accounts/:id/messages` is *more* expensive (51 round-trips, real Gmail API quota burn). **Mitigation:** in development this runs once, the second mount call short-circuits because `selectedAccountId` is already set, but the *first* mount of the messages effect still fires twice (the cleanup ran before the second invocation). For Slice 003 we accept the dev-mode double-fetch and document it; the production build does not double-fire. AbortController-based fetch cancellation in the messages effect would fix it cleanly — defer to a later slice unless it surfaces in smoke as actually-painful (hitting Gmail rate limits while developing).

- **Spec ambiguity on the picker's empty state.** The spec says "Loading state while fetching, empty state when no accounts are connected". Two readings: (a) empty state when *zero accounts in any status*, or (b) empty state when *zero connected accounts* (some exist but all in `needs_reauth`). The spec's later paragraph clarifies: "Accounts in `needs_reauth` status appear in the dropdown but are visually disabled". So reading (a) wins for the picker's empty state — show the disabled rows when there *are* needs_reauth accounts. The Inbox itself, when no account is selectable, links to the Dashboard. Plan implements (a).

- **`internalDate` type.** The Gmail SDK types `Schema$Message.internalDate` as `string | null | undefined`. Spec says the API response field `internal_date` is "epoch ms as string" — match Gmail's encoding. If `internalDate` is null/undefined for a message (extremely unusual), default to empty string. The UI doesn't render `internal_date` in this slice; it's there for future slices.

- **Header case sensitivity.** Gmail returns headers verbatim — `Subject`, `From`, `Date` — but RFC 5322 says header names are case-insensitive. Use a case-insensitive lookup in `extractHeader` so the code doesn't break if Google ever changes casing.

- **Per-row `getMessage` partial failures.** If one of the 50 `getMessage` calls fails (transient 429, etc.), do we fail the whole response or return what we have? Spec is silent. Plan stance: fail the whole response with HTTP 502, because partial results would be confusing in the table (49 rows with no clear indication that one is missing). Slice 006's sync orchestrator handles partial failures with proper bookkeeping; this throwaway slice keeps it simple.

- **`pollIntervalMs`/`pollTimeoutMs` props on Dashboard.** Slice-002 introduced these as test seams that double as production knobs. The Inbox does not poll — its data is a one-shot fetch — so it inherits no test-seam-vs-product-knob friction. Keep Dashboard's props unchanged.

- **`scripts/check-gmail-readonly.test.ts` location.** Either include `scripts/**/*.test.ts` in the `vitest.workspace.ts` server project, or put the test under `src/server/`. Plan stance: extend the workspace include to `'src/server/**/*.test.ts'` *plus* `'scripts/**/*.test.ts'`. The script is colocated with build tooling (`scripts/`), and putting its test elsewhere creates a 1:1 file-pair across two trees.

- **AC #5 of Slice 002 finally testable end-to-end here.** This slice is the first one that calls `withFreshTokens` from a request handler. A user revoking the app's permission at `https://myaccount.google.com/permissions`, then navigating to `/inbox` and selecting that account, exercises: revocation → access token expires → next refresh → `invalid_grant` → `withFreshTokens` flips status to `needs_reauth` and rethrows → the messages route returns 401 `{ error: 'needs_reauth' }`. Smoke test for Slice 003 should call this out explicitly so the human can verify it.

- **`docker-compose up --build`'s no-cache cost.** Adding `npm run check:gmail-readonly` to the build chain means every Docker build re-runs the check. The check walks `src/` once and substring-matches a small list — measured locally, on the order of 50 ms. Negligible. Flagged because it's a recurring cost.

- **HTML escaping in the Inbox table.** Subject/From/Date are user-controlled (they came from emails authored by third parties). React's JSX escapes text content by default; just rendering `{message.subject}` is safe. Do **not** use `dangerouslySetInnerHTML`. Plan reminds itself in the relevant step.

## Test strategy

Following the loop's "TDD where applicable" rule. The Hono `app.fetch` pattern carries through. Server tests run under Node, client tests under jsdom + RTL. Gmail API calls in tests are stubbed via factory injection — same pattern as `OAuth2Client` in Slice 002.

**Unit tests planned (vitest, Node env):**

- `src/server/gmail/client.test.ts`
  - `createGmailClient(accountId).listMessages({ maxResults: 50 })` calls `gmail.users.messages.list({ userId: 'me', maxResults: 50 })` exactly once with the injected fake; returns `{ messages: [{ id: 'a', threadId: 't1' }, ...] }` from the fake; normalizes a fake response with no `messages` field to `messages: []`.
  - `getMessage('msg1', { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })` calls `gmail.users.messages.get` with those exact args.
  - Both methods route through `session.withFreshTokens(accountId, callback)` — assert by stubbing `session.withFreshTokens` to track invocation order and the OAuth client passed in. On `invalid_grant` (the wrapped `getAccessToken` throws), `withFreshTokens` flips status + rethrows; the wrapper rethrows verbatim.
- `src/server/api/messages.test.ts`
  - `GET /api/accounts/999/messages` → 404 `{ error: 'account_not_found' }`.
  - `GET /api/accounts/:id/messages` for `status='needs_reauth'` → 409 `{ error: 'account_not_connected', status: 'needs_reauth' }`.
  - `GET /api/accounts/:id/messages` for `status='connected'` but no session entry → 409 with status `needs_reauth` (and the row is flipped to `needs_reauth`).
  - Happy path with a fake Gmail client: returns `{ messages: [{ id, thread_id, subject, from, date, internal_date }, ...] }` with five seeded messages, each `getMessage` returns a fake `payload.headers` array; assert the response shape and field-by-field values, including a message whose `Subject` header is missing → `subject: ''`.
  - Gmail client throws an `invalid_grant` error → 401 `{ error: 'needs_reauth', account_id: id }`.
  - Gmail client throws a generic error → 502 `{ error: 'gmail_error', message }`.
  - `?limit=` clamping: `?limit=0` → 400, `?limit=200` → 400, `?limit=25` → uses 25, default (no `?limit`) → 50.
- `scripts/check-gmail-readonly.test.ts`
  - The script exports a function `scanForForbidden(rootDir: string): { hits: Array<{ file, substring }> }`. Test creates a temp dir with `clean.ts` (no forbidden text) and `bad.ts` (contains `messages.modify`); calls `scanForForbidden(tempDir)`; asserts the result contains exactly one hit pointing at `bad.ts` with substring `messages.modify`.
  - A second test creates only clean files and asserts `hits` is empty.
  - A third test creates a file with multiple forbidden substrings and asserts each is reported.
  - A fourth test seeds a `nested/sub/dir/x.ts` with a forbidden substring and asserts the recursive walk catches it.
  - The self-exemption is tested by placing the script's own filename inside the temp dir (with a forbidden substring) and asserting the scan ignores it. The "self" path is configurable via a parameter to make the test possible.
- A *positive* test on the real `src/` directory: `scanForForbidden(path.resolve(__dirname, '../../src'))` returns zero hits. This is what the build script enforces; the unit test runs the same code at vitest time, so a regression is caught even if the human forgets to run `npm run build`.

**Client tests planned (vitest, jsdom env, `@testing-library/react`):**

- `src/client/components/Nav.test.tsx` — renders both `<Link>`s, the Docurator heading is present, the active route's link is marked (if we use `NavLink`'s `isActive`).
- `src/client/components/AccountPicker.test.tsx`
  - `<AccountPicker accounts={[]} onChange={...} />` renders the empty-state message.
  - `<AccountPicker accounts={[connectedA, connectedB]} value={connectedA.id} onChange={mock} />` renders both options; selecting B fires `onChange(connectedB.id)`.
  - With `includeDisconnected={true}` and a `needs_reauth` row in the list, the row appears as a `<option disabled>` with the `(needs reauth — reconnect on Dashboard)` suffix.
  - With `includeDisconnected={false}`, the same `needs_reauth` row is filtered out entirely.
- `src/client/views/Inbox.test.tsx`
  - On mount with `<MemoryRouter initialEntries={['/inbox']}>` and a stubbed `getJson` returning two connected accounts, then a stubbed messages call returning three rows: the page renders the picker with the first account preselected, then a 3-row table with Subject/From/Date as the column headers and the matching cell values.
  - localStorage seeded with a connected account id → that account is preselected even if it's not first.
  - localStorage seeded with an account id that no longer exists / no longer connected → falls back to the first connected.
  - Account picker change → second messages fetch fires with the new account id; the table updates.
  - `getJson` for messages returns 401 `needs_reauth` shape → renders the "needs reauth" error state with a link to `/`.
  - `getJson` for messages returns 502 `gmail_error` shape → renders the "Gmail error" message.
  - No accounts at all → renders the "connect an account on the Dashboard" empty state with a link to `/`.

**Integration tests:** the existing `app.fetch` pattern carries through for the messages endpoint. For the client, `<MemoryRouter>` exercises the router wiring directly; no separate router test needed.

**Smoke test outline (manual, run by priority 5):**

1. `docker compose down -v` (idempotent).
2. Confirm `.env` has `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set.
3. `docker compose up --build -d`. The build runs the `check:gmail-readonly` step ahead of `vite build`. Confirm the build output includes a line like `OK: no forbidden Gmail-write substrings in src/`.
4. **Build-time-check failure path.** Edit a TypeScript file under `src/` to add a comment line containing `messages.modify`. Run `npm run build` directly (not via Docker — faster). Confirm exit code is non-zero and the error message names the file and the substring. Revert the edit. Re-run `npm run build` — exit 0. (This exercises AC #7.)
5. Open `http://localhost:3737/` in a browser. Confirm the Dashboard renders, the nav at the top shows `Dashboard | Inbox`, and clicking `Inbox` navigates to `/inbox` (no full page reload).
6. With at least one connected Gmail account from Slice 002, on `/inbox`: the picker is preselected to the first connected account, a loading state shows briefly, and a 50-row table renders with real Subject / Sender / Date values matching what the same account shows in Gmail's web UI. Confirm the values match by spot-checking 3 rows.
7. Switch the picker to a different connected account. Confirm the table reloads and shows that account's most recent messages with no leakage from the previous account.
8. **AC #4 (needs_reauth disabled in picker).** `sqlite3 data/app.db "UPDATE accounts SET status='needs_reauth' WHERE id=1;"`. Refresh `/inbox`. The picker shows row 1 as a disabled option labelled `(needs reauth — reconnect on Dashboard)`. Click the dropdown — the disabled row cannot be selected. Click `Dashboard` from the nav — the row shows the Reconnect button.
9. **AC #5 (revoke at Google → needs_reauth flip via Inbox).** Connect an account, then revoke its access at `https://myaccount.google.com/permissions`. Wait for the access token to expire (~1h), or force the issue by deleting the row's session entry (a restart of the container also does it: stop, start without `--build`, navigate to `/inbox`, select the just-revoked account). Expected: the messages call hits the missing-session-or-invalid-grant branch, the row flips to `needs_reauth`, the Inbox renders the error state, the Dashboard shows the Reconnect button. (This exercises Slice 002's AC #5 end-to-end for the first time.)
10. **AC #6 (no DB writes during the Inbox flow).** Before step 6, `sqlite3 data/app.db 'SELECT COUNT(*) FROM accounts; SELECT COUNT(*) FROM _migrations;'`. After step 9, run the same queries. Confirm the only delta is the `last_seen_at`-style updates from Slice 002's reconnect flow (if any reconnect ran during the smoke); no new rows in `accounts`, no new migrations, no rows in any other table.
11. **AC #9 (no extra OAuth scopes in the codebase).** `grep -rn 'gmail\.[a-z]' src/ --include='*.ts' --include='*.tsx' | grep -v '\.test\.'` should find only `gmail.readonly` references. The build-time check covers the negative; this manual grep covers the positive.
12. `git status` clean.
13. `docker compose down`.
