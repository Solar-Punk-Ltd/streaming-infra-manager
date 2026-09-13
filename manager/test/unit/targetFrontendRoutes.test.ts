import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
const { default: vite } = await import(new URL('../../../frontend/vite.config.ts', import.meta.url).href);

/** Every location block that hands the request to the manager. */
function apiLocations(nginx: string): string[] {
  return [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://manager_api;'))
    .map(match => match[1]!.trim());
}

/**
 * Whether one location block takes a path, by the rule its own prefix names:
 * `~` a regex, `=` this path and no other, anything else a prefix. A regex
 * block beats every plain prefix in nginx, so a match here means the SPA
 * fallback does not get the path.
 */
function takes(location: string, path: string): boolean {
  if (location.startsWith('~ ')) return new RegExp(location.slice(2).trim()).test(path);
  if (location.startsWith('= ')) return location.slice(2).trim() === path;
  const prefix = location.replace(/^\^~\s*/, '');
  return path.startsWith(prefix);
}

/**
 * The dev server and the production edge route the same paths, or a page works
 * on a laptop and returns the SPA's own HTML on a host.
 *
 * Found twice now. The Host page's targets were the first. The second, on the
 * live host on 2026-09-11, was the whole transfer history: `/chequebook` was
 * proxied in development and nowhere in nginx, so the page could never read a
 * record and said so honestly, on a manager where the feature simply had no
 * route.
 */
it('routes every path the dev server proxies to the API in production too', () => {
  const config = vite as { server: { proxy: Record<string, unknown> } };
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const locations = apiLocations(nginx);
  const missing = Object.keys(config.server.proxy)
    .filter(prefix => !locations.some(location => takes(location, `${prefix}/probe`)));
  assert.deepEqual(missing, [], 'nginx sends these to the SPA instead of to the manager');
});

it('routes Host target requests to the API in development and production', () => {
  const config = vite as { server: { proxy: Record<string, { target: string }> } };
  assert.ok(config.server.proxy['/targets']?.target, 'Vite must proxy targets instead of returning the SPA');
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const apiBlocks = [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://manager_api;'));
  assert.ok(apiBlocks.some(match => match[1]!.includes('targets')), 'nginx must send targets to the manager');
});

/**
 * A location that inherits nginx's sixty second default is a request the
 * operator watches fail while the manager is still working on it.
 *
 * On the live host on 2026-09-13 creating a deployment took longer than that.
 * The browser was told 504, the wizard then found the deployment that had in
 * fact been created and said the name was taken, and the deployment deployed
 * happily throughout. Stating the number in every block is what stops the next
 * slow route being found the same way.
 */
it('states a read timeout on every location that reaches the manager', () => {
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const inheriting = [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://manager_api;'))
    .filter(match => !/proxy_read_timeout\s+\S+;/.test(match[2]!))
    .map(match => match[1]!.trim());

  assert.deepEqual(inheriting, [], `these take nginx's sixty second default: ${inheriting.join(', ')}`);
});
