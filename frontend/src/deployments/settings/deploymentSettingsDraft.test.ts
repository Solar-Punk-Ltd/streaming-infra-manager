/**
 * What the deployment settings editor holds while it is being edited, and
 * what a save sends.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The editor itself is
 * rendered by `frontend/test/deployment-settings-browser.test.mjs`.
 *
 * A save carries only the keys the operator changed, each once, and names the
 * revision the edits were made against. Sending anything else either rewrites
 * a key nobody touched or writes over a change somebody else saved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  DeploymentSettingEntry,
  DeploymentSettingsCatalog,
} from '@streaming-infra-manager/common';

import {
  EMPTY_DRAFT,
  canReset,
  draftProblems,
  engineDraftProblem,
  engineSettingsOfDraft,
  pendingEdits,
  saveOf,
  shownValue,
  storedEngineProblem,
  takesValue,
  valueBeforeEdit,
  valueProblem,
  withReset,
  withValue,
  withoutEdit,
} from './deploymentSettingsDraft';

function entry(overrides: Partial<DeploymentSettingEntry> & { key: string }): DeploymentSettingEntry {
  return {
    section: 'Stream Uploader',
    description: '',
    declared: true,
    secret: false,
    sampleValue: null,
    versionSet: true,
    versionValue: null,
    stored: false,
    storedValue: null,
    value: null,
    source: 'version',
    owner: null,
    field: null,
    services: ['stream-uploader'],
    running: 'same',
    engineSetting: null,
    ...overrides,
  };
}

const LOG_LEVEL = entry({
  key: 'LOG_LEVEL',
  versionValue: 'info',
  value: 'info',
  field: { kind: 'choice', choices: ['debug', 'log', 'info', 'warn', 'error', 'silent'] },
});
const MAX_QUEUE_SIZE = entry({
  key: 'MAX_QUEUE_SIZE',
  versionValue: '100',
  stored: true,
  storedValue: '250',
  value: '250',
  source: 'deployment',
  field: { kind: 'integer', min: 1 },
});
const ADMIN_API_URL = entry({ key: 'ADMIN_API_URL', versionValue: '', value: '' });
const UNSET_KEY = entry({ key: 'BEE_REQUEST_TIMEOUT_MS', versionSet: false, source: 'unset' });
const ADMIN_API_TOKEN = entry({ key: 'ADMIN_API_TOKEN', secret: true, stored: true, source: 'deployment' });
const API_AUTH_TOKEN = entry({ key: 'API_AUTH_TOKEN', secret: true, versionSet: false, source: 'generated' });
const STAMP = entry({ key: 'STAMP', owner: 'stamp', source: 'manager', value: 'ab'.repeat(32) });
const HLS_FRAGMENT = entry({
  key: 'HLS_FRAGMENT',
  section: 'SRS Media Server',
  owner: 'engine-settings',
  source: 'manager',
  stored: true,
  storedValue: '2',
  value: '1',
  services: ['srs'],
});
const OLD_UPLOAD_RETRIES = entry({
  key: 'OLD_UPLOAD_RETRIES',
  section: '',
  declared: false,
  versionSet: false,
  stored: true,
  storedValue: '5',
  value: '5',
  source: 'deployment',
  services: null,
});

const CATALOG: DeploymentSettingsCatalog = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  revision: 3,
  buildId: 'abc1234',
  entries: [
    LOG_LEVEL,
    MAX_QUEUE_SIZE,
    ADMIN_API_URL,
    UNSET_KEY,
    ADMIN_API_TOKEN,
    API_AUTH_TOKEN,
    STAMP,
    HLS_FRAGMENT,
    OLD_UPLOAD_RETRIES,
  ],
  drift: { keys: [], services: [], fullRedeploy: false },
  running: true,
  engine: 'srs',
  abr: false,
  engineSettingsProblem: null,
};

describe('valueBeforeEdit', () => {
  it('is the value the deployment stores when it stores one', () => {
    assert.equal(valueBeforeEdit(MAX_QUEUE_SIZE), '250');
  });

  it("is the version's value when the deployment stores none", () => {
    assert.equal(valueBeforeEdit(LOG_LEVEL), 'info');
  });

  it('is empty for a key nothing sets', () => {
    assert.equal(valueBeforeEdit(UNSET_KEY), '');
  });

  it('is empty for a secret, stored or not, because no secret value ever reaches the page', () => {
    assert.equal(valueBeforeEdit(ADMIN_API_TOKEN), '');
    assert.equal(valueBeforeEdit(API_AUTH_TOKEN), '');
  });
});

describe('takesValue and canReset', () => {
  it('lets the operator type a value for a declared key no control decides', () => {
    assert.equal(takesValue(LOG_LEVEL), true);
    assert.equal(takesValue(ADMIN_API_TOKEN), true);
  });

  it('gives a key a control decides no value of its own', () => {
    assert.equal(takesValue(STAMP), false);
    assert.equal(takesValue(HLS_FRAGMENT), false);
  });

  it('gives a key the version no longer declares no value of its own', () => {
    assert.equal(takesValue(OLD_UPLOAD_RETRIES), false);
  });

  it('offers a reset wherever the deployment stores a value, and nowhere else', () => {
    assert.equal(canReset(MAX_QUEUE_SIZE), true);
    assert.equal(canReset(ADMIN_API_TOKEN), true);
    assert.equal(canReset(HLS_FRAGMENT), true);
    assert.equal(canReset(OLD_UPLOAD_RETRIES), true);
    assert.equal(canReset(LOG_LEVEL), false);
    assert.equal(canReset(API_AUTH_TOKEN), false);
  });
});

describe('pendingEdits and saveOf', () => {
  it('sends nothing while nothing has been typed', () => {
    assert.deepEqual(pendingEdits(CATALOG, EMPTY_DRAFT), []);
  });

  it('sends the key that moved and no other, with the revision the page read', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');

    assert.deepEqual(saveOf(CATALOG, draft), {
      expectedInstanceId: CATALOG.instanceId,
      expectedRevision: 3,
      entries: [{ key: 'LOG_LEVEL', value: 'debug' }],
    });
  });

  it('sends every changed key once, in the order the list gives them', () => {
    const draft = withValue(
      withValue(withValue(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE', '300'), CATALOG, 'LOG_LEVEL', 'warn'),
      CATALOG,
      'LOG_LEVEL',
      'debug',
    );

    assert.deepEqual(pendingEdits(CATALOG, draft), [
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'MAX_QUEUE_SIZE', value: '300' },
    ]);
  });

  it('forgets a key typed back to what it was, and the revision with the last one', () => {
    const typed = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');
    const back = withValue(typed, CATALOG, 'LOG_LEVEL', 'info');

    assert.deepEqual(pendingEdits(CATALOG, back), []);
    assert.deepEqual(back, EMPTY_DRAFT);
  });

  it('stores an empty value when a stored value is cleared, which is not the same as a reset', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE', '');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'MAX_QUEUE_SIZE', value: '' }]);
  });

  it("sends a reset as null, which takes the key back to the version's value", () => {
    const draft = withReset(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'MAX_QUEUE_SIZE', value: null }]);
  });

  it('changes nothing when a key nothing stores is reset', () => {
    assert.deepEqual(withReset(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL'), EMPTY_DRAFT);
  });

  it('replaces a pending reset with a value typed after it', () => {
    const draft = withValue(withReset(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE'), CATALOG, 'MAX_QUEUE_SIZE', '400');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'MAX_QUEUE_SIZE', value: '400' }]);
  });

  it('sends nothing for an empty secret field, and the value for a typed one', () => {
    assert.deepEqual(withValue(EMPTY_DRAFT, CATALOG, 'ADMIN_API_TOKEN', ''), EMPTY_DRAFT);

    const draft = withValue(EMPTY_DRAFT, CATALOG, 'API_AUTH_TOKEN', 'a'.repeat(64));

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'API_AUTH_TOKEN', value: 'a'.repeat(64) }]);
  });

  it('resets a stored secret as null', () => {
    const draft = withReset(EMPTY_DRAFT, CATALOG, 'ADMIN_API_TOKEN');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'ADMIN_API_TOKEN', value: null }]);
  });

  it('takes no value for a key a control decides, and a reset of its stored value', () => {
    assert.deepEqual(withValue(EMPTY_DRAFT, CATALOG, 'STAMP', 'cd'.repeat(32)), EMPTY_DRAFT);
    assert.deepEqual(withValue(EMPTY_DRAFT, CATALOG, 'HLS_FRAGMENT', '4'), EMPTY_DRAFT);

    const draft = withReset(EMPTY_DRAFT, CATALOG, 'HLS_FRAGMENT');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'HLS_FRAGMENT', value: null }]);
  });

  it('takes only a reset for a key the version no longer declares', () => {
    assert.deepEqual(withValue(EMPTY_DRAFT, CATALOG, 'OLD_UPLOAD_RETRIES', '6'), EMPTY_DRAFT);

    const draft = withReset(EMPTY_DRAFT, CATALOG, 'OLD_UPLOAD_RETRIES');

    assert.deepEqual(pendingEdits(CATALOG, draft), [{ key: 'OLD_UPLOAD_RETRIES', value: null }]);
  });

  it('drops an edit whose key the list no longer carries', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');
    const shorter = { ...CATALOG, entries: CATALOG.entries.filter(({ key }) => key !== 'LOG_LEVEL') };

    assert.deepEqual(pendingEdits(shorter, draft), []);
  });

  it('names the revision the edits were made against after the list is read again at a newer one', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');
    const newer = { ...CATALOG, revision: 4 };

    assert.equal(saveOf(newer, draft).expectedRevision, 3);
  });

  it('names the list revision once the draft has nothing in it', () => {
    const newer = { ...CATALOG, revision: 4 };
    const undone = withoutEdit(withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug'), 'LOG_LEVEL');

    assert.equal(saveOf(newer, undone).expectedRevision, 4);
    assert.deepEqual(undone, EMPTY_DRAFT);
  });

  it('leaves the draft it was given alone', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');
    const next = withValue(draft, CATALOG, 'MAX_QUEUE_SIZE', '300');

    assert.deepEqual(Object.keys(draft.edits), ['LOG_LEVEL']);
    assert.deepEqual(EMPTY_DRAFT, { revision: null, edits: {} });
    assert.notEqual(draft, next);
  });
});

describe('shownValue', () => {
  it('holds what the operator typed', () => {
    const draft = withValue(EMPTY_DRAFT, CATALOG, 'LOG_LEVEL', 'debug');

    assert.equal(shownValue(LOG_LEVEL, draft.edits.LOG_LEVEL), 'debug');
  });

  it("holds the version's value while a reset is pending, and empty for a secret", () => {
    const draft = withReset(withReset(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE'), CATALOG, 'ADMIN_API_TOKEN');

    assert.equal(shownValue(MAX_QUEUE_SIZE, draft.edits.MAX_QUEUE_SIZE), '100');
    assert.equal(shownValue(ADMIN_API_TOKEN, draft.edits.ADMIN_API_TOKEN), '');
  });

  it('holds the value before any edit when there is none', () => {
    assert.equal(shownValue(MAX_QUEUE_SIZE, undefined), '250');
  });
});

describe('valueProblem and draftProblems', () => {
  it('says why the stack would read a value differently, as the manager would refuse it', () => {
    assert.match(valueProblem('ADMIN_API_URL', ' http://admin') ?? '', /^This value cannot begin or end with a space/);
  });

  it("holds a value to the stack's own bounds for a key with a field", () => {
    assert.equal(valueProblem('MAX_QUEUE_SIZE', '0'), 'MAX_QUEUE_SIZE must be at least 1. Got 0.');
    assert.equal(valueProblem('LOG_LEVEL', 'loud')?.startsWith('LOG_LEVEL must be one of'), true);
  });

  it('never repeats a secret it refuses', () => {
    const secret = 'abc/def-not-a-real-token';
    const problem = valueProblem('ADMIN_API_TOKEN', secret);

    assert.ok(problem);
    assert.equal(problem.includes(secret), false);
  });

  it('names only the keys a save would send with a value it would be refused for', () => {
    const draft = withReset(
      withValue(withValue(EMPTY_DRAFT, CATALOG, 'MAX_QUEUE_SIZE', '0'), CATALOG, 'LOG_LEVEL', 'debug'),
      CATALOG,
      'ADMIN_API_TOKEN',
    );

    assert.deepEqual(Object.keys(draftProblems(CATALOG, draft)), ['MAX_QUEUE_SIZE']);
  });

  it('finds nothing wrong with an empty value, which leaves the key to the stack', () => {
    assert.equal(valueProblem('MAX_QUEUE_SIZE', ''), null);
  });
});

/** A deployment's own engine setting, as its list answers it, with the default an unset one falls back to on its host. */
function engineEntry(key: string, defaultValue: string, overrides: Partial<DeploymentSettingEntry> = {}): DeploymentSettingEntry {
  return entry({
    key,
    section: '',
    versionValue: defaultValue,
    value: null,
    services: ['srs'],
    engineSetting: { defaultSource: 'stack', notInConfig: false },
    ...overrides,
  });
}

/** An SRS deployment without the ladder whose ceiling is stored above the stack's 2.5. */
const ENGINE_CATALOG: DeploymentSettingsCatalog = {
  ...CATALOG,
  entries: [
    LOG_LEVEL,
    engineEntry('HLS_FRAGMENT', '0.5', { services: ['srs', 'stream-uploader'] }),
    engineEntry('HLS_SEGMENT_MAX', '2.5', { stored: true, storedValue: '4', source: 'deployment' }),
    engineEntry('HLS_WINDOW', '15'),
    engineEntry('SRT_LATENCY', '2000', { source: 'manager-default', engineSetting: { defaultSource: 'manager', notInConfig: false } }),
  ],
};

describe('the engine settings a draft leaves', () => {
  it('are what is stored, with each value typed set and each reset taken out', () => {
    const draft = withReset(withValue(EMPTY_DRAFT, ENGINE_CATALOG, 'HLS_FRAGMENT', '3'), ENGINE_CATALOG, 'HLS_SEGMENT_MAX');

    assert.deepEqual(engineSettingsOfDraft(ENGINE_CATALOG, EMPTY_DRAFT), { HLS_SEGMENT_MAX: '4' });
    assert.deepEqual(engineSettingsOfDraft(ENGINE_CATALOG, draft), { HLS_FRAGMENT: '3' });
  });

  it('go to the save beside the other keys, a reset as null', () => {
    const draft = withReset(withValue(EMPTY_DRAFT, ENGINE_CATALOG, 'LOG_LEVEL', 'warn'), ENGINE_CATALOG, 'HLS_SEGMENT_MAX');

    assert.deepEqual(saveOf(ENGINE_CATALOG, draft).entries, [
      { key: 'LOG_LEVEL', value: 'warn' },
      { key: 'HLS_SEGMENT_MAX', value: null },
    ]);
  });
});

describe('engineDraftProblem', () => {
  it('names a pair the engine would refuse, in the words the manager would', () => {
    const draft = withReset(withValue(EMPTY_DRAFT, ENGINE_CATALOG, 'HLS_FRAGMENT', '3'), ENGINE_CATALOG, 'HLS_SEGMENT_MAX');

    assert.equal(
      engineDraftProblem(ENGINE_CATALOG, draft),
      'The force-close ceiling of 2.5 seconds is below the segment length of 3 seconds, so every piece would be cut before a keyframe could end one and the engine refuses to start. Raise the ceiling to at least the segment length, or lower the segment length.',
    );
  });

  it('judges the half of the pair it leaves untouched at what it is stored as, else its default', () => {
    assert.equal(engineDraftProblem(ENGINE_CATALOG, withValue(EMPTY_DRAFT, ENGINE_CATALOG, 'HLS_FRAGMENT', '3')), null);
  });

  it('says nothing while the draft touches no engine setting', () => {
    // A stored pair the engine would refuse, as a host's default moving under it can leave one.
    const stored = (value: string) => ({ stored: true, storedValue: value, source: 'deployment' as const });
    const broken: DeploymentSettingsCatalog = {
      ...ENGINE_CATALOG,
      entries: ENGINE_CATALOG.entries.map((row) => {
        if (row.key === 'HLS_SEGMENT_MAX') return { ...row, ...stored('1') };
        return row.key === 'HLS_FRAGMENT' ? { ...row, ...stored('2') } : row;
      }),
    };

    assert.equal(engineDraftProblem(broken, withValue(EMPTY_DRAFT, broken, 'LOG_LEVEL', 'warn')), null);
    assert.match(engineDraftProblem(broken, withValue(EMPTY_DRAFT, broken, 'HLS_WINDOW', '20')) ?? '', /force-close ceiling of 1 seconds/);
  });

  it('leaves a value refused on its own field to the field, which says it there', () => {
    const draft = withValue(EMPTY_DRAFT, ENGINE_CATALOG, 'HLS_FRAGMENT', '0.1');

    assert.equal(engineDraftProblem(ENGINE_CATALOG, draft), null);
    assert.deepEqual(draftProblems(ENGINE_CATALOG, draft), { HLS_FRAGMENT: 'Segment length must be at least 0.5. Got 0.1.' });
  });
});

const CEILING_UNDER_SEGMENT =
  'The force-close ceiling of 1 seconds is below the segment length of 2 seconds, so every piece would be cut before a keyframe could end one and the engine refuses to start. Raise the ceiling to at least the segment length, or lower the segment length.';

/** A segment length of 2 and a ceiling of 1, stored, with the sentence the manager lists them with because its deploy would refuse them. */
const REFUSED_CATALOG: DeploymentSettingsCatalog = {
  ...ENGINE_CATALOG,
  entries: ENGINE_CATALOG.entries.map((row) => {
    if (row.key === 'HLS_FRAGMENT') return { ...row, stored: true, storedValue: '2', source: 'deployment' };
    return row.key === 'HLS_SEGMENT_MAX' ? { ...row, storedValue: '1' } : row;
  }),
  engineSettingsProblem: CEILING_UNDER_SEGMENT,
};

describe('storedEngineProblem', () => {
  it('names why the next deploy would refuse what is stored, and leaves a save of other keys free to land', () => {
    const stackOnly = withValue(EMPTY_DRAFT, REFUSED_CATALOG, 'LOG_LEVEL', 'warn');

    assert.equal(storedEngineProblem(REFUSED_CATALOG, EMPTY_DRAFT), CEILING_UNDER_SEGMENT);
    assert.equal(storedEngineProblem(REFUSED_CATALOG, stackOnly), CEILING_UNDER_SEGMENT);
    assert.equal(engineDraftProblem(REFUSED_CATALOG, stackOnly), null);
  });

  it('gives way to what the draft leaves once it changes an engine setting, so the sentence is said once', () => {
    const fixing = withValue(EMPTY_DRAFT, REFUSED_CATALOG, 'HLS_FRAGMENT', '1');
    const elsewhere = withValue(EMPTY_DRAFT, REFUSED_CATALOG, 'HLS_WINDOW', '20');

    assert.equal(storedEngineProblem(REFUSED_CATALOG, fixing), null);
    assert.equal(engineDraftProblem(REFUSED_CATALOG, fixing), null);
    assert.equal(storedEngineProblem(REFUSED_CATALOG, elsewhere), null);
    assert.equal(engineDraftProblem(REFUSED_CATALOG, elsewhere), CEILING_UNDER_SEGMENT);
  });

  it('says nothing while the deploy takes what is stored', () => {
    assert.equal(storedEngineProblem(ENGINE_CATALOG, EMPTY_DRAFT), null);
  });
});

describe('valueProblem for an engine setting', () => {
  it("holds it to the engine's own rule for its field", () => {
    assert.equal(valueProblem('SRT_LATENCY', '20.5'), 'SRT latency must be a whole number. Got "20.5".');
    assert.equal(valueProblem('SRT_LATENCY', '3000'), null);
  });

  it('refuses an empty one, which only a reset takes back to its default', () => {
    assert.equal(valueProblem('HLS_FRAGMENT', ''), 'Segment length cannot be empty. Leave it unset to use the default instead.');
  });
});
