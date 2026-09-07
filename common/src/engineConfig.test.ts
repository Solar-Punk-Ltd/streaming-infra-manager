/**
 * The placeholder rules a config file of the deployment's own lives by.
 *
 * The editor warns on them live, the manager refuses on them, and the
 * settings drawer says which of its fields a file stopped reading. All three
 * read these, so what a placeholder is has one definition.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import {
  placeholdersIn,
  settingsNotInConfig,
  unknownPlaceholders,
} from './engineConfig.js';

const SRS_FILE =
  'listen 1935;\nsrt_server {\n    passphrase PASSPHRASE_PLACEHOLDER;\n}\nvhost __defaultVhost__ {\n    hls {\n        hls_fragment HLS_FRAGMENT_PLACEHOLDER;\n    }\nTRANSCODE_PLACEHOLDER\n}\n';

describe('placeholdersIn', () => {
  it('finds every token once, in order of first appearance', () => {
    assert.deepEqual(placeholdersIn(SRS_FILE), [
      'PASSPHRASE_PLACEHOLDER',
      'HLS_FRAGMENT_PLACEHOLDER',
      'TRANSCODE_PLACEHOLDER',
    ]);
  });

  it('ignores lower case and a bare PLACEHOLDER word', () => {
    assert.deepEqual(placeholdersIn('x placeholder; y PLACEHOLDER; z a_PLACEHOLDER'), []);
  });
});

describe('unknownPlaceholders', () => {
  it('names the tokens the version does not fill', () => {
    assert.deepEqual(
      unknownPlaceholders(SRS_FILE, ['PASSPHRASE_PLACEHOLDER', 'HLS_FRAGMENT_PLACEHOLDER']),
      ['TRANSCODE_PLACEHOLDER'],
    );
  });

  it('is empty for a file that only uses what is filled', () => {
    assert.deepEqual(unknownPlaceholders('listen 1935;', []), []);
  });
});

describe('settingsNotInConfig', () => {
  it('names the SRS settings whose token the file dropped', () => {
    assert.deepEqual(settingsNotInConfig(SRS_SERVICE, SRS_FILE), ['HLS_WINDOW']);
  });

  it('names every ABR setting when the transcode line is gone', () => {
    const noLadder = SRS_FILE.replace('TRANSCODE_PLACEHOLDER\n', '');
    const missing = settingsNotInConfig(SRS_SERVICE, noLadder);
    assert.ok(missing.includes('ABR_FPS'));
    assert.ok(missing.includes('HLS_WINDOW'));
    assert.equal(missing.includes('HLS_FRAGMENT'), false);
  });

  it('never names a setting the config does not carry, like the poll interval', () => {
    const missing = settingsNotInConfig(OME_SERVICE, '<Server/>');
    assert.deepEqual(missing, ['HLS_SEGMENT_DURATION', 'HLS_SEGMENT_COUNT']);
  });
});
