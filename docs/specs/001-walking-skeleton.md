# Slice 001: Walking skeleton

**Status:** draft

## Observable result

I can run `docker compose up` and visit `http://localhost:3737` to see a page that says "Docurator".

## Prerequisites (Consumes)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:** —
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:** —
- **External services:** —
- **Other:** —

## Deliverables (Produces)

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:**
  - `GET /health` → `200` with plain-text body `ok`
- **UI views / components:**
  - Placeholder `App.tsx` page that renders the text "Docurator" (and nothing else of substance) at `/`
- **Background jobs / orchestrators:** —
- **Env vars / configuration:**
  - `APP_PORT` (default `3737`) — port the Hono server listens on inside the container; mapped to host port `3737`
- **Files / modules:**
  - `package.json` — declares `typescript`, `hono`, `@hono/node-server`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, dev scripts (`dev`, `build`, `start`)
  - `tsconfig.json` — strict TypeScript config covering both `src/server` and `src/client`
  - `vite.config.ts` — builds the client from `src/client` into a static bundle the server serves
  - `Dockerfile` — multi-stage build: install deps, build client + server, run `node dist/server/index.js`
  - `docker-compose.yml` — one service `app`, ports `3737:3737`, `extra_hosts: host.docker.internal:host-gateway` for later Linux compatibility (not yet exercised)
  - `.gitignore` — at minimum: `node_modules/`, `dist/`, `.env`, `data/`, `invoices/`
  - `LICENSE` — MIT, with copyright line
  - `src/server/index.ts` — Hono entrypoint: registers `GET /health`, serves the built client static assets, listens on `APP_PORT`
  - `src/server/config.ts` — minimal env loader exporting `APP_PORT`
  - `src/server/api/` — directory exists (empty placeholder file is fine) so later slices have somewhere to add routes
  - `src/client/main.tsx` — React entrypoint mounting `<App />`
  - `src/client/App.tsx` — placeholder component rendering "Docurator"
- **External services:**
  - Host requirement: Docker + Docker Compose installed (no app-level integration yet)
- **Other:** —

## Out of scope

- Gmail OAuth flow, account-add UI, `accounts` table → Slice 002
- Reading Gmail messages or any Gmail API client wrapper → Slice 003
- SQLite, migration runner, persistent state → Slice 004
- Ollama integration, classification → Slice 005
- Tailwind / shadcn/ui styling beyond what's needed to show plain text → Slice 016 (polish)
- README walkthrough with screenshots and full setup docs → Slice 016
- CI build-time check forbidding Gmail write endpoints → Slice 003 (introduced alongside the Gmail client wrapper)

## Detailed design

This slice is the smallest end-to-end skeleton that future slices can graft onto. It establishes the project structure described in `architecture.md` § "Project structure" and the container layout in § "Docker Compose layout", but only the parts needed to serve a static page.

- **Repo layout.** Top-level files (`package.json`, `tsconfig.json`, `vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `LICENSE`, `.gitignore`) plus `src/server/` and `src/client/` trees as sketched in `architecture.md` § "Project structure". Subdirectories that future slices will fill (`src/server/auth/`, `src/server/gmail/`, `src/server/classify/`, `src/server/db/`, `src/client/views/`, etc.) are **not** created in this slice — empty directories add noise. Each later slice creates the directories it needs.
- **Tech stack pinning.** Use the choices from `architecture.md` § "Tech stack": TypeScript, Node.js, Hono, React + Vite. No need to wire Tailwind/shadcn beyond what's required to render plain text; full design system arrives later.
- **Server.** Hono app with two responsibilities: (1) respond to `GET /health` with `200 ok`, (2) serve the Vite-built static client from `dist/client/` for any other GET. No SSR. Listens on `APP_PORT` (default `3737`).
- **Client.** Vite-built React app whose root component renders the literal text "Docurator". No router, no styling beyond defaults. The page exists to prove the build pipeline and the server-serves-client wiring work end to end.
- **Config loader.** `src/server/config.ts` reads `process.env.APP_PORT`, falls back to `3737`. Other env vars (Google OAuth credentials, Ollama URL) are introduced by the slices that need them; this slice does not pre-declare them.
- **Dockerfile.** Multi-stage: a build stage that installs dev deps and runs `vite build` plus the server's TypeScript build, and a runtime stage that copies `dist/` and `node_modules/` (production only) and runs the server. Image must run on Linux/macOS/Windows hosts via Docker Desktop.
- **docker-compose.yml.** Single `app` service. Maps `3737:3737`. Includes `extra_hosts: host.docker.internal:host-gateway` so later slices that talk to host-side Ollama work on Linux without further changes — declared now so the file is stable. **No bind-mounted volumes yet** (`./data` and `./invoices` arrive in Slices 4 and 6 respectively, when there's something to write). **No environment variables yet** beyond what `APP_PORT` defaults to internally.
- **LICENSE.** MIT, with copyright `(c) 2026 Docurator contributors` (or equivalent placeholder).
- **.gitignore.** Covers `node_modules/`, `dist/`, `.env`, `data/`, `invoices/`. The latter two paths are listed now even though they aren't created until later, so a developer running future slices can't accidentally commit local state.

## Acceptance criteria

- Running `docker compose up --build` from a clean checkout builds the image and starts the container without manual intervention.
- After the container is up, `curl http://localhost:3737/health` returns HTTP 200 with body `ok`.
- Loading `http://localhost:3737/` in a browser shows a page whose visible text contains "Docurator".
- `docker compose down` followed by `docker compose up` (no `--build`) starts the same app from the cached image.
- The repo at this slice's commit contains a top-level `LICENSE` file whose first line identifies the MIT license.
- `git status` on a fresh clone after `npm install` and `docker compose up` reports a clean working tree (i.e. `.gitignore` covers everything generated).

## Risks / open questions

- **Exact placeholder copy.** The Observable result requires the page to say "Docurator". Whether to also show a tagline ("a curator of your business documents") is left to Slice 016 polish; this spec keeps it to the single word so the assertion in tests is unambiguous.
- **TypeScript build for the server.** `architecture.md` doesn't mandate `tsc` vs `tsx`/`esbuild`/SWC for the server. Provisional choice: plain `tsc` to `dist/server/` for simplicity; revisit if cold start becomes an issue.
- **Tailwind in this slice?** Architecture lists Tailwind in the stack, but no styling is needed to satisfy the Observable result. Provisional choice: do not configure Tailwind yet; introduce it the first time a slice needs styled components (likely Slice 002 for the Dashboard). Flag for human confirmation.
- **Dev-mode workflow.** `npm run dev` (Vite dev server + watch-mode server) is convenient but not required by the Observable result. Provisional choice: include a basic `dev` script but don't gate the slice on it; the production `docker compose up` path is what ships.
