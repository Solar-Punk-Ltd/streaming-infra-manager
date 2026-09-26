import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
const { default: vite } = await import(new URL('../../../frontend/vite.config.ts', import.meta.url).href);

/** Every location block that hands the request to the manager. */
function apiLocations(nginx: string): string[] {
  return [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://$manager_api;'))
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
 * A URL the dev server would hand to the manager under this key.
 *
 * A prefix key names one outright. A regex key is sampled instead: the anchors
 * come off, a segment class stands for one segment, and a group gives up its
 * first alternative. One URL is all the case needs, the same as for a prefix.
 */
function probeFor(key: string): string {
  if (!key.startsWith('^')) return `${key}/probe`;
  return key
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[\^\/\]\+/g, 'probe')
    .replace(/\((?:\?:)?([^)]*)\)/g, (_whole, group: string) => group.split('|')[0]!);
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
    .filter(key => !locations.some(location => takes(location, probeFor(key))));
  assert.deepEqual(missing, [], 'nginx sends these to the SPA instead of to the manager');
});

it('routes Host target requests to the API in development and production', () => {
  const config = vite as { server: { proxy: Record<string, { target: string }> } };
  assert.ok(config.server.proxy['/targets']?.target, 'Vite must proxy targets instead of returning the SPA');
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const apiBlocks = [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://$manager_api;'));
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
    .filter(match => match[2]!.includes('proxy_pass http://$manager_api;'))
    .filter(match => !/proxy_read_timeout\s+\S+;/.test(match[2]!))
    .map(match => match[1]!.trim());

  assert.deepEqual(inheriting, [], `these take nginx's sixty second default: ${inheriting.join(', ')}`);
});

/**
 * nginx resolves a plain upstream name once, when it starts, and holds that
 * address for the life of the process. A deploy that rebuilds only the manager
 * recreates the api container and leaves the web container running, so the
 * address nginx holds belongs to a container that is gone and every API call
 * is a 502 while the manager itself is healthy. That is how the live host read
 * on 2026-09-14: the sign-in page loaded and said the manager did not answer.
 *
 * Naming the host in a variable makes nginx ask again, which is the whole fix,
 * and it only works when a resolver is there to ask.
 */
it('reaches the manager by a name it resolves again, so a recreated api is found', () => {
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  assert.match(nginx, /^\s*resolver\s+\S+/m, 'without a resolver nginx cannot look the api up at all');
  assert.match(nginx, /^\s*set\s+\$manager_api\s/m, 'the api host belongs in a variable, so nginx resolves it per request');
  const fixed = [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => /proxy_pass\s+http:\/\/(?!\$)/.test(match[2]!))
    .map(match => match[1]!.trim());
  assert.deepEqual(fixed, [], `these hold one address for the life of nginx: ${fixed.join(', ')}`);
});

/**
 * The Manager settings page reads and saves the web2 admin link under a path
 * of its own, and tests it there too, so both proxies have to send that path
 * to the manager. Missed in either, the page reads the SPA's own HTML and says
 * it could not read the link, on a laptop or on a host.
 */
it('routes the Manager settings requests to the API in development and production', () => {
  const config = vite as { server: { proxy: Record<string, unknown> } };
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const locations = apiLocations(nginx);
  for (const path of ['/manager-settings/admin-link', '/manager-settings/admin-link/test']) {
    assert.ok(Object.keys(config.server.proxy).some(key => !key.startsWith('^') && path.startsWith(key)), `Vite proxies nothing for ${path}`);
    assert.ok(locations.some(location => takes(location, path)), `nginx sends ${path} to the SPA instead of to the manager`);
  }
});
