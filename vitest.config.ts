import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: 'default',
    // The first test in each server file pays a one-time module-import cost
    // (better-sqlite3 native init, hono, googleapis types — and after Slice 006
    // also the Playwright resolution chain, which bloats node_modules). Under
    // full-suite parallelism the default 5s ceiling sometimes clips. Slice 004
    // raised this from 5s to 15s; Slice 006 bumps to 30s after Playwright
    // landed and pushed first-test wall time on a couple of files past 15s.
    // Real assertion failures still surface promptly.
    testTimeout: 30000,
    // beforeEach hooks in test files that `vi.resetModules()` and re-import
    // the orchestrator pay the full transitive-import cost on every test
    // (orchestrator → classify → render-html-pdf → playwright). Under
    // full-suite parallelism a hot fork can stall past the default 10s hook
    // timeout, leaving DB state half-initialised and cascading into the next
    // test's beforeEach. Match the test timeout — same justification.
    hookTimeout: 30000,
  },
})
