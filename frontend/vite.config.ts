import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const MANAGER_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.VITE_MANAGER_URL ?? 'http://localhost:9876';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/profiles': MANAGER_URL,
      '/healthz': MANAGER_URL,
    },
  },
});
