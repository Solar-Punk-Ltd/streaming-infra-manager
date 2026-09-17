/**
 * What the dev mock answers about a Bee node's mode and its chain endpoint.
 *
 * A real mock manager over real HTTP, no browser. Runs with the other suites
 * here under `pnpm test:browser`.
 *
 * The mock is what the pages are developed and reviewed against, so a rule the
 * manager enforces and the mock does not is a form that looks finished offline
 * and is refused on a host. These are the T27 rules: a mode and an endpoint
 * source are chosen when the node is created, the mode cannot be changed
 * afterwards, and the refusals are the shared ones word for word.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  STACK_RPC_ENDPOINT_SOURCE,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';
import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';

const bootstrap = `
import { state } from './dev/mock-seed.mjs';
await import('./dev/mock-manager.mjs');
// The seed leaves one blocked deploy attempt behind, and while it is unresolved
// the mock refuses every deploy of a version with shared image tags, which is
// every save here. Released, as an operator would release it from the Versions
// page before editing anything.
state.attempts = [];
process.send({ ready: true });
`;

let child;
let base;
let cookie;

async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie'),
  };
}

/**
 * Waits for a freshly created deployment to finish deploying.
 *
 * Its own deploy attempt is open while it does, and an edit of a busy
 * deployment is refused, here as on a host.
 */
async function running(name) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { body } = await request(`/profiles/${name}`);
    if (body.status === 'RUNNING') return body;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${name} never finished deploying`);
}

/** A create body with everything the mock needs but the node choices. */
function newViewer(name, choices) {
  return {
    name,
    kind: 'viewer',
    host: 'localhost',
    feed_owner: `0x${'1'.repeat(40)}`,
    ...choices,
  };
}

before(async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=development', '--input-type=module', '-e', bootstrap],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Node mode mock did not start')), 8000);
    const onMessage = (message) => { if (message?.ready) finish(); };
    const onExit = () => finish(new Error('Node mode mock exited before startup'));
    const finish = (error) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', finish);
      error ? reject(error) : resolve();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  const login = await request('/auth/login', 'POST', {
    username: DEV_USERNAME,
    password: DEV_PASSWORD,
  });
  assert.equal(login.status, 204);
  cookie = login.cookie.split(';')[0];
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timeout); }
});

describe('the endpoint the offline manager offers', { concurrency: false, timeout: 20000 }, () => {
  it('has one of its own, and names only its host', async () => {
    const { body } = await request('/config');

    assert.equal(body.beeRpcEndpoint.configured, true);
    assert.equal(typeof body.beeRpcEndpoint.host, 'string');
    assert.doesNotMatch(JSON.stringify(body.beeRpcEndpoint), /\/\//);
  });

  it('can be run as a manager that has none, and put back', async () => {
    assert.equal((await request('/config?state=unconfigured')).body.beeRpcEndpoint.configured, false);
    // Sticking is the point: the page reads /config once at boot, so a state
    // that lasted one request could never be seen.
    assert.equal((await request('/config')).body.beeRpcEndpoint.configured, false);
    assert.equal((await request('/config?state=configured')).body.beeRpcEndpoint.configured, true);
  });
});

describe('what the offline manager stores for a new node', { concurrency: false, timeout: 20000 }, () => {
  it('echoes the mode and the source it was created with', async () => {
    const { status, body } = await request(
      '/profiles',
      'POST',
      newViewer('offline-light-gateway', {
        node_mode: LIGHT_NODE_MODE,
        rpc_endpoint_source: MANAGER_RPC_ENDPOINT_SOURCE,
      }),
    );

    assert.equal(status, 202);
    assert.equal(body.node_mode, LIGHT_NODE_MODE);
    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, null);
  });

  /**
   * A body that names no source still means one. An address and nothing else
   * is a custom endpoint, and otherwise the manager's own is what it offers,
   * which is the whole point of having one configured.
   */
  it('reads a create that names no source as the manager own endpoint', async () => {
    const { body } = await request('/profiles', 'POST', newViewer('offline-plain-gateway'));

    assert.equal(body.node_mode, null);
    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
  });

  it('reads it as the stack default on a manager that has none', async () => {
    await request('/config?state=none');
    const { body } = await request('/profiles', 'POST', newViewer('offline-stackbound-gateway'));
    await request('/config?state=configured');

    assert.equal(body.rpc_endpoint_source, STACK_RPC_ENDPOINT_SOURCE);
  });

  it('refuses a custom source with no address, in the shared words', async () => {
    const { status, body } = await request(
      '/profiles',
      'POST',
      newViewer('offline-addressless', {
        node_mode: LIGHT_NODE_MODE,
        rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
      }),
    );

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /a custom RPC endpoint needs an address/);
  });

  it('refuses the stack default for a gateway put on the chain', async () => {
    const { status, body } = await request(
      '/profiles',
      'POST',
      newViewer('offline-chainless-gateway', {
        node_mode: LIGHT_NODE_MODE,
        rpc_endpoint_source: STACK_RPC_ENDPOINT_SOURCE,
      }),
    );

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /a light gateway needs an endpoint/);
  });

  it('refuses an ultra-light node that would have to upload', async () => {
    const { status, body } = await request('/profiles', 'POST', {
      name: 'offline-stranded-uploader',
      kind: 'custom',
      host: 'localhost',
      components: ['bee-uploader'],
      node_mode: ULTRA_LIGHT_NODE_MODE,
    });

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /an ultra-light node cannot upload/);
  });

  it('gives every member of a group the shared choice', async () => {
    const { status, body } = await request('/groups', 'POST', {
      group_name: 'offline-gateways',
      size: 2,
      kind: 'viewer',
      host: 'localhost',
      feed_owner: `0x${'1'.repeat(40)}`,
      node_mode: LIGHT_NODE_MODE,
      rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
      rpc_endpoint: 'http://host.docker.internal:9000',
    });

    assert.equal(status, 202);
    assert.equal(body.profiles.length, 2);
    for (const profile of body.profiles) {
      assert.equal(profile.node_mode, LIGHT_NODE_MODE);
      assert.equal(profile.rpc_endpoint_source, CUSTOM_RPC_ENDPOINT_SOURCE);
      assert.equal(profile.rpc_endpoint, 'http://host.docker.internal:9000');
    }
  });
});

describe('what an edit of that node may change', { concurrency: false, timeout: 20000 }, () => {
  it('takes a new source and drops the address it no longer carries', async () => {
    await request(
      '/profiles',
      'POST',
      newViewer('offline-moving-gateway', {
        node_mode: LIGHT_NODE_MODE,
        rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
        rpc_endpoint: 'http://host.docker.internal:9000',
      }),
    );

    await running('offline-moving-gateway');
    const { status, body } = await request('/profiles/offline-moving-gateway', 'PUT', {
      kind: 'viewer',
      feed_owner: `0x${'1'.repeat(40)}`,
      node_mode: LIGHT_NODE_MODE,
      rpc_endpoint_source: MANAGER_RPC_ENDPOINT_SOURCE,
      rpc_endpoint: null,
    });

    assert.equal(status, 202);
    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, null);
  });

  it('refuses a mode that is not the one the node was created with', async () => {
    await request('/profiles', 'POST', newViewer('offline-fixed-gateway', {
      node_mode: ULTRA_LIGHT_NODE_MODE,
    }));

    await running('offline-fixed-gateway');
    const { status, body } = await request('/profiles/offline-fixed-gateway', 'PUT', {
      kind: 'viewer',
      feed_owner: `0x${'1'.repeat(40)}`,
      node_mode: LIGHT_NODE_MODE,
    });

    // The manager answers a rule that needed the stored row the same way it
    // answers a schema rejection, see errorHandler's ProfileConfigError branch.
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /mode is chosen when it is created/);
  });
});
