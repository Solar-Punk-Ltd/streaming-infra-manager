/**
 * That nginx hands the manager the two request facts it decides on.
 *
 * Both are invisible from inside the manager: it can only read what arrives.
 * `$host` drops the port, so a browser on `localhost:8080` reached the API as
 * `localhost` while its Origin still said `localhost:8080`, and the same-site
 * check refused every write including the sign-in itself. `$scheme` is whatever
 * nginx itself listens on, which is plain http, so overwriting X-Forwarded-Proto
 * with it told the manager the browser was not on HTTPS even behind the TLS
 * edge. Read from the file, as `serverGateOrder.test.ts` reads server.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = join(here, '..', '..', '..', 'frontend', 'nginx.conf');

function proxyLines(prefix: string): string[] {
  return readFileSync(NGINX_CONF, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
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
