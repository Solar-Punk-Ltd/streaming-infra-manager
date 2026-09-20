import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { streamAdminConsoleUrl } from '../../src/utils/config.js';

describe('STREAM_ADMIN_CONSOLE_URL', () => {
  it('accepts only a public HTTP base URL', () => {
    assert.equal(streamAdminConsoleUrl('https://admin.example.test/console/'), 'https://admin.example.test/console');
    for (const value of ['ftp://admin.example.test', 'https://user:pass@admin.example.test', 'https://admin.example.test/?key=secret', 'https://admin.example.test/#/streams/x']) {
      assert.throws(() => streamAdminConsoleUrl(value));
    }
  });

  it('leaves an omitted link unconfigured', () => assert.equal(streamAdminConsoleUrl(undefined), null));
});
