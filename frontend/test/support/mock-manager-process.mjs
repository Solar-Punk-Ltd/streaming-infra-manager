import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../../', import.meta.url));

/** A port nothing on this machine listens on right now. */
export async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/**
 * The dev mock manager on a port of its own, with the seeded blocked attempt
 * released so a create deploys, stopped when the test ends. Answers the
 * address a Vite server proxies to through `VITE_MANAGER_URL`.
 */
export async function startMockManager(t) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx', '--conditions=development', '--input-type=module',
      '-e', "import { state } from './dev/mock-seed.mjs'; await import('./dev/mock-manager.mjs'); state.attempts = []; process.send({ ready: true });",
    ],
    { cwd: frontend, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const bound = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(bound); }
  });
  await new Promise((done, fail) => {
    const bound = setTimeout(() => finish(new Error('the mock manager did not start')), 20_000);
    const onMessage = (message) => { if (message?.ready) finish(); };
    const onExit = () => finish(new Error('the mock manager exited before it was ready'));
    const finish = (error) => {
      clearTimeout(bound);
      child.off('message', onMessage);
      child.off('exit', onExit);
      error ? fail(error) : done();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  return `http://127.0.0.1:${port}`;
}
