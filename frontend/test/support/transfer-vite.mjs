import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({ root, cacheDir: process.env.T09_VITE_CACHE,
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
process.send({ port: server.httpServer.address().port, cache: server.config.cacheDir });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  process.disconnect();
}
process.on('SIGTERM', close);
process.on('disconnect', close);
