/**
 * That nginx hands the manager the request facts it decides on, and stops a
 * sign-in flood before the manager pays for it.
 *
 * The facts are invisible from inside the manager: it can only read what
 * arrives. `$host` drops the port, so a browser on `localhost:8080` reached the
 * API as `localhost` while its Origin still said `localhost:8080`, and the
 * same-site check refused every write including the sign-in itself. `$scheme`
 * is whatever nginx itself listens on, which is plain http, so overwriting
 * X-Forwarded-Proto with it told the manager the browser was not on HTTPS even
 * behind the TLS edge. And with the edge in front but real_ip left out, every
 * request's last X-Forwarded-For hop is the edge's own container address, which
 * is the address the login lockout would then hold responsible for everybody.
 * Read from the file, as `serverGateOrder.test.ts` reads server.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = join(here, '..', '..', '..', 'frontend', 'nginx.conf');

/** The ranges Docker draws a compose network's subnet from. */
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

const SIGN_IN_LOCATION = 'location = /auth/login {';
const JSON_API_LOCATION = 'location ~ ^/(auth|';

function confLines(): string[] {
  return readFileSync(NGINX_CONF, 'utf8')
    .split('\n')
    .map((line) => line.trim());
}

function proxyLines(prefix: string): string[] {
  return confLines().filter((line) => line.startsWith(prefix));
}

describe('nginx.conf proxy headers', () => {
  it('forwards the Host header with its port', () => {
    const hosts = proxyLines('proxy_set_header Host');

    assert.ok(hosts.length > 0, 'no proxy_set_header Host line found');
    for (const line of hosts) {
      assert.equal(
        line,
        'proxy_set_header Host $http_host;',
        '$host drops the port, which the manager compares Origin against',
      );
    }
  });

  it('forwards the edge protocol rather than its own', () => {
    const protos = proxyLines('proxy_set_header X-Forwarded-Proto');

    assert.ok(protos.length > 0, 'no X-Forwarded-Proto line found');
    for (const line of protos) {
      assert.equal(
        line,
        'proxy_set_header X-Forwarded-Proto $forwarded_proto;',
        '$scheme is always http here, so it would hide the edge HTTPS',
      );
    }
  });
});

describe('nginx.conf client address', () => {
  it('trusts the ranges the edge can reach it from', () => {
    assert.deepEqual(
      proxyLines('set_real_ip_from'),
      PRIVATE_RANGES.map((range) => `set_real_ip_from ${range};`),
      'the edge sits on the compose network, whose subnet Docker picks here',
    );
  });

  it('reads the client address out of X-Forwarded-For', () => {
    assert.deepEqual(proxyLines('real_ip_header'), [
      'real_ip_header X-Forwarded-For;',
    ]);
  });

  it('walks back past every address it trusts', () => {
    assert.deepEqual(
      proxyLines('real_ip_recursive'),
      ['real_ip_recursive on;'],
      'off stops at the last address in the chain, trusted or not',
    );
  });
});

describe('nginx.conf sign-in rate limit', () => {
  it('keeps a zone keyed by client address', () => {
    assert.deepEqual(
      proxyLines('limit_req_zone'),
      ['limit_req_zone $binary_remote_addr zone=login:1m rate=10r/m;'],
      'one scrypt per attempt is what this zone is protecting',
    );
  });

  it('limits the sign-in and nothing else', () => {
    const lines = confLines();
    const signIn = lines.indexOf(SIGN_IN_LOCATION);
    const jsonApi = lines.findIndex((line) =>
      line.startsWith(JSON_API_LOCATION),
    );

    assert.notEqual(signIn, -1, `no "${SIGN_IN_LOCATION}" in nginx.conf`);
    assert.notEqual(jsonApi, -1, `no "${JSON_API_LOCATION}" in nginx.conf`);
    assert.ok(
      signIn < jsonApi,
      'the exact sign-in match belongs above the regex that also matches /auth',
    );
    assert.deepEqual(proxyLines('limit_req zone='), [
      'limit_req zone=login burst=5 nodelay;',
    ]);
  });

  it('says the caller was too fast rather than that the manager is down', () => {
    assert.deepEqual(
      proxyLines('limit_req_status'),
      ['limit_req_status 429;'],
      'nginx answers 503 by default, which reads as an outage',
    );
  });
});
