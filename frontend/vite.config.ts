import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const MANAGER_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.VITE_MANAGER_URL ?? 'http://localhost:9876';

/**
 * Pass the browser's own Host through, the way nginx does in production with
 * `proxy_set_header Host $host`.
 *
 * Vite's string shorthand would set changeOrigin, which rewrites Host to the
 * manager's address while the browser's Origin still says localhost:5080. The
 * manager reads those two against each other to refuse cross-site writes, so
 * every write from the dev server would be answered with 403.
 */
const managerApi = () => ({ target: MANAGER_URL, changeOrigin: false });

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5080,
    proxy: {
      '/auth': managerApi(),
      '/profiles': managerApi(),
      '/chequebook': managerApi(),
      '/groups': managerApi(),
      '/health': managerApi(),
      '/config': managerApi(),
      '/targets': managerApi(),
      // SSE — disable any buffering / timeouts so events stream live.
      '/events': { ...managerApi(), ws: false, proxyTimeout: 0, timeout: 0 },
      // Metrics: JSON one-shot, SSE stream, and on-demand disk lookups.
      '/metrics': { ...managerApi(), ws: false, proxyTimeout: 0, timeout: 0 },
      // Versions: adding or updating one streams its build for minutes.
      '/versions': { ...managerApi(), ws: false, proxyTimeout: 0, timeout: 0 },
    },
  },
});
