# Slice 001: Walking skeleton — Review

**Spec:** `docs/specs/001-walking-skeleton.md`
**Plan:** `docs/plans/001-walking-skeleton.md`

## Summary

A working end-to-end skeleton lands on `main`. `docker compose up --build` produces a single `app` container that serves `GET /health` → `200 ok` and `GET /` → an HTML shell whose React bundle renders the literal text "Docurator". The Observable result holds. Six unit/integration tests pass, the Docker smoke run passes (cached-image restart included), and all six spec acceptance criteria check out. One ADR ships (ADR-001, Vitest as the project test framework). Two structural decisions worth the human's eye: a two-`tsconfig` layout and the choice of `node:20-alpine` as the base image.

## What landed

- **DB tables / columns / migrations:** —
- **API endpoints:** `GET /health` → `200 text/plain "ok"`, plus a `*` static fallback that serves `dist/client/` (`/` returns the Vite-built `index.html`).
- **UI views / components:** `src/client/App.tsx` (renders `<main>Docurator</main>`), `src/client/main.tsx` (mounts inside `<StrictMode>`, throws on missing `#root`), `src/client/index.html` (declares `<title>Docurator</title>` and the `<div id="root"></div>` mount point).
- **Files / modules (new):**
  - `package.json`, `package-lock.json` — runtime + dev deps and scripts (`dev`, `build`, `start`, `test`, `typecheck`).
  - `tsconfig.json` (Bundler resolution, `noEmit: true`, types both trees) and `tsconfig.server.json` (NodeNext, emit to `dist/server`, server only — see "Deviations").
  - `vite.config.ts` (`root: 'src/client'`, `outDir: '../../dist/client'`, `@vitejs/plugin-react`).
  - `vitest.config.ts` (Node env default).
  - `Dockerfile` (multi-stage, `node:20-alpine`).
  - `.dockerignore` (excludes `node_modules`, `dist`, `.git`, runtime volumes, docs).
  - `docker-compose.yml` (single `app` service, `3737:3737`, `host.docker.internal:host-gateway`).
  - `LICENSE` (MIT).
  - `src/server/index.ts` (listener), `src/server/app.ts` (`createApp`), `src/server/config.ts` (`config.port`), `src/server/api/.gitkeep`.
  - Tests: `src/server/config.test.ts`, `src/server/app.test.ts`.
  - Loop artefacts: `docs/research/001-walking-skeleton.md`, `docs/plans/001-walking-skeleton.md`, this review.
  - ADR template populated: `docs/adr/000-adr-template.md`.
  - New ADR: `docs/adr/001-test-framework-vitest.md`.
- **Other:** `.gitignore` was already adequate (covers `node_modules/`, `dist/`, `.env`, `data/`, `invoices/` and more) — left as-is.

## ADRs introduced

- `docs/adr/001-test-framework-vitest.md` — Vitest as the project's test framework (server Node env + client jsdom env when introduced). Rejects Jest, node:test, Mocha+Chai with one-line reasons each.

## Test and smoke results

- **Test suite:** `npx vitest run` — 2 files, 6 tests, all passing, 274 ms (recorded under the plan's `## Test run`).
  - `config.test.ts` × 3: default port `3737`, `APP_PORT` env override, frozen-object shape.
  - `app.test.ts` × 3: `/health` returns `200 ok`, static `/` serves index.html, `/health` wins over the static fallback when both are registered.
- **Smoke:** `docker compose up --build -d` → `curl /health` → `200 ok`, `curl /` → `200 text/html` with `<title>Docurator</title>`. Bundle (`/assets/index-BvVscTzx.js`) is 194,617 bytes and contains the literal `"Docurator"` (the React text node `App` renders). `docker compose down` + `docker compose up -d` (no `--build`) reuses the cached image and answers identically. Server log line: `Docurator listening on http://localhost:3737`. Recorded under the plan's `## Smoke run`.

## Code review notes

**Fixed during this spec:**

- *TS18003 in step 2* — `tsc --showConfig` errors when zero source files match `include`. The plan's empty-source verification was wrong. Step 2's check was switched to a JSON-parse, and tsc-level checks landed in step 3 once the first `.ts` file existed. Documented as a step-2 annotation.
- *Server↔client module-resolution mismatch* — server emit uses NodeNext (requires `.js` import suffixes); Vite's bundler resolution accepts either. Resolved by writing `.js` suffixes consistently across both trees so a single source convention works for the editor (Bundler), the server build (NodeNext), and Vitest (Vite-resolver).
- *Test file naming* — the plan called the integration test `index.test.ts`. Renamed to `app.test.ts` to track the unit under test once `index.ts` (the listener) was added in step 6. Annotated in step 4.
- *`createApp` signature* — the plan made `staticDir` required. Made it optional so step 4 didn't have to fabricate a path; step 5 exercises the populated case. Annotated in step 4.

**Followups for later:**

- No React component test for `App.tsx`. The smoke test's bundle-string check is the sole non-runtime verification of the visible "Docurator" text. The first slice that needs jsdom + react-testing-library (likely 002 with the Dashboard) should establish the pattern; until then, in-browser visual verification is human-only.
- 5 moderate npm-audit findings against vitest's transitive `vite-node` → `vite`. Revisit when vitest 3 (or a v2 patch) updates the chain. Captured in ADR-001's "Audit footprint" line.
- `src/server/index.ts` runs the listener at module-load time. Fine while no test imports it. If that changes, gate on `import.meta.url === pathToFileURL(process.argv[1]).href` and expose a `main()` function.
- No graceful SIGTERM handler. Docker's default 10s SIGKILL window is the implicit shutdown contract. Slice 004 (when SQLite + WAL arrive) may want `server.close()` + DB checkpoint on signal.
- `config.ts` accepts `APP_PORT="foo"` silently (`Number("foo") = NaN`). The architecture's tech-stack pinning of Zod implies a project-wide validation strategy will arrive; the first slice that introduces Zod schemas (likely 002 for OAuth config) is the natural home to retrofit env validation.
- No SPA fallback. `serveStatic` returns 404 for paths with no matching file. If client-side routing arrives, add a fall-through handler that returns `index.html` for non-asset paths.
- `Dockerfile` builder uses explicit `COPY` lines (`tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `src`) rather than `COPY . .` + `.dockerignore`. Tighter context, but new top-level config files (e.g., a real `tailwind.config.js` in Slice 016) need to be added to the `COPY` list explicitly.
- `.dockerignore` excludes `LICENSE` from the build context. Acceptable because the image isn't a redistributable artifact, but if that changes the LICENSE belongs in the runtime stage.
- `tailwindcss` is in `devDependencies` but never imported. The spec mandated this — flag is here only because future readers may wonder why it's installed.

## Decisions worth flagging

- **ADR-001 — Vitest as the project test framework.** The spec didn't pin a runner; architecture was silent. Picked Vitest now because every later slice will want it, and the cost of switching grows. Alternatives (Jest, node:test, Mocha+Chai) were rejected for reasons documented in the ADR. The human could reasonably have preferred Jest if they'd rather not couple test runner to bundler.
- **Two-`tsconfig` layout (`tsconfig.json` + `tsconfig.server.json`).** The spec lists only `tsconfig.json`. The server runs as plain Node ESM, which forces NodeNext resolution and `.js` import suffixes in source; Vite's client build wants Bundler resolution. One config can't cleanly do both as the *emit* configuration. Resolution: `tsconfig.json` is the editor/typecheck config (Bundler, both trees, `noEmit: true`); `tsconfig.server.json` extends it for the server emit only (NodeNext, `dist/server`, excludes test files). Spec's intent ("strict TypeScript config covering both `src/server` and `src/client`") is preserved by `tsconfig.json`.
- **`node:20-alpine` base image.** Smaller, fast pulls, Node 20 LTS. Tradeoff: musl libc rather than glibc, which has bitten projects with native modules in the past. Slice 004 (SQLite via `better-sqlite3`) and Slice 006 (Playwright HTML→PDF) are the natural moments to confirm Alpine still works or flip to `node:20-bookworm-slim` with a fresh ADR. The walking skeleton's pure-JS deps don't exercise the risk.
- **`createApp` made `staticDir` optional.** Lets the unit tests for `/health` skip filesystem fixture setup. The deployed entrypoint always passes `staticDir`, so production behavior is unchanged. A future slice could remove the optionality if all tests adopt a fixture pattern.
- **Smoke verification relies on curl + bundle grep, not a real browser.** This is the strongest agent-feasible substitute for the spec's "see a page that says Docurator" Observable result without adding Puppeteer/Playwright to the dev surface. Honest record in the smoke run; flagged as a followup.

## Deviations from spec or architecture

- **`tsconfig.server.json` added.** Not in the spec's Files / modules list. Rationale above under "Decisions worth flagging".
- **`package.json` includes `test` and `typecheck` scripts.** Spec listed only `dev`, `build`, `start`. Additions, not removals; required by ADR-001 and the loop's TDD quality bar.
- **`devDependencies` include `vitest`, `tsx`, `concurrently`, `@types/node`, `@types/react`, `@types/react-dom`.** The spec's `package.json` bullet listed only the core stack. These additions are downstream consequences of declared scripts — `dev` needs `tsx` + `concurrently`, `test` needs `vitest`, strict TS needs `@types/*` for libraries that don't bundle their own types.
- **`Dockerfile` builder stage uses explicit `COPY`** rather than `COPY . .`. Annotated in step 8 and the followups list.
- **No deviations from `docs/architecture.md`.** Tech-stack choices match § "Tech stack". Project layout is a strict subset of § "Project structure". Compose layout matches § "Docker Compose layout" minus the env/volume entries the spec deferred to later slices.
