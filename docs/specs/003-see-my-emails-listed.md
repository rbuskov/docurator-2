# Slice 003: See my emails listed

**Status:** ready

## Observable result

I can navigate to an "Inbox" page, pick any one of my connected Gmail accounts from a dropdown, and see real Subject + Sender + Date for the most recent 50 messages in that account, fetched live from Gmail with no local persistence.

## Prerequisites (Consumes)

- **DB tables / columns:**
  - `accounts` table (Slice 002)
- **Migrations:**
  - `0001_create_accounts.sql` (Slice 002)
- **API endpoints:**
  - `GET /api/accounts` (Slice 002) — drives the account picker
- **UI views / components:**
  - `Dashboard.tsx` at `/` (Slice 002) — this slice introduces navigation between it and a new Inbox view
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (Slice 001)
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Slice 002)
- **Files / modules:**
  - `src/server/index.ts`, `src/server/config.ts`, `src/server/api/` (Slice 001)
  - `src/server/auth/accounts.ts`, `src/server/auth/session.ts`, `src/server/auth/oauth.ts` (Slice 002)
  - `src/server/db/index.ts` (Slice 002) — read-only use here, just so the accounts repo has its connection
  - `src/client/main.tsx`, `src/client/App.tsx`, `src/client/api.ts` (Slices 001/002)
- **External services:**
  - Google OAuth + Gmail API access for each connected account (Slice 002 produced the tokens; this slice is the first to make Gmail API calls)
- **Other:** —

## Deliverables (Produces)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:**
  - `GET /api/accounts/:id/messages?limit=50` → response `{ messages: Array<{ id: string, thread_id: string, subject: string, from: string, date: string, internal_date: string }> }`. Calls `users.messages.list` with `maxResults=limit` and the account's tokens, then `users.messages.get` with `format=metadata` and `metadataHeaders=['Subject','From','Date']` for each id, returning the parsed header values plus Gmail's `internalDate` (epoch ms as string). On token refresh failure for the named account, returns HTTP 401 with `{ error: 'needs_reauth', account_id }` and the slice-002 session helper has already flipped that account's `status` to `needs_reauth`. On any other Gmail API error, returns HTTP 502 with `{ error: 'gmail_error', message }`.
- **UI views / components:**
  - `Inbox.tsx` — at route `/inbox`. Shows the account picker (defaults to the first account in `GET /api/accounts`, persisted to `localStorage` as the most recently used selection), then a table of 50 rows with columns Subject, Sender, Date. Loading state while fetching, empty state when no accounts are connected, error state when the chosen account returns `needs_reauth` (links back to the Dashboard's Reconnect button) or `gmail_error`.
  - `AccountPicker.tsx` — reusable dropdown driven by `GET /api/accounts`. Filters out accounts whose `status !== 'connected'`. Used by the Inbox view here and intended to be reused by future slices.
  - `Nav.tsx` — top-of-page nav with links to `/` (Dashboard) and `/inbox` (Inbox), rendered by `App.tsx`.
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:**
  - `src/server/gmail/client.ts` — exports `createGmailClient(account_id: number)` that uses `session.withFreshTokens(account_id, …)` (from Slice 002) to obtain a current `OAuth2Client` and constructs `google.gmail({ version: 'v1', auth })`. Exposes only `listMessages({ maxResults, q?, pageToken? })` and `getMessage(id, { format, metadataHeaders? })`. **No write methods, no labels, no threads write, no drafts.**
  - `src/server/api/messages.ts` — registers `GET /api/accounts/:id/messages`
  - `src/client/views/Inbox.tsx`, `src/client/components/AccountPicker.tsx`, `src/client/components/Nav.tsx`
  - `src/client/router.tsx` — minimal client-side routing (React Router v6) wiring `/` → `Dashboard`, `/inbox` → `Inbox`. Used from `App.tsx`.
  - `scripts/check-gmail-readonly.ts` — node script (run via `tsx`) that walks `src/`, fails with a non-zero exit code if any file matches one of these literal substrings: `messages.modify`, `messages.trash`, `messages.delete`, `messages.send`, `messages.insert`, `messages.import`, `labels.create`, `labels.delete`, `labels.update`, `labels.patch`, `drafts.create`, `drafts.update`, `drafts.delete`, `drafts.send`, `threads.modify`, `threads.trash`, `threads.delete`, `gmail.modify`, `gmail.send`, `gmail.compose`, `gmail.insert`, `gmail.metadata`, `gmail.labels`, `gmail.settings.basic`, `gmail.settings.sharing`. The script itself is exempt from its own scan (it lists the strings as data); the exemption is implemented by ignoring the file path `scripts/check-gmail-readonly.ts`. Specs and Markdown under `docs/` are also exempt by directory.
  - `package.json` updates:
    - Adds `googleapis` to runtime deps (the `google-auth-library` from Slice 002 is already a transitive dep but is now a direct dep)
    - Adds `react-router-dom` to runtime deps
    - Adds `tsx` to dev deps (used by the build-time check)
    - Adds scripts: `"check:gmail-readonly": "tsx scripts/check-gmail-readonly.ts"`, and updates `"build"` to run `"npm run check:gmail-readonly && <existing build chain>"` so the check fails the build
- **External services:**
  - Live Gmail API calls (`users.messages.list`, `users.messages.get` with `format=metadata`) per selected account, scoped to that account's `gmail.readonly` tokens
- **Other:**
  - Build-time enforcement of "no Gmail write API references in src/", running on every `npm run build` and therefore every `docker compose up --build`

## Out of scope

- Persisting any of the fetched messages → Slice 006
- Classification of these messages → Slice 005
- Attachment fetching, body fetching, HTML→text or HTML→PDF rendering → Slices 005 / 006
- Pagination beyond the first 50 messages → Slice 006 (where full sync arrives)
- Multi-account aggregate inbox (showing messages from all accounts in one list) → not planned for v1; the Audit view in Slice 010 is the cross-account surface
- Filtering, sorting, search → Slices 010 / 011
- Inline classification action ("Classify this" button) → Slice 005 (which augments this view with the button)
- Replacement of this read-through view with a DB-backed Inbox → Slice 006

## Detailed design

This slice realizes the Gmail-side half of `architecture.md` § "Privacy model" and § "Read-only Gmail access" for the first time: a real call to Google's servers using a connected account's `gmail.readonly` tokens. It also stands up the build-time guard from `architecture.md` § "Security notes — CI enforcement". The intent of the slice (per `initial-feature-slices.md`'s note) is to prove the Gmail integration works per account and to discover API quirks early; its Inbox view is intentionally throwaway-friendly and gets replaced by Slice 006's persisted view.

- **Gmail client wrapper.** Thin layer over `googleapis`. Constructed per-call (not cached) via `session.withFreshTokens`, so each call uses currently-valid tokens for that account and refresh-on-401 already runs through the Slice 002 helper. The wrapper deliberately exposes only two methods (`listMessages`, `getMessage`); future slices that need attachments, history, or threads will add explicit methods (still read-only). Limiting the surface is what the build-time check enforces.
- **Why `format=metadata` for `getMessage`.** Headers-only is what this slice needs and is the cheapest option (no body, no attachments, no payload tree to parse). It also avoids ever pulling email content into memory in a slice that's not allowed to persist anything — a small architectural belt to go with the suspenders.
- **Date display.** Show Gmail's `Date` header verbatim (it's already an RFC 2822 string the user sees in their email client); don't reformat. `internalDate` is included in the API response for any future slice that needs a sortable timestamp.
- **Sender display.** Show the `From` header verbatim (e.g. `"Stripe <receipts@stripe.com>"`). Pretty-printing into name + email columns is polish.
- **Account picker behavior.** Defaults to the most recently used account, falling back to the first `connected` account in `GET /api/accounts`. The "most recently used" selection is stored under `localStorage['docurator.lastInboxAccountId']`. Accounts in `needs_reauth` status appear in the dropdown but are visually disabled with a "Reconnect on Dashboard" hint — selecting one is impossible, since the Inbox can only render messages from a `connected` account.
- **Routing.** React Router v6 with `BrowserRouter`. Two routes for now (`/` and `/inbox`). The `Nav` component is rendered above the route outlet so it appears on every view. Slice 002's Dashboard continues to live at `/`; this slice does not change Dashboard behavior, only adds the nav links to and from it.
- **Build-time check.** Implemented as a Node script run from `package.json`. The Dockerfile from Slice 001 already runs `npm run build` in its build stage, so the check is enforced on every image build without further Dockerfile changes. The script's match list is duplicated (deliberately) from the comments above so that adding a new forbidden pattern is a one-place edit. `architecture.md` § "Security notes" calls this out as the canonical enforcement; this slice ships it.
- **Error model.** Per-account isolation matters even in this read-only slice. A 401 from the Gmail API for one account flips that account to `needs_reauth` (via the existing Slice 002 helper) and surfaces a UI hint; the picker still works for the other accounts. Other Gmail errors (rate limit, transient 5xx) are returned as `gmail_error` and the user can retry by re-selecting the account.
- **No DB writes.** This slice's API handler does not write to SQLite. The accounts repo is read-only from this slice's perspective (the `last_seen_at` touch on successful Gmail use is deferred to Slice 006, where it lives alongside the rest of the sync orchestrator's bookkeeping).

## Acceptance criteria

- With at least one Gmail account connected from Slice 002, navigating to `/inbox` shows the Inbox view with the account picker pre-populated to the first connected account and a table of up to 50 message rows.
- Each row shows the message's `Subject` header, `From` header, and `Date` header, all matching what the same message displays in Gmail's web UI for that account.
- Switching the account picker to a different connected account reloads the table to show that account's most recent messages, with no leakage of the previous account's messages.
- An account in `needs_reauth` appears in the picker as visually disabled and cannot be selected.
- If a previously `connected` account's refresh token is revoked in Google's settings, the next request from `/inbox` for that account flips it to `needs_reauth` (visible on the Dashboard) and the Inbox shows the error state, while other accounts continue to work.
- No row is written to any SQLite table during the Inbox flow (the only writes during the slice are still those produced by Slice 002's OAuth flow).
- `npm run build` (and therefore `docker compose up --build`) fails with a non-zero exit code if any file under `src/` contains one of the forbidden Gmail-write substrings; the build passes when none of them do.
- Adding a deliberate `messages.modify` reference to any TypeScript file under `src/` causes the next `npm run build` to fail with a clear message naming the file and the offending substring.
- The codebase contains zero references to OAuth scopes other than `gmail.readonly`, `userinfo.email`, and `openid` (the latter two pulled in by Slice 002's consent flow).

## Risks / open questions

- **N+1 fetch pattern.** `users.messages.list` returns just `id` and `threadId`; getting headers requires one `users.messages.get` per message. For 50 messages this is 51 sequential round-trips. Acceptable for this throwaway slice; Slice 006's sync orchestrator will need to be smarter (concurrent fetches, history-API incremental). Flag.
- **`format=metadata` and the `gmail.metadata` scope.** Google's docs sometimes suggest `format=metadata` requires the `gmail.metadata` scope. In practice `gmail.readonly` covers metadata fetches as well; the build-time check explicitly forbids the scope string `gmail.metadata` to keep the read-only guarantee tight. If this turns out to be wrong, the implementation slice will need to switch to `format=full` and parse headers from the payload tree (still read-only, just more bytes). Flag.
- **React Router introduction.** Slice 002 lived at `/` only and didn't need a router. Introducing `react-router-dom` here means `App.tsx` is rewritten again. If the project ends up wanting a hash router, file-based routing, or Tanstack Router, swap is local to `src/client/router.tsx` and `App.tsx`. Flag for confirmation; provisional choice is React Router v6.
- **Build-time check granularity.** The script does substring matching on the file's text, not AST analysis. False positives are possible (e.g. a comment that mentions `messages.delete`). The script ignores `.md` files under `docs/`; the design assumption is that nothing else in `src/` should be talking about those strings even in comments. Flag.
- **Slice supersession.** `initial-feature-slices.md` notes this slice "gets superseded by Slice 6". The Inbox view at `/inbox` will be reshaped (DB-backed, not live Gmail) in Slice 006. The Gmail client wrapper, the build-time check, and the messages API endpoint are kept; only the Inbox view's data source changes. The supersession is a content rewrite, not a delete — Slice 006 does not list `Inbox.tsx` as a deliverable, only as a modified consumer.
- **`localStorage`-backed picker selection.** Persisting "last used account" client-side is a small UX nicety that crosses no privacy line (no email content, just the chosen account ID). If the user wipes browser storage, the picker falls back to the first connected account. Flag if a server-side preference is preferred.
