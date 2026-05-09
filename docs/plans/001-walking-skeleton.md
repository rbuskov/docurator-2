# Slice 001: Walking skeleton — Plan

**Spec:** `docs/specs/001-walking-skeleton.md`
**Research:** `docs/research/001-walking-skeleton.md`

## Steps

Each step is small enough to fit in one loop iteration. Each step ends with a concrete check — a named test passing, or a specific command's output. Per-step refactor is folded into the priority-3 action.

- [x] **Step 1: Bootstrap `package.json` and install deps.** Write `package.json` declaring runtime deps (`hono`, `@hono/node-server`, `react`, `react-dom`) and dev deps (`typescript`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `vitest`, `@types/node`, `@types/react`, `@types/react-dom`, `tsx`, `concurrently`). Add scripts `dev`, `build`, `start`, `test` per the research. Set `"type": "module"` and `"engines": { "node": ">=20" }`. Verification: `npm install` exits 0 and `node_modules/hono/package.json` exists. — _Done: 201 packages installed; `hono@4.12.18` resolved. `package-lock.json` written. Note: `npm audit` reports 5 moderate vulnerabilities in vitest's transitive `vite-node`; deferred (review followup)._

- [x] **Step 2: Write `tsconfig.json`, `tsconfig.server.json`, `LICENSE`.** Two-config TS layout. `tsconfig.json` (root) is the editor / `--noEmit` config — `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, strict, `noUncheckedIndexedAccess`, `lib: [ES2022, DOM, DOM.Iterable]`, `include: ["src/**/*", "vitest.config.ts", "vite.config.ts"]`, `noEmit: true`. `tsconfig.server.json` extends it for emit — `module: NodeNext`, `moduleResolution: NodeNext`, `lib: [ES2022]`, `outDir: dist/server`, `rootDir: src/server`, `include: ["src/server/**/*"]`, `exclude: ["src/server/**/*.test.ts"]`, `sourceMap: true`. NodeNext is required because the server runs as plain Node ESM; this means server source files import with explicit `.js` suffixes (vitest's Vite-based resolver also accepts that). Update `package.json`'s `build` script to `vite build && tsc -p tsconfig.server.json`. MIT `LICENSE` with first line `MIT License` and copyright `(c) 2026 Docurator contributors`. Verification: both tsconfigs parse as JSON via `node -e "JSON.parse(...)"` **and** `head -1 LICENSE` contains `MIT`. (Original verification `tsc --showConfig` rejects empty input sets with TS18003 — deferred to step 3, where adding the first `.ts` file makes `tsc --noEmit` runnable.) — _Done: both tsconfigs valid JSON; `head -1 LICENSE` → `MIT License`. Build script updated to point at the server config._

- [x] **Step 3: Vitest setup, `config.ts` red→green, ADR-001.** Add `vitest.config.ts` (Node env by default, plus a project for jsdom-based client tests deferred to later slices). Write `src/server/config.test.ts` asserting `config.port === 3737` by default and `config.port === Number(process.env.APP_PORT)` when set. Run `npx vitest run` — test fails (module missing) **red**. Implement `src/server/config.ts` as `export const config = Object.freeze({ port: Number(process.env.APP_PORT ?? 3737) })`. Re-run **green**. Populate `docs/adr/000-adr-template.md` with the structural template. Write `docs/adr/001-test-framework-vitest.md` (status Accepted) capturing the choice and alternatives considered. Verification: `npx vitest run src/server/config.test.ts` passes (2 tests) and both ADR files exist with non-empty content. — _Done: 3 tests passing (added a third for `Object.isFrozen(config) === true` since the config shape exposes a frozen object). ADR template populated with Status / Date / Context / Decision / Consequences / Alternatives / Supersession sections; ADR-001 captures the Vitest choice and rejects Jest, node:test, Mocha+Chai. Used `vi.resetModules()` per test so each import sees the right `process.env.APP_PORT`._

- [x] **Step 4: Hono `createApp()` + `/health` route.** Write `src/server/index.test.ts` exercising `createApp({ staticDir })` via `app.fetch(new Request("http://x/health"))` → status 200, body `"ok"`. Run vitest — **red**. Implement `src/server/app.ts` exporting `createApp({ staticDir }: { staticDir: string }): Hono` that registers `app.get('/health', c => c.text('ok'))`. Re-run **green**. Verification: `npx vitest run src/server/index.test.ts` passes; the `/health` test asserts both status code and body literal. — _Done: 1 test passing. Two small deviations from plan text: (a) test file is `src/server/app.test.ts` (matches the unit under test, `app.ts`) — the plan's `index.test.ts` would have been misleading once `index.ts` is added in step 6 as the listener entry. (b) `staticDir` made optional (`staticDir?: string`) so step 4 doesn't need to fabricate a path; step 5 will exercise the populated case._

- [x] **Step 5: Static fallback for `dist/client/`.** Add a vitest case: with a temp staticDir containing `index.html` whose body is `<!doctype html><html><head><title>Docurator</title></head><body><div id="root"></div></body></html>`, `app.fetch(new Request("http://x/"))` returns 200 and the response body contains `"Docurator"`. Run vitest — **red**. Implement using `@hono/node-server/serve-static` registered after `/health`, rooted at the passed `staticDir`. Re-run **green**. Also add an empty `src/server/api/.gitkeep` so the directory exists per the spec's Files / modules list. Verification: vitest passes; `ls src/server/api/.gitkeep` succeeds. — _Done: 3 tests passing in `app.test.ts` (default `/health`, static `/`, plus an explicit route-order guard that `/health` still wins when `staticDir` is set). Used `mkdtempSync(join(tmpdir(), 'docurator-static-'))` for fixture isolation. `serveStatic` registered with `app.use('*', ...)` after the `/health` GET registration so route-registration order keeps the specific route in front. `src/server/api/.gitkeep` present (0 bytes)._

- [x] **Step 6: Server entrypoint (`src/server/index.ts`) and listener.** Wire `createApp({ staticDir })` with `staticDir` resolved as `path.resolve(fileURLToPath(import.meta.url), '../../client')` (i.e. `dist/client/` relative to `dist/server/index.js` once built). Use `serve({ fetch: app.fetch, port: config.port })` from `@hono/node-server`. Verification: `npx tsc --noEmit -p tsconfig.json` exits 0 and `npx vitest run` still green (existing tests not broken). — _Done: `tsc --noEmit -p tsconfig.json` clean, all 6 tests still pass. Used the clearer `dirname(fileURLToPath(import.meta.url))` + `resolve(moduleDir, '../client')` form rather than the plan's collapsed `'../../client'` form (same result; easier to read). Also exercised `tsc -p tsconfig.server.json` as a bonus — emits `app.js`, `config.js`, `index.js` (+ sourcemaps) into `dist/server/`, confirming the NodeNext server build works._

- [x] **Step 7: Vite client (`vite.config.ts`, `src/client/index.html`, `main.tsx`, `App.tsx`).** `vite.config.ts` sets `root: 'src/client'`, `build.outDir: '../../dist/client'`, `build.emptyOutDir: true`, registers `@vitejs/plugin-react`. `src/client/index.html` contains `<title>Docurator</title>` and a `<div id="root"></div>` plus `<script type="module" src="./main.tsx"></script>`. `App.tsx` renders the literal text "Docurator" inside a `<main>`. `main.tsx` mounts `<App />` into `#root` via `createRoot`. Verification: `npm run build` exits 0 **and** `dist/client/index.html` exists **and** `grep -q "Docurator" dist/client/index.html` succeeds (matches the `<title>`) **and** `dist/server/index.js` exists. — _Done: vite v6.4.2 build emits `dist/client/index.html` (0.32 kB) + `dist/client/assets/index-BvVscTzx.js` (194.62 kB); tsc emits `app.js`, `config.js`, `index.js` to `dist/server/`. All 6 tests still pass. `main.tsx` wraps `<App />` in `StrictMode` and throws on a missing `#root` element rather than rendering into `null`._

- [x] **Step 8: `Dockerfile` (multi-stage).** Stage `builder` on `node:20-alpine`: `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci`, `COPY . .`, `RUN npm run build`. Stage `runtime` on `node:20-alpine`: `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci --omit=dev`, `COPY --from=builder /app/dist ./dist`, `EXPOSE 3737`, `CMD ["node", "dist/server/index.js"]`. Add `.dockerignore` covering `node_modules`, `dist`, `.git`, `data`, `invoices`, `.env`. Verification: `docker build -t docurator:dev .` exits 0 and `docker run --rm -d --name docurator-smoke -p 3737:3737 docurator:dev` followed by `curl -fsS http://localhost:3737/health` returns `ok` (then `docker rm -f docurator-smoke`). — _Done: builder stage `vite build` + `tsc` succeeded inside the container (28 modules, ~195 kB client bundle), runtime stage uses `npm ci --omit=dev` + `npm cache clean --force`. `ENV NODE_ENV=production` set in the runtime stage. Builder stage uses explicit `COPY` of `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, and `src/` rather than `COPY . .` — minor deviation from plan text, eliminates reliance on `.dockerignore` to keep build context tight. Smoke: `curl /health` → `ok`, `curl /` → 200, server logs `Docurator listening on http://localhost:3737`._

- [x] **Step 9: `docker-compose.yml`.** Single `app` service per the spec — `build: .`, `ports: ["3737:3737"]`, `extra_hosts: ["host.docker.internal:host-gateway"]`, no volumes, no environment block (the `APP_PORT` default lives in `config.ts`). Verification: `docker compose config` parses without error and surfaces the `app` service with port mapping `3737:3737`. — _Done: `docker compose config` resolves the project name `docurator-2`, single `app` service, build context = repo root, target/published port `3737/3737`, `extra_hosts: host.docker.internal=host-gateway`. No environment, no volumes — matches Slice 001 scope; `./data`, `./invoices`, and `GOOGLE_*` / `OLLAMA_*` env land in Slices 002 / 005 / 006 per the spec's "Out of scope"._

## Smoke test recipe

The exact sequence the loop will run after all plan steps are checked. All commands run from the repo root.

1. `docker compose down -v` (idempotent reset; safe even if nothing is running).
2. `docker compose up --build -d` and wait for the container to start listening (poll `curl -fsS http://localhost:3737/health` until it returns 0; cap at ~60s).
3. `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3737/health` → expect `200`. Then `curl -sS http://localhost:3737/health` → expect literal `ok`.
4. `curl -sS http://localhost:3737/` → expect HTTP 200 and a response body containing the substring `Docurator` (matches the `<title>`).
5. Open `http://localhost:3737/` in a real browser; confirm the visible page text contains "Docurator" with no console errors. Record what was observed.
6. `docker compose down`, then `docker compose up -d` (no `--build`) — confirm the cached image still answers `/health` and `/` correctly.
7. `git status` on the working tree → expect clean (no `node_modules/`, `dist/`, `data/`, `invoices/`, or `.env` leaks).
8. `docker compose down` to leave the host clean.

## Test run

- **Date:** 2026-05-09
- **Command:** `npx vitest run`
- **Result:** 2 test files, 6 tests, all passing. Duration 274 ms.
  - `src/server/config.test.ts` — 3 tests (default port, `APP_PORT` env override, frozen object)
  - `src/server/app.test.ts` — 3 tests (`/health` body & status, static `/` serves index, `/health` wins over static fallback)

## Smoke run

- **Date:** 2026-05-09
- **Result:** Pass.

Sequence executed:

1. `docker compose down -v` — removed any stale state (idempotent).
2. `docker compose up --build -d` — image rebuilt cleanly, container started. `/health` accepted connections after 1s.
3. `curl -sS http://localhost:3737/health` → HTTP 200, `Content-Type: text/plain; charset=UTF-8`, body `ok`.
4. `curl -sS http://localhost:3737/` → HTTP 200, `Content-Type: text/html; charset=utf-8`. Body contains `<title>Docurator</title>` and `<div id="root"></div>` plus a `<script type="module" crossorigin src="/assets/index-BvVscTzx.js">` injected by Vite.
5. `curl -sS http://localhost:3737/assets/index-BvVscTzx.js` → 194,617 bytes; bundle contains the literal string `"Docurator"` (1 occurrence — the React text node `App.tsx` renders into `<main>`). Confirms the SPA will render visible "Docurator" once the JS executes in a browser.
6. `docker compose down`, then `docker compose up -d` (no `--build`) — cached image starts and `/health` and `/` keep returning the same responses. Server log shows `Docurator listening on http://localhost:3737`.
7. `git status` after `docker compose down` — no `node_modules/`, `dist/`, `data/`, `invoices/`, or `.env` in the working tree (`.gitignore` is doing its job). Only the slice's new files are pending.
8. `docker compose down` to leave the host clean.

**Caveats:**

- A live in-browser DOM render (open the URL in Chrome/Safari, look at the visible page text) was **not** automated. The agent doesn't drive a real browser. The combined evidence — Vite-served `index.html` with the title, the bundle containing the literal string, and `app.test.ts` proving `serveStatic` returns the right HTML — is the strongest substitute available without adding Playwright/Puppeteer to the dev surface. A future slice that introduces React component testing (jsdom + RTL) will close this gap; recorded as a review followup.
