import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// In dev, /ws and /api are proxied to a local bouncer so the page, the socket and
// the session cookie all share one origin.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
      '/api': { target: 'http://127.0.0.1:8080' },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
