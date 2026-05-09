import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.APP_PORT ?? '3737'
  const apiTarget = `http://localhost:${apiPort}`
  return {
    root: 'src/client',
    plugins: [react()],
    server: {
      proxy: {
        // Anchored regex so e.g. `/api.ts` (a real client source file) is
        // served by Vite, while `/api/...` and `/oauth/...` go to Hono.
        '^/api/': { target: apiTarget, changeOrigin: true },
        '^/oauth/': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
    },
  }
})
