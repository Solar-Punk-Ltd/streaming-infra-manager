/**
 * The deployment actions answer with a stream, and the proxy in front has to
 * know that.
 *
 * Every route in the actions router pipes a run handle to Server-Sent Events,
 * so the response lives as long as the deploy does and arrives a line at a
 * time. Behind a buffering proxy that is two faults at once: nothing reaches
 * the browser until the run ends, so the drawer sits there saying nothing, and
 * the proxy gives up on a gap between lines, so the browser is told 504 while
 * the manager goes on and finishes the work. Levi hit the second one starting
 * an uploader on 2026-09-15.
 *
 * nginx takes the FIRST regex location that matches, so covering these routes
 * means a block above the generic JSON one rather than a wider timeout on it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = join(here, '..', '..', '..', 'frontend', 'nginx.conf');
const ACTIONS_ROUTER = join(here, '..', '..', 'src', 'api', 'routes', 'actions.ts');

const JSON_API_LOCATION = 'location ~ ^/(auth|';
const STREAM_LOCATION = 'location ~ ^/profiles/';

/** The action paths the router serves, read from the router rather than copied. */
function actionPaths(): string[] {
  const source = readFileSync(ACTIONS_ROUTER, 'utf8');
  return [...source.matchAll(/'\/profiles\/:name\/([a-z-]+)'/g)].map((match) => match[1]!);
}

/** The body of the first location block whose header starts with `prefix`. */
function blockStartingWith(prefix: string): { body: string; at: number } | null {
  const conf = readFileSync(NGINX_CONF, 'utf8');
  const at = conf.indexOf(prefix);
  if (at === -1) return null;
  const end = conf.indexOf('\n    }', at);
  return end === -1 ? null : { body: conf.slice(at, end), at };
}

describe('the proxy in front of the deployment actions', () => {
  it('serves every action the router has, so a new one cannot be left behind', () => {
    const block = blockStartingWith(STREAM_LOCATION);
    assert.ok(block, 'nginx.conf has no location for the streaming action routes');

    const paths = actionPaths();
    assert.ok(paths.length >= 4, `only found ${paths.length} action paths in the router`);
    for (const path of paths) {
      assert.ok(
        block.body.includes(path),
        `nginx.conf does not route /profiles/<name>/${path}, which answers with a stream`,
      );
    }
  });

  it('does not buffer them, so the drawer shows the run while it runs', () => {
    const block = blockStartingWith(STREAM_LOCATION);

    assert.match(block?.body ?? '', /proxy_buffering\s+off;/);
    assert.match(block?.body ?? '', /chunked_transfer_encoding\s+off;/);
  });

  it('does not give up on a gap between lines, which is what answered 504', () => {
    const block = blockStartingWith(STREAM_LOCATION);

    assert.match(block?.body ?? '', /proxy_read_timeout\s+24h;/);
    assert.match(block?.body ?? '', /proxy_send_timeout\s+24h;/);
  });

  it('is above the JSON routes, because nginx takes the first regex that matches', () => {
    const stream = blockStartingWith(STREAM_LOCATION);
    const json = blockStartingWith(JSON_API_LOCATION);

    assert.ok(stream && json);
    assert.ok(
      stream.at < json.at,
      'the JSON location matches /profiles first, so the stream block never runs',
    );
  });
});
