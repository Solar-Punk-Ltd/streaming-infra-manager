/**
 * What a save of a deployment's settings refuses, before anything is stored.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A key the version does not declare is refused, unless the deployment still
 * stores it, which a save may only reset. A key a control of the deployment's
 * own decides is refused with that control named. A value is held to the rules
 * every env value answers to, and to its field where the stack's accepted
 * values are known. No refusal ever repeats a secret.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { settingEditProblems } from '../../src/domain/settings/settingEditProblems.js';

function entry(over: Partial<DeploymentSettingEntry> & { key: string }): DeploymentSettingEntry {
  return {
    section: '',
    description: '',
    declared: true,
    secret: false,
    sampleValue: null,
    versionSet: false,
    versionValue: null,
    stored: false,
    storedValue: null,
    value: null,
    source: 'unset',
    owner: null,
    field: null,
    services: null,
    running: 'unknown',
    engineSetting: null,
    ...over,
  };
}

const ENTRIES = [
  entry({ key: 'LOG_LEVEL' }),
  entry({ key: 'ADMIN_API_TOKEN', secret: true }),
  entry({ key: 'STAMP', owner: 'stamp', source: 'manager' }),
  entry({ key: 'OLD_KEY', declared: false, stored: true, source: 'deployment' }),
];

describe('what a save of a deployment settings refuses', () => {
  it('takes a declared key with a good value, and a reset of any key it lists', () => {
    assert.deepEqual(
      settingEditProblems(
        [
          { key: 'LOG_LEVEL', value: 'info' },
          { key: 'ADMIN_API_TOKEN', value: 'synthetic-token' },
          { key: 'OLD_KEY', value: null },
        ],
        ENTRIES,
      ),
      [],
    );
  });

  it('refuses a key the version does not declare', () => {
    assert.deepEqual(settingEditProblems([{ key: 'MADE_UP', value: 'x' }], ENTRIES), [
      "MADE_UP is not a setting this deployment's version declares.",
    ]);
  });

  it('refuses a new value for a key the version dropped, and takes a reset of it', () => {
    assert.match(settingEditProblems([{ key: 'OLD_KEY', value: 'x' }], ENTRIES)[0] ?? '', /no longer declares/);
  });

  it('refuses a key a control decides, and names the control', () => {
    assert.deepEqual(settingEditProblems([{ key: 'STAMP', value: 'b'.repeat(64) }], ENTRIES), [
      "STAMP is set by the deployment's postage stamp, not here.",
    ]);
  });

  it('refuses a value outside its field', () => {
    assert.match(settingEditProblems([{ key: 'LOG_LEVEL', value: 'loud' }], ENTRIES)[0] ?? '', /LOG_LEVEL must be one of debug, log, info/);
  });

  it('refuses a secret the engine would read as sed syntax, and never repeats it', () => {
    const problems = settingEditProblems([{ key: 'ADMIN_API_TOKEN', value: 'synthetic/marker' }], ENTRIES);

    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^ADMIN_API_TOKEN /);
    assert.doesNotMatch(problems.join(' '), /synthetic\/marker/);
  });

  it('refuses a key named twice in one save', () => {
    assert.deepEqual(
      settingEditProblems([{ key: 'LOG_LEVEL', value: 'info' }, { key: 'LOG_LEVEL', value: 'debug' }], ENTRIES),
      ['LOG_LEVEL is named twice in this save.'],
    );
  });
});

describe('what a save refuses of an engine setting', () => {
  const ENGINE_ENTRIES = [
    entry({ key: 'HLS_FRAGMENT', versionSet: true, versionValue: '2', source: 'version' }),
    entry({ key: 'ABR_FPS', owner: 'abr-only', source: 'version' }),
    entry({ key: 'HLS_SEGMENT_COUNT', owner: 'ome-only', stored: true, source: 'deployment' }),
  ];

  it('holds an engine setting the deployment reads to its field, and names the key', () => {
    assert.deepEqual(settingEditProblems([{ key: 'HLS_FRAGMENT', value: '0.1' }], ENGINE_ENTRIES), [
      'HLS_FRAGMENT: Segment length must be at least 0.5. Got 0.1.',
    ]);
    assert.deepEqual(settingEditProblems([{ key: 'HLS_FRAGMENT', value: '1.5' }], ENGINE_ENTRIES), []);
  });

  it('refuses an empty engine setting, which only a reset takes back to its default', () => {
    assert.deepEqual(settingEditProblems([{ key: 'HLS_FRAGMENT', value: '' }], ENGINE_ENTRIES), [
      'HLS_FRAGMENT: Segment length cannot be empty. Leave it unset to use the default instead.',
    ]);
  });

  it('refuses a value for an engine setting the deployment does not read, and says who reads it', () => {
    assert.deepEqual(settingEditProblems([{ key: 'ABR_FPS', value: '25' }], ENGINE_ENTRIES), [
      'ABR_FPS cannot be set here, because only a deployment that encodes the ABR ladder reads it.',
    ]);
  });

  it('takes a reset of one it does not read, so a value stored for it can be taken out', () => {
    assert.deepEqual(settingEditProblems([{ key: 'HLS_SEGMENT_COUNT', value: null }], ENGINE_ENTRIES), []);
  });
});
