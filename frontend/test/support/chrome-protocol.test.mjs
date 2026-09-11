import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolClient } from './chrome.mjs';

class SilentSocket extends EventTarget {
  send() {}
}

test('a Chrome protocol request has a deadline even when the socket stays open', async () => {
  const client = createProtocolClient(new SilentSocket(), 15);
  await assert.rejects(client.call('Runtime.enable'), /timed out/);
});

for (const event of ['close', 'error']) {
  test(`a socket ${event} rejects every pending Chrome request`, async () => {
    const socket = new SilentSocket();
    const client = createProtocolClient(socket, 1000);
    const requests = [client.call('Runtime.enable'), client.call('Page.enable')];
    socket.dispatchEvent(new Event(event));
    const results = await Promise.allSettled(requests);
    assert.ok(results.every((result) => result.status === 'rejected' && /Chrome connection ended/.test(result.reason.message)));
    await assert.rejects(client.call('Page.navigate'), /Chrome connection ended/);
  });
}
