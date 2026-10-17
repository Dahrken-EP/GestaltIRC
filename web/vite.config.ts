import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// In dev, /ws is proxied to a local bouncer so the page and socket share an origin.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: { '/ws': { target: 'ws://127.0.0.1:8080', ws: true } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
