import react from '@vitejs/plugin-react'

// Plain array export rather than `defineWorkspace`: vitest 2.1 ships with vite 5
// for its own use, while @vitejs/plugin-react in this project is built against
// vite 6. The runtime is fine (vitest re-resolves plugins), but the helper's
// strict types treat the two `Plugin` shapes as nominally distinct. ADR-001
// flagged a vitest 3 upgrade as the durable fix; until then we type the
// workspace as the simple array shape vitest also accepts.
export default [
  {
    extends: './vitest.config.ts',
    test: {
      name: 'server',
      environment: 'node',
      include: ['src/server/**/*.test.ts', 'scripts/**/*.test.ts'],
      // Server tests rely on module-level singletons (DB connection, OAuth
      // state map, session store). The default `pool: 'threads'` shares
      // module state between test files in the same worker, causing flaky
      // "database connection is not open" failures once the suite grows.
      // `forks` runs each test file in its own subprocess — slower startup,
      // but full isolation.
      pool: 'forks',
    },
  },
  {
    extends: './vitest.config.ts',
    plugins: [react()],
    test: {
      name: 'client',
      environment: 'jsdom',
      include: ['src/client/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/client/test-setup.ts'],
    },
  },
]
