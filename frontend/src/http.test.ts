import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { send } from './http';

const globals = globalThis as { fetch: typeof fetch };
const browserFetch = globals.fetch;

afterEach(() => {
  globals.fetch = browserFetch;
});

describe('the deadline a caller puts on a write', () => {
  it('reaches the request, so a run that wedged is not waited on for ever', async () => {
    const deadline = AbortSignal.timeout(60_000);
    let sent: AbortSignal | null | undefined = null;
    globals.fetch = (async (_path: unknown, init?: { signal?: AbortSignal | null }) => {
      sent = init?.signal;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await send('POST', '/profiles/main-stage/stop', {}, deadline);

    assert.equal(sent, deadline);
  });
});
