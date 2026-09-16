/**
 * What an engine tail keeps and what it hides, before it becomes a message.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A revert puts the engine's own last lines on the deployment's row, where an
 * operator reads them, and the same text reaches the manager's log and an
 * assertion message on a runner. The file SRS was started on carries the
 * deployment's SRT passphrase and its webhook token, and SRS quotes the line
 * it could not parse, so the values travel with the reason unless they are
 * taken out here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REDACTED, redactEngineOutput } from '../../src/domain/redactEngineOutput.js';

describe('printing what the engine said', () => {
  it('hides an SRT passphrase written the way the template writes it', () => {
    const masked = redactEngineOutput('    passphrase      s3cretpassphrase16;');
    assert.equal(masked.includes('s3cretpassphrase16'), false, masked);
    assert.match(masked, /passphrase/);
    assert.match(masked, new RegExp(REDACTED));
  });

  it('hides a webhook token in the query the template builds', () => {
    const masked = redactEngineOutput(
      'on_publish http://stream-uploader:3000/engines/srs/streams?token=a1b2c3d4e5;',
    );
    assert.equal(masked.includes('a1b2c3d4e5'), false, masked);
    assert.match(masked, /streams\?token=/);
  });

  it('hides the value of every key common calls secret, written as an env line', () => {
    for (const key of ['STREAM_KEY', 'API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN', 'OME_ADMISSION_SECRET', 'SRT_PASSPHRASE']) {
      const masked = redactEngineOutput(`${key}=thevalue`);
      assert.equal(masked, `${key}=${REDACTED}`, key);
    }
  });

  it('keeps the reason the test is about, which names no secret', () => {
    const tail =
      'Failed, code=-1 : chdir to /no/such/directory, r0=-1\n' +
      'do_main() [./src/main/srs_main_server.cpp:150][errno=2](No such file or directory)';
    assert.equal(redactEngineOutput(tail), tail);
  });

  it('leaves an ordinary setting alone, because masking everything says nothing', () => {
    assert.equal(redactEngineOutput('hls_fragment 1.5;'), 'hls_fragment 1.5;');
    assert.equal(redactEngineOutput('HLS_SEGMENT_DURATION=2'), 'HLS_SEGMENT_DURATION=2');
  });
});
