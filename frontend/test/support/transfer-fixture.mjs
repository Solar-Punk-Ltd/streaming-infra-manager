import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceDirectory = () => mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 't09-http-'));

/** One Vite child on a free port, pointed at whichever manager the caller owns. */
async function startVite(managerUrl, evidence) {
  let output = '';
  const child = fork(fileURLToPath(new URL('./transfer-vite.mjs', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true, execArgv: [],
    env: { ...process.env, VITE_MANAGER_URL: managerUrl, T09_VITE_CACHE: join(evidence, 'vite-cache') },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32_768); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
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
    await writeFile(join(evidence, 'vite.log'), output);
  };
  try {
    const [{ port }] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      once(child, 'exit').then(() => { throw new Error('The owned Vite fixture exited before startup. Inspect its evidence log.'); }),
    ]);
    if (!Number.isSafeInteger(port) || port < 1) throw new Error('The owned Vite fixture did not return a port');
    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Synthetic API and Vite instances owned by one test. Never attaches to an existing listener. */
export async function launchTransferFixture(t, handler) {
  const evidence = await evidenceDirectory();
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  let vite;
  t.after(async () => {
    await vite?.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const managerPort = server.address().port;
  vite = await startVite(`http://127.0.0.1:${managerPort}`, evidence);
  t.diagnostic(`Owned synthetic API ${managerPort}, Vite ${vite.port}, evidence ${evidence}`);
  return { origin: `http://127.0.0.1:${vite.port}`, evidence };
}

/** Vite alone, in front of a manager the caller already owns. */
export async function launchViteFor(t, managerUrl) {
  const evidence = await evidenceDirectory();
  let vite;
  t.after(async () => { await vite?.stop(); });
  vite = await startVite(managerUrl, evidence);
  t.diagnostic(`Owned Vite ${vite.port} in front of ${managerUrl}, evidence ${evidence}`);
  return { origin: `http://127.0.0.1:${vite.port}`, evidence };
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
