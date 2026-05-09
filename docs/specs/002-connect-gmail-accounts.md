# Slice 002: Connect Gmail accounts

**Status:** ready

## Observable result

I can click "Add Gmail account" on the Dashboard, complete Google's OAuth flow for one or more different Gmail addresses, and see each of them listed as connected (with status `connected` or, if their token was revoked, `needs_reauth`).

## Prerequisites (Consumes)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:**
  - Placeholder `App.tsx` page that renders the text "Docurator" (and nothing else of substance) at `/` (Slice 001 — the placeholder is replaced by the Dashboard in this slice)
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (default `3737`) (Slice 001)
- **Files / modules:**
  - `package.json`, `tsconfig.json`, `vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `LICENSE` (Slice 001)
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/client/main.tsx`, `src/client/App.tsx` (Slice 001)
- **External services:**
  - Host requirement: Docker + Docker Compose installed (Slice 001)
- **Other:** —

## Deliverables (Produces)

- **DB tables / columns:**
  - `accounts` table with columns: `id` INTEGER PRIMARY KEY, `email` TEXT NOT NULL UNIQUE, `display_name` TEXT NULL, `slug` TEXT NOT NULL UNIQUE, `connected_at` TEXT NOT NULL, `last_seen_at` TEXT NULL, `status` TEXT NOT NULL CHECK (`status` IN ('connected','needs_reauth'))
- **Migrations:**
  - `0001_create_accounts.sql` — creates the `accounts` table above
- **API endpoints:**
  - `POST /api/oauth/start` → request body `{}`; response `{ consent_url: string, state: string }`. Generates a random `state`, builds Google's consent URL with `scope=https://www.googleapis.com/auth/gmail.readonly`, `access_type=offline`, `prompt=consent`, `redirect_uri=http://localhost:{APP_PORT}/oauth/callback`, and the `state` value. The state is recorded in an in-memory map (TTL ~10 minutes) so the callback can recognize it.
  - `GET /oauth/callback?code=...&state=...` → on success redirects the browser to `/` (HTTP 302) after exchanging the code, fetching `userinfo.email`, upserting an `accounts` row (insert if `email` new, update `status='connected'` and `last_seen_at` if it already exists), and storing the tokens in the in-memory token store under that account's `id`. On failure responds with a small HTML page summarizing the error so the user knows the popup tab can be closed.
  - `GET /api/accounts` → response `{ accounts: Array<{ id, email, display_name, slug, status, connected_at, last_seen_at }> }`. Used by the Dashboard.
  - `POST /api/accounts/:id/reconnect` → response `{ consent_url: string, state: string }`. Same shape as `/api/oauth/start` but the recorded `state` is associated with the existing `account_id`, so the callback updates that row rather than inserting a new one.
- **UI views / components:**
  - `Dashboard.tsx` — replaces the slice-001 placeholder at `/`. Shows the list returned by `GET /api/accounts` (email, display_name when set, status badge), an always-visible "Add Gmail account" button, and a "Reconnect" button on each row whose `status === 'needs_reauth'`. When the list is empty, renders an empty-state CTA pointing at the same "Add Gmail account" button.
  - `AccountList.tsx`, `AddAccountButton.tsx` — small components composing the above. The Add button calls `POST /api/oauth/start`, opens `consent_url` in a new tab, and polls `GET /api/accounts` every ~2s until a new row appears (or a 5-minute timeout elapses).
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `GOOGLE_CLIENT_ID` (required) — OAuth client ID (Desktop-app type) from the user's Google Cloud project
  - `GOOGLE_CLIENT_SECRET` (required) — paired secret
  - `OAUTH_REDIRECT_PORT` (default `${APP_PORT}`) — port appearing in the `redirect_uri`. Defaulting to the main app port means the same Hono server handles the callback.
  - `.env.example` — committed file documenting the three OAuth-related variables plus the slice-001 `APP_PORT`
  - `docker-compose.yml` updated: passes `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through from the host environment, and bind-mounts `./data:/app/data` so the SQLite file survives container restarts
- **Files / modules:**
  - `src/server/db/index.ts` — opens `better-sqlite3` connection at `./data/app.db`, exports a singleton `Database` handle. No WAL mode yet (Slice 004 turns it on).
  - `src/server/db/migrate.ts` — minimal migration runner: reads `src/server/db/migrations/*.sql` in lexical order, tracks applied filenames in a `_migrations` table, applies any unapplied ones in a transaction. Runs once at server startup.
  - `src/server/db/migrations/0001_create_accounts.sql` — the migration above
  - `src/server/auth/accounts.ts` — repository: `findByEmail`, `findById`, `insert`, `updateStatus`, `touchLastSeen`, `list`. Pure DB access, no OAuth knowledge.
  - `src/server/auth/oauth.ts` — wraps `google-auth-library`: builds consent URLs, exchanges authorization codes, refreshes access tokens. Constructs `OAuth2Client` instances per call rather than caching one.
  - `src/server/auth/session.ts` — in-memory map keyed by `accounts.id`, value is `{ access_token, refresh_token, expiry_date, oauth2_client }`. Exposes `get(account_id)`, `set(account_id, tokens)`, `clear(account_id)`, and `withFreshTokens(account_id, callback)` which transparently refreshes the access token (using the refresh token) before invoking the callback. On `invalid_grant` from the refresh call, clears the entry and calls `accounts.updateStatus(account_id, 'needs_reauth')`; the error then bubbles up to the API caller.
  - `src/server/auth/slug.ts` — `slugify(email)`: lowercases, replaces `@` and `.` with `-`, strips characters outside `[a-z0-9-]`, collapses repeats, ensures uniqueness against `accounts.slug` by appending a numeric suffix when needed.
  - `src/server/api/oauth.ts` — registers `POST /api/oauth/start`, `GET /oauth/callback`, `POST /api/accounts/:id/reconnect`
  - `src/server/api/accounts.ts` — registers `GET /api/accounts`
  - `src/client/views/Dashboard.tsx`, `src/client/components/AccountList.tsx`, `src/client/components/AddAccountButton.tsx`
  - `src/client/api.ts` — tiny `fetch` wrapper used by the Dashboard
  - `data/.gitkeep` — keeps the bind-mount target directory present in the repo (the path itself remains gitignored via slice-001's `.gitignore`, but `data/.gitkeep` is force-tracked)
- **External services:**
  - Google OAuth 2.0 + Gmail consent flow (Desktop OAuth client; user supplies own credentials per `architecture.md` § "Open source considerations")
- **Other:**
  - The OAuth scope policy from `architecture.md` § "Read-only Gmail access" is implemented and exercised end to end: `gmail.readonly` (the only Gmail-touching scope) plus the identity scopes `openid` and `userinfo.email`. No Gmail write scopes appear anywhere in the codebase. The build-time grep guard arrives in Slice 003 (where the Gmail API client is introduced); for now, the policy is enforced by code review and the absence of any Gmail client wrapper at all.

## Out of scope

- Gmail message fetching (`users.messages.list`, `users.messages.get`) and the Gmail API client wrapper → Slice 003
- Build-time check forbidding Gmail write endpoints → Slice 003
- WAL mode on the SQLite connection → Slice 004
- The `processed_messages`, `sync_state`, `app_config` tables and the rest of the migration backlog → Slice 004
- Repository layer for non-`accounts` tables → Slice 004
- Aggregate "this month: N processed, M receipts" counters on the Dashboard → not planned for v1 per `architecture.md` § "Components — Frontend — Dashboard"; the per-account live sync counters, the Audit view, and the unresolved-failure badge cover the immediate need.
- Ollama health check on the Dashboard → Slice 005
- Removing accounts (a "Disconnect" button) → not planned for v1; per `architecture.md` § "Components — Frontend" account management lives on the Dashboard with no v1 disconnect UI. Users who really need to remove an account can edit `data/app.db` directly or leave the account in `needs_reauth`.
- Editing `display_name` from the UI (the column exists and can be backfilled by hand if needed) → not planned for v1
- A standalone Settings → Accounts panel beyond what the Dashboard already shows → not planned for v1; the Dashboard is the canonical accounts surface (add, reconnect, status).

## Detailed design

This slice realizes `architecture.md` § "OAuth (loopback redirect, no persistence, per account)" end to end for the account-add path, and just enough of `architecture.md` § "Components — Auth module" for the in-memory token store to hold tokens for the rest of the session. It also stands up the minimal SQLite + migration plumbing that future persistence-touching slices build on; that plumbing is intentionally bare (no WAL, no general-purpose query helpers) so Slice 004 can add the rest without conflict.

- **OAuth flow.** Loopback redirect with the Hono server handling both ends. Hitting "Add Gmail account" calls `POST /api/oauth/start`; the returned `consent_url` opens in a new tab; Google redirects to `GET /oauth/callback`, which exchanges the code, reads the authenticated email from the ID token, upserts the row, and stores tokens. Reusing the main app port for the redirect URI avoids spawning a temp server per flow, which matters in Docker where binding to arbitrary ports requires extra port mappings. `architecture.md` § "OAuth (loopback redirect)" supports this ("Backend picks a fixed port (configured) for the redirect URI").
- **State map.** Random opaque strings, stored in an in-memory `Map<state, { kind: 'add' | 'reconnect', account_id?: number, expires_at: number }>`. Dropped after use or after a 10-minute TTL. State is **not** persisted — losing it on restart only affects in-flight OAuth attempts, which are rare and trivially retryable.
- **Token store.** Per `architecture.md` § "Auth module": a `Map<accounts.id, TokenSet>` in process memory only. Container stop = tokens gone. The store wraps `google-auth-library`'s `OAuth2Client` per account so that refresh-on-401 is handled by the library; we register a `tokens` listener that updates our `Map` when the library refreshes. On `invalid_grant`, we set `status='needs_reauth'` and remove the entry.
- **Per-account isolation.** All token operations and DB updates take an explicit `account_id`. Failures (missing token, refresh failure) for one account never affect others — this slice doesn't run concurrent operations across accounts, but the design (no global state apart from the token map keyed by id) is what makes Slices 005–006's per-account sync isolation possible.
- **Slug derivation.** `alice@example.com` → `alice-at-example-com`. Used for the file-store path in Slice 006; not exercised by this slice's UI directly, but materialized on insert so future slices can rely on it.
- **Dashboard.** A spartan single-page view: a heading "Docurator", an account list (or empty-state CTA), an Add button. No styling beyond default browser CSS plus a tiny amount of inline layout — Tailwind/shadcn arrives later (Slice 016 unless an earlier slice needs it). The Reconnect button is only rendered for rows in `status='needs_reauth'`. After clicking Add or Reconnect, the UI opens the consent URL in a new browser tab and polls the accounts list; the user closes the tab when Google says so. **Note**: `App.tsx` from Slice 001 is replaced — the literal "Docurator" placeholder text is now the Dashboard's heading, so the Slice 001 acceptance criterion ("page contains 'Docurator'") still holds.
- **Migration runner.** Single `_migrations` table tracking applied filenames. Runs in a transaction at startup; failure to apply aborts startup with a clear error. Migrations are append-only and never edited after they ship.
- **Bind mount and gitignore.** `./data` is bind-mounted so the SQLite file persists across `docker compose down`/`up`. `./data` itself stays in `.gitignore` (slice 001), but `data/.gitkeep` is force-added (`git add -f`) so the directory exists on a fresh clone.

## Acceptance criteria

- With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set in `.env`, `docker compose up` starts the app and the Dashboard renders with an empty account list and an "Add Gmail account" button.
- Clicking "Add Gmail account" opens Google's OAuth consent screen requesting `gmail.readonly` (the only Gmail-touching scope) plus the OAuth identity scopes `openid` and `userinfo.email` per `architecture.md` § "Read-only Gmail access"; approving it returns to a tab that says the user can close it, and the Dashboard's account list now contains a row for that Google address with `status='connected'`.
- Repeating the previous step while signed into a *different* Google account adds a second row (different `email`, different `slug`) without disturbing the first.
- After `docker compose down` and `docker compose up`, both accounts still appear on the Dashboard but with no tokens in memory; their `status` is whatever was persisted (typically `connected`), but any Gmail-touching call would prompt re-auth (no Gmail-touching calls exist in this slice).
- Manually revoking the app's access for one account in the Google account settings, then triggering a refresh (e.g. by waiting for token expiry or restarting the container so tokens are gone), produces an `invalid_grant` on the next OAuth refresh and flips that row's `status` to `needs_reauth` while the other account remains `connected`.
- Clicking "Reconnect" on a `needs_reauth` row runs the OAuth flow again and, on success, flips the row back to `connected` without inserting a duplicate row (matched by `email`).
- `GET /api/accounts` returns the same list the UI displays, in the schema documented above.
- The codebase contains no Gmail OAuth scope other than `gmail.readonly` (the only allowed Gmail scopes — `openid` and `userinfo.email` are the only non-Gmail OAuth scopes used, both for identity per `architecture.md` § "Read-only Gmail access"), and contains no calls to any Gmail API method (the Gmail client itself doesn't ship until Slice 003).

## Implementation notes

- **Reuse the main app port for the OAuth redirect.** The Hono server already listens on `APP_PORT` and is exposed by the Docker port mapping; the loopback redirect URI is `http://localhost:{APP_PORT}/oauth/callback`. This avoids extra Docker port mappings and avoids juggling a second HTTP server per flow. `OAUTH_REDIRECT_PORT` exists as an env-var escape hatch but defaults to `APP_PORT`.
- **`userinfo` scope.** Include `openid` and `https://www.googleapis.com/auth/userinfo.email` in the consent request alongside `gmail.readonly`, and read the email from the ID token returned in the token response. No separate `userinfo` HTTP call. Google's consent screen will display "Read your email messages and settings" plus "See your primary Google Account email address". Gmail access remains strictly read-only.
- **Slug collisions.** The slug algorithm appends a numeric suffix on conflict (e.g. `alice-at-example-com-2`). Slugs are stable per row but not always derivable from the email alone; the canonical lookup is by `accounts.id`, with `slug` used only for filesystem paths and URLs.
- **In-memory state map TTL.** OAuth `state` entries expire after 10 minutes. A user who takes longer than that restarts from the Add button.
- **`google-auth-library` token refresh.** The library's `tokens` event fires when the access token is refreshed; the in-memory map is updated from that listener. The library version pinned in `package.json` is the one this implementation targets.
