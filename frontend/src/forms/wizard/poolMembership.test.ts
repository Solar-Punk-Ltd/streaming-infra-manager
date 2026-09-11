import assert from 'node:assert/strict';
import { it } from 'node:test';
import { apiFetch } from '../../http';

it('passes no-store and cancellation to native fetch for a fresh membership observation', async t => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_path: unknown, options: RequestInit) => {
    requests.push(options);
    return new Response('{}');
  });
  const signal = new AbortController().signal;
  await apiFetch('/groups', { cache: 'no-store', signal });
  assert.equal(requests[0].cache, 'no-store');
  assert.equal(requests[0].signal, signal);
});
