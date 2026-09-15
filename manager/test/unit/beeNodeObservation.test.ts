import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { BeeClient, DEFAULT_TIMEOUT_MS } from '../../src/domain/BeeClient.js';
import { MAX_PROBE_TIMEOUT_MS } from '../../src/domain/beeNodeObservation.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

/**
 * A budget the cases that are not about timing cannot reach.
 *
 * These fakes answer over loopback in about a millisecond, so the budget only
 * ever decides anything when the machine is too busy to get to them. At 500 ms
 * the initializing case crossed it on a loaded verification box runner and
 * reported unknown, which is what an unreachable node looks like: a red run
 * about the runner's load rather than about Bee. The two cases that are about
 * the bound pass their own.
 */
const AMPLE_TIMEOUT_MS = 10_000;

async function client(reply: (path: string, res: ServerResponse) => void, timeout = AMPLE_TIMEOUT_MS) {
  const server = createServer((req, res) => reply(req.url!, res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new BeeClient(`http://127.0.0.1:${address.port}`, timeout);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('Bee startup observations', () => {
  it('reports healthy but notReady400 as initializing without inventing progress', async () => {
    const bee = await client((path, res) => {
      if (path === '/health') json(res, { status: 'ok', version: '2.8.2', apiVersion: '8.1.0' });
      else if (path === '/readiness') json(res, { status: 'notReady' }, 400);
      else json(res, {}, 503);
    });
    const observed = await bee.getNodeObservation();
    assert.equal(observed.state, 'initializing');
    assert.equal(observed.readinessStatus, 'notReady');
    assert.equal(observed.chainProgress, null);
    assert.equal(observed.version, '2.8.2');
    assert.ok(Number.isFinite(Date.parse(observed.observedAt)));
  });

  it('requires both health and readiness evidence and keeps supplied block counts', async () => {
    const bee = await client((path, res) => json(res, path === '/chainstate' ? { block: 12, chainTip: 20 } : { status: path === '/health' ? 'ok' : 'ready' }));
    const observed = await bee.getNodeObservation();
    assert.equal(observed.state, 'ready');
    assert.deepEqual(observed.chainProgress, { block: 12, chainTip: 20 });
  });

  it('never turns malformed or unreachable readiness into ready', async () => {
    for (const mode of ['malformed', 'unreachable', 'wrong-status'] as const) {
      const bee = await client((path, res) => {
        if (path === '/health') json(res, { status: 'ok' });
        else if (path === '/readiness' && mode === 'unreachable') res.destroy();
        else if (path === '/readiness') json(res, { status: mode === 'malformed' ? 'unexpected' : 'ready' }, mode === 'wrong-status' ? 400 : 200);
        else json(res, { block: -1, chainTip: '20' });
      });
      const observed = await bee.getNodeObservation();
      assert.equal(observed.state, 'unknown');
      assert.equal(observed.chainProgress, null);
    }
  });

  it('distinguishes Bee reported unhealthy from unreachable', async () => {
    const unhealthy = await client((path, res) => json(res, { status: path === '/health' ? 'nok' : 'notReady' }, path === '/readiness' ? 400 : 200));
    assert.equal((await unhealthy.getNodeObservation()).state, 'unhealthy');
    const unreachable = await client((_path, res) => res.destroy());
    assert.equal((await unreachable.getNodeObservation()).state, 'unreachable');
  });

  it('bounds slow bodies and oversized responses without exposing them', async () => {
    const slow = await client((_path, res) => { res.writeHead(200); res.write('{'); }, 50);
    const start = Date.now();
    const observed = await slow.getNodeObservation();
    assert.notEqual(observed.state, 'ready');
    assert.ok(Date.now() - start < 1000);
    const large = await client((_path, res) => res.end('x'.repeat(70000)));
    assert.equal((await large.getNodeObservation()).state, 'unknown');
  });

  // On the CI runner a body read outlived the probe's abort by five minutes,
  // until the server's own request timeout closed the socket: the transport
  // did not turn the abort into a rejected read. The bound has to be the
  // probe's, whatever the transport does with the signal.
  it('bounds a body read even when the transport ignores the abort signal', { timeout: 5_000 }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { /* the transport that never gives up */ },
    }), { status: 200 });
    try {
      const start = Date.now();
      const observed = await new BeeClient('http://127.0.0.1:1', 50).getNodeObservation();
      assert.notEqual(observed.state, 'ready');
      assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The cap used to sit at 3 s while every caller asked for 10 s, so a node
  // that took four seconds to answer was reported as not ready and this file's
  // own AMPLE_TIMEOUT_MS was quietly a third of what it says. A cap is a
  // backstop against an absurd caller, never a policy that overrules one.
  it('never shortens the budget its callers ask for', () => {
    assert.ok(
      MAX_PROBE_TIMEOUT_MS >= DEFAULT_TIMEOUT_MS,
      `a cap of ${MAX_PROBE_TIMEOUT_MS}ms silently shortens the ${DEFAULT_TIMEOUT_MS}ms every BeeClient asks for`,
    );
    assert.ok(MAX_PROBE_TIMEOUT_MS >= AMPLE_TIMEOUT_MS, String(MAX_PROBE_TIMEOUT_MS));
  });

  it('waits out a node slower than the old cap when its caller allowed for it', { timeout: 20_000 }, async () => {
    const slow = await client((path, res) => {
      const body = path === '/readiness'
        ? JSON.stringify({ status: 'ready' })
        : JSON.stringify({ status: 'ok', version: '2.8.2', apiVersion: '8.1.1' });
      setTimeout(() => res.end(body), 4_000);
    });

    assert.equal((await slow.getNodeObservation()).state, 'ready');
  });
});
