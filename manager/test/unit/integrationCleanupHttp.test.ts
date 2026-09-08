import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, it } from 'node:test';

const helpers = new URL('../integration/helpers.ts', import.meta.url).href;
let server: http.Server;
let url: string;
let invalidCreation: boolean;
let groupResponseCount: number;
let calls: { method: string; path: string; body: Record<string, unknown>; writeHeader: string | string[] | undefined }[];
let profiles: Map<string, { name: string; instance_id: string; status: string }>;
beforeEach(async () => {
  invalidCreation = false;
  groupResponseCount = 2;
  calls = [];
  profiles = new Map();
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url!;
    calls.push({ method: req.method!, path, body, writeHeader: req.headers['x-requested-with'] });
    const answer = (status: number, result?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(result === undefined ? '' : JSON.stringify(result)); };
    const insert = (name: string) => {
      const profile = { name, instance_id: randomUUID(), status: 'DEPLOYING' };
      profiles.set(name, profile);
      return profile;
    };
    if (req.method === 'POST' && path === '/profiles') return answer(202, invalidCreation ? {} : insert(body.name));
    if (req.method === 'POST' && path === '/groups') return answer(202, { group: { id: 7, name: body.group_name }, profiles: [insert(`${body.group_name}-profile-2`), ...(groupResponseCount === 2 ? [insert(`${body.group_name}-profile-8`)] : [])] });
    if (req.method === 'POST' && path === '/groups/9/members') return answer(202, { group: { id: 9, name: 'itest-run-existing' }, profiles: [insert('itest-run-existing-profile-6')] });
    if (path.startsWith('/profiles/')) {
      const name = decodeURIComponent(path.slice('/profiles/'.length));
      const profile = profiles.get(name);
      if (!profile) return answer(404, { error: 'profile_not_found', name });
      if (req.method === 'DELETE') {
        if (body.expectedInstanceId !== profile.instance_id) return answer(409, { error: 'profile_instance_changed', name });
        profiles.delete(name);
        return answer(202, { ...profile, status: 'REMOVING' });
      }
      return answer(200, profile);
    }
    if (req.method === 'DELETE' && path === '/groups/7') return answer(204);
    if (req.method === 'GET' && path === '/groups') return answer(200, { groups: [] });
    return answer(404, { error: 'route_not_found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

function run(script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', '--input-type=module', '--eval', script], {
      cwd: new URL('../..', import.meta.url), env: { PATH: process.env.PATH, MANAGER_URL: url, MANAGER_TEST_RUN: 'run' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic integration client did not finish')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

it('actual helpers capture typed and raw creations and use only their identities in cleanup', async () => {
  const result = await run(`
    const h = await import(${JSON.stringify(helpers)});
    await h.createProfile({ name: 'itest-run-alone', kind: 'viewer' });
    await h.createGroup({ group_name: 'itest-run-owned', kind: 'viewer', size: 2 });
    await h.apiRaw('POST', '/groups/9/members', { count: 1 });
    await h.removeProfile('itest-run-alone');
    await h.cleanup();
  `);
  assert.equal(result.code, 0, result.output);
  const deleting = calls.filter(call => call.method === 'DELETE');
  assert.ok(deleting.filter(call => call.path.startsWith('/profiles/')).every(call => typeof call.body.expectedInstanceId === 'string'));
  assert.ok(deleting.every(call => call.writeHeader === 'streaming-infra-manager'));
  assert.equal(profiles.size, 0);
  assert.deepEqual(deleting.filter(call => call.path.startsWith('/groups/')).map(call => [call.path, call.body]), [['/groups/7', { expectedName: 'itest-run-owned' }]]);
  assert.equal(calls.some(call => call.method === 'GET' && call.path === '/profiles'), false);
});

it('the Node test runner reports the original assertion and unresolved cleanup separately', async () => {
  invalidCreation = true;
  const result = await run(`
    import { test, after } from 'node:test';
    import assert from 'node:assert/strict';
    const h = await import(${JSON.stringify(helpers)});
    after(() => h.cleanup());
    test('original assertion survives', async () => {
      await h.createProfile({ name: 'itest-run-maybe', kind: 'viewer' });
      assert.fail('original assertion marker');
    });
  `);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /original assertion marker/);
  assert.match(result.output, /Integration cleanup incomplete/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

for (const returned of [1, 2]) {
  it(`uses the sent raw JSON to assess creation coverage with ${returned} returned members`, async () => {
    groupResponseCount = returned;
    const result = await run(`
      const h = await import(${JSON.stringify(helpers)});
      await h.requestWith('POST', '/groups', { size: 1 }, { rawBody: JSON.stringify({ group_name: 'itest-run-raw', kind: 'viewer', size: 2 }) });
      await h.cleanup();
    `);
    if (returned === 2) assert.equal(result.code, 0, result.output);
    else {
      assert.notEqual(result.code, 0);
      assert.match(result.output, /member-count-mismatch/);
    }
    assert.equal(profiles.size, 0);
    assert.equal(calls.find(call => call.method === 'POST')?.body.size, 2);
  });
}

it('serializes a toJSON body once and records that exact request coverage', async () => {
  const result = await run(`
    const h = await import(${JSON.stringify(helpers)});
    let serializations = 0;
    await h.api('POST', '/groups', { size: 1, toJSON() { serializations++; return { group_name: 'itest-run-json', kind: 'viewer', size: 2 }; } });
    if (serializations !== 1) throw new Error('Body serialized more than once');
    await h.cleanup();
  `);
  assert.equal(result.code, 0, result.output);
  assert.equal(profiles.size, 0);
});
