/**
 * What a settings save may name, checked at the edge and nowhere else.
 *
 * Unit test, nothing on disk. `pnpm test` in manager/.
 *
 * The service checks a path against the files the version actually keeps, and
 * that check is what the route tests exercise. This one is the schema on its
 * own: the allowlist is the gate that stands whether or not a file happens to
 * be there, and a path that walks out of the config root must never reach the
 * service to be looked up in the first place.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { saveVersionSettingsSchema } from '../../src/schemas/version.js';

const ONE_KEY = [{ key: 'API_PORT', value: '3100' }];

function refusedPath(path: string): Promise<void> {
  return assert.rejects(
    () =>
      saveVersionSettingsSchema.validate(
        { expectedGeneration: 1, files: [{ path, entries: ONE_KEY }] },
        { abortEarly: false },
      ),
    /not a settings file of a stack version/,
    path,
  );
}

describe('saveVersionSettingsSchema', () => {
  it('refuses a path that walks out of the config root', async () => {
    for (const path of [
      '../outside/.env',
      '../../etc/passwd',
      'engines/../../.env',
      'engines/srs/../../../.env',
      '/etc/passwd',
      './.env',
      'deploy/../.env',
    ]) {
      await refusedPath(path);
    }
  });

  it('refuses a path of the checkout that is not one of the settings files', async () => {
    for (const path of ['deploy/scripts/deploy.sh', '.git/config', '.env.sample', 'engines/srs/.env.stage']) {
      await refusedPath(path);
    }
  });

  it('takes the three shapes the set is made of', async () => {
    const save = await saveVersionSettingsSchema.validate(
      {
        expectedGeneration: 1,
        files: [
          { path: '.env', entries: ONE_KEY },
          { path: 'engines/srs/.env', entries: ONE_KEY },
          { path: 'deploy/config.json', text: '{}' },
        ],
      },
      { abortEarly: false },
    );

    assert.deepEqual(save.files.map((file) => file?.path), [
      '.env',
      'engines/srs/.env',
      'deploy/config.json',
    ]);
  });
});
