# ADR-001: Vitest as the project test framework

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/001-walking-skeleton.md`

## Context

Slice 001 (walking skeleton) is the first slice that writes production code, and the spec implementation loop's quality bar mandates TDD where applicable. The repo has no test framework yet. Every later slice will write tests — server-side route handlers, classification pipeline pieces, repository methods, React views — so this slice fixes a project-wide testing standard.

`docs/architecture.md` § "Tech stack" pins TypeScript, Node.js, Hono, React + Vite, Tailwind + shadcn/ui, but is silent on testing. The choice is open and load-bearing for every later slice, which is exactly the bar for an ADR per the spec implementation loop's "When to write an ADR" criteria.

## Decision

Use **Vitest** as the single test framework for both server (Node env) and client (jsdom env, when introduced) test suites. One `vitest.config.ts` at the repo root covers both, picked up by the `test` npm script. Test files live alongside source as `*.test.ts` / `*.test.tsx`. Server tests run under Vitest's default Node environment; client tests opt into jsdom per-file or per-project starting in the slice that introduces them.

## Consequences

- One runner, one config, one assertion API across server and client. Lower cognitive load when jumping between the two sides.
- Vite is already a tech-stack choice (`docs/architecture.md` § "Tech stack"), so Vitest reuses Vite's transformer and resolver for free, including TypeScript and bundler-style import resolution. No separate transpile config (no ts-jest, no babel-jest).
- ESM-first: matches the project's `"type": "module"` and the server's NodeNext import style. Source written with `.js` import suffixes resolves to `.ts` files via Vite's resolver, so the same source compiles to runnable Node ESM under `tsc -p tsconfig.server.json`.
- jsdom is a one-line opt-in (`environment: 'jsdom'`) when React tests arrive. No replumbing.
- Constraint imposed on later specs: tests are colocated as `*.test.ts(x)`; `*.test.ts` is excluded from the server emit (`tsconfig.server.json`). Slices that introduce DOM tests opt their files into jsdom rather than flipping the global default.
- Tradeoff: vs. node:test we accept a heavier dev-dependency surface in exchange for jsdom support, snapshot testing, and richer mocking primitives. vs. Jest we avoid babel/ts-jest, get faster startup, and stay aligned with Vite.
- Audit footprint: vitest 2.1's transitive `vite-node` dependency surfaces 5 moderate npm-audit findings against `vite`. Acceptable for a local-only dev tool; revisit when vitest 3 lands and the transitive chain updates.

## Alternatives considered

- **Jest** — industry standard, but requires `babel-jest` or `ts-jest` to transform TypeScript, has slower cold starts than Vite-based runners, and needs separate jsdom plumbing. The project already runs Vite for the client; adding a parallel transformer is duplication for no functional gain.
- **node:test (built-in)** — zero deps, fast, no install footprint. But no jsdom support out of the box, weaker mocking primitives, and module-resolution interactions with NodeNext/`.js` import suffixes are awkward. Slices 002+ need DOM testing, and bolting it on later is more work than choosing Vitest now.
- **Mocha + Chai + ts-node** — composable but each piece is hand-wired for TypeScript and ESM. Strictly more setup than Vitest with no upside the project would benefit from.

## Supersession

—
