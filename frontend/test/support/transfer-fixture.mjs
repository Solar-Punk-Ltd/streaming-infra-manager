import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Synthetic API and Vite instances owned by one test. Never attaches to an existing listener. */
export async function launchTransferFixture(t, handler) {
  const evidence = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 't09-http-'));
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  let child;
  let output = '';
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGTERM');
      try { await exited; }
      catch {
        if (child.exitCode === null && child.signalCode === null) {
          const killed = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
          child.kill('SIGKILL');
          await killed;
        }
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await writeFile(join(evidence, 'vite.log'), output);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const managerPort = server.address().port;
  child = fork(fileURLToPath(new URL('./transfer-vite.mjs', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true,
    env: { ...process.env, VITE_MANAGER_URL: `http://127.0.0.1:${managerPort}`, T09_VITE_CACHE: join(evidence, 'vite-cache') },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32_768); });
  const [{ port }] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
    once(child, 'exit').then(() => { throw new Error('The owned Vite fixture exited before startup. Inspect its evidence log.'); }),
  ]);
  if (!Number.isSafeInteger(port) || port < 1) throw new Error('The owned Vite fixture did not return a port');
  t.diagnostic(`Owned synthetic API ${managerPort}, Vite ${port}, evidence ${evidence}`);
  return { origin: `http://127.0.0.1:${port}`, evidence };
}

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
