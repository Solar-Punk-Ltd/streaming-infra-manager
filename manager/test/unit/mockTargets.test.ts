import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createTargetRoutes } from '../../../frontend/dev/mock-targets.mjs';

it('lets the offline Host page recover inventory and display a failed target verification', async () => {
  const routes = createTargetRoutes(async (req: { body?: object }) => req.body ?? {});
  async function request(method: string, path: string, body?: object) {
    let status = 0;
    let payload = '';
    const route = routes.find(([verb, pattern]: [string, RegExp]) => verb === method && pattern.test(path));
    assert.ok(route, `${method} ${path} must be available offline`);
    await route[2]({ body }, { writeHead: (value: number) => { status = value; }, end: (value: string) => { payload = value; } });
    return { status, body: JSON.parse(payload) };
  }
  assert.equal((await request('GET', '/targets')).body.inventorySeededAt, null);
  assert.equal((await request('POST', '/targets/inventory')).status, 200);
  assert.ok((await request('GET', '/targets')).body.inventorySeededAt);
  assert.equal((await request('POST', '/targets/verify', { alias: 'edge' })).status, 200);
  assert.equal((await request('POST', '/targets/verify', { alias: 'unreachable' })).status, 409);
  const targets = (await request('GET', '/targets')).body.targets;
  assert.ok(targets.find((target: { alias: string }) => target.alias === 'edge').inventorySeededAt);
  assert.match(targets.find((target: { alias: string }) => target.alias === 'unreachable').lastError, /unreachable/i);
});
