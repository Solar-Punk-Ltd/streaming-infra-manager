import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  managerGuardInvocation,
  readManagerStdinFrame,
} from '../../src/releaseGuard/ReleaseGuardManagerStdin.js';

const TOKEN = 'stdin-sentinel-token-with-quote-"-and-backslash-\\';
const ADMIN_TOKEN = 'admin-sentinel-token-with-quote-"-and-backslash-\\';
const PASSWORD = 'database-sentinel-with-quote-"-and-backslash-\\';
const DIGEST = 'a'.repeat(64);

function input(value: string): Readable {
  return Readable.from([Buffer.from(value)]);
}

describe('manager release stdin route', () => {
  it('routes seven bounded fields into the installed guard process only', async () => {
    const frame = await readManagerStdinFrame(
      input(
        `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0` +
        `http://admin-api:9877\0${ADMIN_TOKEN}\0`,
      ),
    );
    const invocation = managerGuardInvocation('/home/test-guard', '/home/test-guard/.local', frame);

    assert.deepEqual(invocation.argv.slice(1), [
      'manager',
      '--state-root', '/home/test-guard/.local/state/streaming-release-guard',
      '--candidate-root', `/home/test-guard/streaming-infra-manager-releases/manager/${DIGEST}`,
      '--work-root', `/home/test-guard/.local/state/streaming-release-guard/work/manager-${DIGEST}`,
    ]);
    assert.equal(invocation.env.POSTGRES_PASSWORD, PASSWORD);
    assert.equal(invocation.env.SRS_LIFECYCLE_VERSION, '1');
    assert.equal(invocation.env.SRS_MANAGED_UPLOADER_PROFILE, 'primary-srs');
    assert.equal(invocation.env.ADMIN_API_TOKEN, ADMIN_TOKEN);
    assert.equal(invocation.env.ADMIN_API_URL, 'http://admin-api:9877');
    assert.equal(invocation.env.RELEASE_GUARD_ADMIN_TOKEN, TOKEN);
    assert.equal(invocation.env.RELEASE_GUARD_ADMIN_URL, 'http://127.0.0.1:9877');
    assert.equal(invocation.argv.join(' ').includes(TOKEN), false);
    assert.equal(invocation.argv.join(' ').includes(PASSWORD), false);
  });

  it('refuses a caller-selected install root and never inherits unrelated parent values', async () => {
    const frame = await readManagerStdinFrame(
      input(
        `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0` +
        `http://admin-api:9877\0${ADMIN_TOKEN}\0`,
      ),
    );
    assert.throws(
      () => managerGuardInvocation('/home/test-guard', '/tmp/other-guard', frame),
      /installation is invalid/,
    );

    process.env.UNRELATED_SENTINEL = 'must-not-reach-guard';
    try {
      const invocation = managerGuardInvocation('/home/test-guard', '/home/test-guard/.local', frame);
      assert.equal(invocation.env.UNRELATED_SENTINEL, undefined);
    } finally {
      delete process.env.UNRELATED_SENTINEL;
    }
  });

  it('refuses extra, missing, malformed, and oversized frames without echoing fields', async () => {
    for (const value of [
      `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0`,
      `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0http://admin-api:9877\0${ADMIN_TOKEN}\0extra\0`,
      `${TOKEN}\0ftp://receipt.invalid\0${DIGEST}\0${PASSWORD}\0primary-srs\0http://admin-api:9877\0${ADMIN_TOKEN}\0`,
      `${TOKEN}\0http://127.0.0.1:9877\0${'g'.repeat(64)}\0${PASSWORD}\0primary-srs\0http://admin-api:9877\0${ADMIN_TOKEN}\0`,
      `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0../profile\0http://admin-api:9877\0${ADMIN_TOKEN}\0`,
      `${TOKEN}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0ftp://admin.invalid\0${ADMIN_TOKEN}\0`,
      `${'x'.repeat(25 * 1024)}\0http://127.0.0.1:9877\0${DIGEST}\0${PASSWORD}\0primary-srs\0http://admin-api:9877\0${ADMIN_TOKEN}\0`,
    ]) {
      await assert.rejects(
        readManagerStdinFrame(input(value)),
        (error: Error) => {
          assert.doesNotMatch(error.message, /stdin-sentinel|admin-sentinel|database-sentinel|admin-api|receipt\.invalid|admin\.invalid/);
          return true;
        },
      );
    }
  });
});
