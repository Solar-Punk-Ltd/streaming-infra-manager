/**
 * What a settings save is allowed to say about itself in the log.
 *
 * Unit test, nothing on disk. `pnpm test` in manager/.
 *
 * These files hold the tokens and the passphrases of every deployment on the
 * version, and the manager's log is read, shipped and kept. So a save names
 * the file and the keys it touched, and no path anywhere may carry the value.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeSettingsSave } from '../../src/domain/versions/hostConfigSave.js';

/** Obviously not a credential, and distinctive enough to find anywhere in a string. */
const VALUE = 'not-a-real-secret-0123456789';

describe('describeSettingsSave', () => {
  it('names the file and the keys of an env save', () => {
    const said = describeSettingsSave({
      expectedGeneration: 3,
      files: [
        { path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value: VALUE }, { key: 'API_PORT', value: '3100' }] },
        { path: 'engines/srs/.env', entries: [{ key: 'SRS_WEBHOOK_TOKEN', value: VALUE }] },
      ],
    });

    assert.equal(said, '.env API_AUTH_TOKEN API_PORT, engines/srs/.env SRS_WEBHOOK_TOKEN');
  });

  it('carries no value of any file it describes', () => {
    const said = describeSettingsSave({
      expectedGeneration: 3,
      files: [
        { path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value: VALUE }] },
        { path: 'engines/srs/.env', entries: [{ key: 'SRT_PASSPHRASE', value: VALUE, remove: true }] },
        { path: 'deploy/config.json', text: `{"note":"${VALUE}"}` },
      ],
    });

    assert.equal(said.includes(VALUE), false, 'a value reached the log line');
    assert.equal(said.includes('not-a-real'), false, 'part of a value reached the log line');
  });

  it('names a text file by its path, because it has no keys to name', () => {
    const said = describeSettingsSave({
      expectedGeneration: 3,
      files: [{ path: 'deploy/config.json', text: '{}' }],
    });

    assert.equal(said, 'deploy/config.json');
  });
});
