import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: 'default',
    // The first test in each server file pays a one-time module-import cost
    // (better-sqlite3 native init, hono, googleapis types). Under full-suite
    // parallelism the default 5s ceiling sometimes clips. 15s is generous
    // enough that real assertion failures still surface promptly.
    testTimeout: 15000,
  },
})
