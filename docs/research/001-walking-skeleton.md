# Slice 001: Walking skeleton — Research

**Spec:** `docs/specs/001-walking-skeleton.md`

## Summary of what the spec asks for

The smallest end-to-end skeleton future slices can graft onto. After `docker compose up`, `GET /health` returns `200 ok` and `http://localhost:3737/` renders a React page whose visible text is the literal word "Docurator". Headline deliverables are the project scaffolding (`package.json`, `tsconfig.json`, `vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `LICENSE`), a Hono server entry (`src/server/index.ts` + `src/server/config.ts`), and a Vite-built React entry (`src/client/main.tsx` + `src/client/App.tsx`).

## Existing code that this spec touches

The repo is greenfield — there is no `src/`, no `package.json`, no Dockerfile. Everything in the spec's Deliverables list must be created from scratch. The pieces that already exist and partly intersect this spec:

- `.gitignore` — already covers everything the spec calls for (`node_modules/`, `dist/`, `.env`, `/data/`, `/invoices/`) and more (build output, Vite cache, Playwright cache, SQLite ancillary files, OS detritus, Claude per-developer settings). No edit needed beyond confirming. The spec's bullet says "at minimum" those five paths; the existing file already satisfies that.
- `docs/architecture.md` — referenced by the spec for "Project structure", "Tech stack", and "Docker Compose layout". This research treats those sections as authoritative and cites them rather than re-deciding.
- `docs/adr/000-adr-template.md` — exists but is empty (0 lines). If this slice writes its first ADR, the template needs to be populated as part of that ADR's iteration. (Not part of the slice unless an ADR comes up.)

Everything else under `src/server/...` and `src/client/...` listed in the spec — except the explicit files for this slice — is **deliberately not** created. Per the spec's Detailed design, "subdirectories that future slices will fill … are not created in this slice — empty directories add noise. Each later slice creates the directories it needs."

## Patterns to follow

This is the first spec; almost no patterns exist yet. The walking skeleton is what *establishes* them, so this section records the patterns I'll set here so later slices can follow them. Each is the simplest viable choice that doesn't paint future specs into a corner.

- **Hono app shape.** A single `src/server/index.ts` builds a `new Hono()`, registers routes, and starts the listener via `@hono/node-server`'s `serve(...)`. Future slices import the app or its router builder rather than re-creating the listener.
- **Route order.** Specific routes (`/health`, later `/api/...`, later `/oauth/callback`) are registered before the static fallback that serves `dist/client/`, so the fallback never intercepts them.
- **Static asset serving.** Use `@hono/node-server/serve-static` pointed at `dist/client/`. The spec is silent on the exact mechanism; this is the lowest-friction option in Hono's Node adapter and keeps the server free of bundler logic at runtime.
- **Config loading.** `src/server/config.ts` exports a frozen object (e.g. `export const config = { port: ... }`). Reads from `process.env` with explicit defaults. No `dotenv` library — `docker-compose.yml`'s `environment:` block is the deployment surface, and `process.env` is sufficient. Each later spec adds *its own* env keys to this module.
- **TypeScript layout.** A single root `tsconfig.json` with `strict: true`, `module: "ESNext"`, `moduleResolution: "bundler"` (so Vite is happy), `jsx: "react-jsx"`, `target: "ES2022"`, `outDir: "dist/server"`, `rootDir: "src"`, including both `src/server/**/*` and `src/client/**/*`. Vite ignores `outDir`/`rootDir` and uses its own pipeline; `tsc` uses them for the server build. One config keeps editor tooling simple at this size; if it bites later, splitting is cheap.
- **Vite config.** `vite.config.ts` puts `root` at `src/client`, `build.outDir` at `../../dist/client` (so Vite emits into the project-level `dist/client/`), and registers `@vitejs/plugin-react`. No proxy yet (no API routes for the dev server to proxy in this slice).
- **Dockerfile pattern.** Multi-stage. Stage 1 (`builder`): `node:20-alpine` base, `npm ci`, copy source, `npm run build` (which chains `vite build` + `tsc -p tsconfig.json --outDir dist/server`). Stage 2 (`runtime`): `node:20-alpine`, copy `package.json` + `package-lock.json`, `npm ci --omit=dev`, copy `dist/`, `CMD ["node", "dist/server/index.js"]`. `EXPOSE 3737`. Why `node:20-alpine`: small, LTS, available everywhere; matches the `engines` we'll declare in `package.json`.
- **`docker-compose.yml`.** As specified — single `app` service, `3737:3737`, `extra_hosts: host.docker.internal:host-gateway`. No `volumes`, no `environment` block beyond what `APP_PORT`'s default already covers. Architecture's full Compose layout (`./data`, `./invoices`, `GOOGLE_*`, `OLLAMA_*`) is reached incrementally by Slices 002, 005, 006.
- **Test framework.** Vitest. Lives in `devDependencies` only, with a single `test` script in `package.json`. Vitest is the natural match for a Vite-driven project, supports both server (Node env) and client (jsdom) tests with one runner, and plays well with TypeScript without a transpile config. Picking it now sets the standard for every later slice. **This warrants an ADR** (see "Risks and open questions"), written in the same iteration as the first plan step that adds a test.
- **NPM scripts.** `dev` (concurrently runs `vite` and a watch-mode server via `tsx watch src/server/index.ts`), `build` (`vite build` then `tsc -p tsconfig.json`), `start` (`node dist/server/index.js`), `test` (`vitest run`). `tsx` is added as a dev dep purely so `dev` can run TS directly without a per-developer global install; the production runtime is plain `node`.

## Refactors needed before adding the new feature

None. The repo is empty.

## Risks and open questions

- **Test framework choice is an ADR.** The spec's `package.json` bullet doesn't list a test framework, and `architecture.md` § "Tech stack" is silent on testing. But every subsequent slice will write tests. Picking Vitest now (over Jest, node:test, or other options) is exactly the kind of decision the loop's "When to write an ADR" rules call out: future specs must respect it, and a future contributor will want to know why. **Action:** when the first plan step that adds Vitest lands, ship `adr/001-test-framework-vitest.md` in the same iteration. Populate `adr/000-adr-template.md` then too, since it's currently empty and the new ADR needs a structural reference.
- **Single `tsconfig.json` vs. split server/client configs.** I'm choosing single. Vite will tolerate the server-style options it doesn't care about, and `tsc -p tsconfig.json` will type-check everything in one pass. The small risk: if `tsc`'s `outDir`/`rootDir` interact awkwardly with client files (which Vite is supposed to own), I'll exclude `src/client/**` from the `tsc` build via `tsconfig.json`'s `exclude` while keeping it in `include` for editor language services — the established TypeScript+Vite pattern. If even that splits, I'll switch to two configs and note it in the review's "Decisions worth flagging".
- **Production server: where do static files live in the image?** Vite emits to `dist/client/` (project-relative). The Hono server's static handler must resolve a path relative to the *built server file* (`dist/server/index.js`), which means `path.resolve(__dirname, "../client")` after the build. Easy to get wrong on Linux vs macOS path semantics. I'll write a test that asserts `GET /` returns HTML containing the word "Docurator", served from a fake static dir, to lock in the resolution logic before Docker ever runs. The full Docker smoke test is the belt-and-braces verification.
- **`tailwindcss` declared but unused.** The spec says declare the dep, don't wire it. Tailwind's package alone is harmless — no PostCSS config, no `@tailwind` directives in any CSS file. Risk is purely cosmetic (a stray dependency); accept it because the spec explicitly mandates it.
- **Dev workflow needing `concurrently` or similar.** The spec's "Implementation notes" calls a basic `npm run dev` script "Vite dev server + watch-mode server". To run two processes from one script I'll add `concurrently` (or use `npm-run-all`'s `run-p`) to dev deps. This is a routine choice, not an ADR.
- **`node:20-alpine` vs `node:20-bookworm-slim`.** Alpine is smaller; bookworm-slim is glibc-based and has fewer subtle native-module surprises. For this slice nothing depends on native modules. `better-sqlite3` (Slice 004) and Playwright (Slice 006) might force a switch later. If so, that's a dedicated decision with its own ADR; for now Alpine is fine and I'll note it as a possible future flip in the review's "Decisions worth flagging".
- **`LICENSE` body.** MIT, copyright "(c) 2026 Docurator contributors". Spec accepts "or equivalent placeholder"; I'll use that exact line.

## Test strategy

The spec's Acceptance criteria are largely Docker-level, but the loop's quality bar pushes for TDD where applicable. Concretely:

- **Unit tests planned (vitest, Node env):**
  - `src/server/config.test.ts` — `config.port` defaults to `3737`; `config.port` honors `process.env.APP_PORT` (test sets and restores `process.env`). Asserts the type/shape of the exported config object.
  - `src/server/index.test.ts` — builds the Hono app via an exported `createApp()` factory and exercises `app.fetch(new Request("http://x/health"))` → 200 status, body `"ok"`, content-type `text/plain` (or whatever Hono's `c.text` sets). One test for the static fallback: with a temp dir containing an `index.html` whose body is `<div id="root">Docurator</div>`, `app.fetch(new Request("http://x/"))` returns 200 and the response body contains "Docurator". The factory takes the static dir as an argument so the test can point it at a fixture instead of `dist/client/`.

- **Integration tests planned:** the Hono `app.fetch` tests above already cross the request-handling boundary and stand in for an integration test at this slice's scale. No separate Supertest/HTTP-listener integration is needed yet; later slices that need real HTTP will add it.

- **Smoke test outline (manual, run by priority 5):**
  1. `docker compose down -v` (idempotent reset; nothing to nuke yet but stays correct in later slices).
  2. `docker compose up --build -d`. Wait for the container to report healthy / for port `3737` to accept connections.
  3. `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:3737/health` → expect `200` and a `text/plain` content-type. Then `curl -sS http://localhost:3737/health` → expect literal `ok`.
  4. `curl -sS http://localhost:3737/` → expect HTTP 200 and a response body that includes the substring `Docurator` (the React shell rendered to HTML by Vite's `index.html`).
  5. Optional manual: open `http://localhost:3737/` in a browser, confirm the visible page text contains "Docurator" with no console errors.
  6. `docker compose down`. Then `docker compose up -d` (no `--build`) — confirm cached image still serves both endpoints.
  7. `git status` on the working tree — expect clean (no `node_modules/`, `dist/`, `data/`, `invoices/`, or `.env` leaks).
