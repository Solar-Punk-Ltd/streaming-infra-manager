import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const MANAGER_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.VITE_MANAGER_URL ?? 'http://localhost:9876';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5080,
    proxy: {
      '/profiles': MANAGER_URL,
      '/groups': MANAGER_URL,
      '/health': MANAGER_URL,
      // SSE — disable any buffering / timeouts so events stream live.
      '/events': {
        target: MANAGER_URL,
        changeOrigin: true,
        ws: false,
        proxyTimeout: 0,
        timeout: 0,
      },
    },
  },
});
