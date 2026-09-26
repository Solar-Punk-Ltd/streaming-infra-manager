/**
 * Test connection's two requests to a web2 admin, against fake admins on
 * loopback.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The probe asks what the stream uploader asks: the internal lookup of a
 * stream nobody declared, with the token, where the admin's own 404 means it
 * took the token and its 401 means it did not, and then the public config for
 * the address the admin signs its catalog with. It answers one outcome code
 * and nothing the far end said. It follows no redirect, reads a bounded body,
 * gives up after its timeout, and sends the token to the lookup alone.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { probeAdminLink } from '../../src/domain/adminLink/adminLinkProbe.js';

const TOKEN = 'synthetic-admin-token-0123456789abcdef';
const OWNER = `0x${'ab'.repeat(20)}`;
const OTHER_OWNER = `0x${'cd'.repeat(20)}`;
const UNUSED_STREAM = '/api/internal/streams/by-ingest/video/00000000-0000-0000-0000-000000000000';

interface Seen {
  path: string;
  authorization: string | undefined;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? '', authorization: request.headers.authorization });
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Answers as the web2 admin's own routes do, for the one token it was started with. */
function adminAnswering(options: { owner?: string | null; configStatus?: number } = {}) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    if (path.startsWith('/api/internal/')) {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { error: 'unauthenticated' });
      if (/^\/api\/internal\/streams\/by-ingest\/(video|audio)\/[0-9a-f-]{36}$/.test(path)) {
        return json(response, 404, { error: 'stream_not_found', id: path.split('/').slice(-2).join('/') });
      }
      return json(response, 404, { error: 'not_found', path });
    }
    if (path === '/api/config') {
      if (options.configStatus) return json(response, options.configStatus, { error: 'internal_error' });
      const feed = options.owner === null ? { topic: 'catalog' } : { owner: options.owner ?? OWNER, topic: 'catalog', topicHex: 'ab' };
      return json(response, 200, { feed, viewerBaseUrl: null });
    }
    return json(response, 404, { error: 'not_found', path });
  };
}

describe('Test connection against a web2 admin', () => {
  it('asks the lookup of a stream nobody declared with the token, and takes its 404 as the token accepted', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(await probeAdminLink({ url: admin.url, token: TOKEN, feedOwner: null }), 'token-accepted');
    assert.deepEqual(admin.seen, [{ path: UNUSED_STREAM, authorization: `Bearer ${TOKEN}` }]);
  });

  it('strips a trailing slash from the address, as the uploader does', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(await probeAdminLink({ url: `${admin.url}/`, token: TOKEN, feedOwner: null }), 'token-accepted');
    assert.equal(admin.seen[0]?.path, UNUSED_STREAM);
  });

  it('reads the owner off the public config without the token, and calls the link whole when it is the stream address', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(await probeAdminLink({ url: admin.url, token: TOKEN, feedOwner: OWNER.toUpperCase().replace('0X', '0x') }), 'linked');
    assert.equal(await probeAdminLink({ url: admin.url, token: TOKEN, feedOwner: OWNER.slice(2) }), 'linked');
    assert.deepEqual(admin.seen[1], { path: '/api/config', authorization: undefined });
  });

  it('says so when the admin signs its catalog with another address, which the uploader refuses to start with', async () => {
    const admin = await serve(adminAnswering({ owner: OTHER_OWNER }));

    assert.equal(await probeAdminLink({ url: admin.url, token: TOKEN, feedOwner: OWNER }), 'owner-mismatch');
  });

  it('says the owner could not be compared when the config names none or does not answer', async () => {
    const silent = await serve(adminAnswering({ owner: null }));
    const failing = await serve(adminAnswering({ configStatus: 500 }));

    assert.equal(await probeAdminLink({ url: silent.url, token: TOKEN, feedOwner: OWNER }), 'owner-unconfirmed');
    assert.equal(await probeAdminLink({ url: failing.url, token: TOKEN, feedOwner: OWNER }), 'owner-unconfirmed');
  });

  it("takes the admin's 401 as a wrong token, and asks nothing more", async () => {
    const admin = await serve(adminAnswering());

    assert.equal(await probeAdminLink({ url: admin.url, token: `${TOKEN}-wrong`, feedOwner: OWNER }), 'token-refused');
    assert.equal(admin.seen.length, 1);
  });

  it('is not fooled by a 404 or a 401 that is not the admin speaking', async () => {
    const prefixed = await serve(adminAnswering());
    const plain = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html>Not Found</html>');
    });
    const gate = await serve((_request, response) => json(response, 401, { message: 'log in first' }));

    assert.equal(await probeAdminLink({ url: `${prefixed.url}/console`, token: TOKEN, feedOwner: null }), 'not-admin');
    assert.equal(await probeAdminLink({ url: plain.url, token: TOKEN, feedOwner: null }), 'not-admin');
    assert.equal(await probeAdminLink({ url: gate.url, token: TOKEN, feedOwner: null }), 'not-admin');
  });

  it('reads any other answer as not a web2 admin, garbage included', async () => {
    const ok = await serve((_request, response) => json(response, 200, { hello: 'world' }));
    const garbage = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error": "stream_not_found"');
    });

    assert.equal(await probeAdminLink({ url: ok.url, token: TOKEN, feedOwner: null }), 'not-admin');
    assert.equal(await probeAdminLink({ url: garbage.url, token: TOKEN, feedOwner: null }), 'not-admin');
  });

  it('refuses a redirect rather than following it, so the token goes nowhere else', async () => {
    const elsewhere = await serve(adminAnswering());
    const redirecting = await serve((_request, response) => {
      response.writeHead(307, { location: `${elsewhere.url}${UNUSED_STREAM}` });
      response.end();
    });

    assert.equal(await probeAdminLink({ url: redirecting.url, token: TOKEN, feedOwner: null }), 'redirected');
    assert.equal(elsewhere.seen.length, 0, 'the redirect target was never asked');
  });

  it('stops reading a body past its bound, and reads such an answer as not a web2 admin', async () => {
    const huge = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'stream_not_found', padding: 'x'.repeat(200_000) }));
    });

    assert.equal(await probeAdminLink({ url: huge.url, token: TOKEN, feedOwner: null }, { maxBodyBytes: 4096 }), 'not-admin');
  });

  it('gives up after its timeout and says the admin is unreachable', async () => {
    const hanging = await serve(() => undefined);
    const started = performance.now();

    assert.equal(await probeAdminLink({ url: hanging.url, token: TOKEN, feedOwner: null }, { timeoutMs: 300 }), 'unreachable');
    assert.ok(performance.now() - started < 3_000, 'the timeout ended the wait');
  });

  it('says the admin is unreachable when nothing listens at the address', async () => {
    const closed = await serve(() => undefined);
    const url = closed.url;
    await cleanups.pop()!();

    assert.equal(await probeAdminLink({ url, token: TOKEN, feedOwner: null }), 'unreachable');
  });

  it('asks nothing of an address that is not http or https', async () => {
    assert.equal(await probeAdminLink({ url: 'ftp://127.0.0.1/', token: TOKEN, feedOwner: null }), 'invalid-address');
    assert.equal(await probeAdminLink({ url: 'not an address', token: TOKEN, feedOwner: null }), 'invalid-address');
  });
});
