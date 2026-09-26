/**
 * How the deployment settings editor groups the keys and what its search
 * keeps.
 *
 * Unit test, no browser. `pnpm test` in frontend/.
 *
 * The stack's sample declares close to a hundred keys under a dozen sections,
 * so the list is only readable folded by those sections, and a search has to
 * reach a key inside a folded one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import {
  OTHER_SECTION_TITLE,
  UNDECLARED_SECTION_TITLE,
  filteredSections,
  isSectionOpen,
  sectionsOf,
} from './settingsSections';

function entry(key: string, section: string, overrides: Partial<DeploymentSettingEntry> = {}): DeploymentSettingEntry {
  return {
    key,
    section,
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
    services: null,
    running: 'same',
    engineSetting: null,
    ...overrides,
  };
}

const ENTRIES: DeploymentSettingEntry[] = [
  entry('STAMP', 'Required, and the stamp purchase defaults'),
  entry('UPLOADER_START_GATES', 'Stream Uploader', {
    description: 'What the two startup gates below do about a node they cannot clear.',
  }),
  entry('CHEQUEBOOK_MIN_BZZ', 'Stream Uploader', {
    description: 'The chequebook floor, in BZZ, that every Bee node must hold available.',
  }),
  entry('ABR_ENABLED', 'ABR ladder'),
  entry('LOG_LEVEL', 'Logging'),
  entry('HLS_FRAGMENT', 'SRS Media Server'),
  entry('ABR_VHOST', 'ABR ladder'),
  entry('LOOSE_KEY', ''),
  entry('OLD_UPLOAD_RETRIES', '', { declared: false }),
];

const titles = (sections: ReturnType<typeof sectionsOf>) => sections.map(({ title }) => title);
const keys = (sections: ReturnType<typeof sectionsOf>) =>
  sections.map(({ entries }) => entries.map(({ key }) => key));

describe('sectionsOf', () => {
  it('groups the keys under their sections in the order the sections first appear', () => {
    assert.deepEqual(titles(sectionsOf(ENTRIES)), [
      'Required, and the stamp purchase defaults',
      'Stream Uploader',
      'ABR ladder',
      'Logging',
      'SRS Media Server',
      OTHER_SECTION_TITLE,
      UNDECLARED_SECTION_TITLE,
    ]);
  });

  it('keeps one section for a title met twice, the keys in list order', () => {
    const abr = sectionsOf(ENTRIES).find(({ title }) => title === 'ABR ladder');

    assert.deepEqual(abr?.entries.map(({ key }) => key), ['ABR_ENABLED', 'ABR_VHOST']);
  });

  it('lists a key the version no longer declares apart from the declared keys with no section', () => {
    const sections = sectionsOf(ENTRIES);

    assert.deepEqual(keys(sections).at(-2), ['LOOSE_KEY']);
    assert.deepEqual(keys(sections).at(-1), ['OLD_UPLOAD_RETRIES']);
  });

  it('gives every section an id of its own', () => {
    const ids = sectionsOf(ENTRIES).map(({ id }) => id);

    assert.equal(new Set(ids).size, ids.length);
  });

  it('has nothing to show for an empty list', () => {
    assert.deepEqual(sectionsOf([]), []);
  });
});

describe('filteredSections', () => {
  const sections = sectionsOf(ENTRIES);

  it('keeps everything while the search is empty or blank', () => {
    assert.deepEqual(filteredSections(sections, ''), sections);
    assert.deepEqual(filteredSections(sections, '   '), sections);
  });

  it('matches a key, whatever its case', () => {
    assert.deepEqual(keys(filteredSections(sections, 'log_level')), [['LOG_LEVEL']]);
  });

  it('matches the description as well as the key', () => {
    assert.deepEqual(keys(filteredSections(sections, 'chequebook floor')), [['CHEQUEBOOK_MIN_BZZ']]);
  });

  it('keeps only the matching keys of a section, and drops a section with none', () => {
    const found = filteredSections(sections, 'abr');

    assert.deepEqual(titles(found), ['ABR ladder']);
    assert.deepEqual(keys(found), [['ABR_ENABLED', 'ABR_VHOST']]);
  });

  it('finds nothing for a search nothing matches', () => {
    assert.deepEqual(filteredSections(sections, 'no such setting'), []);
  });
});

describe('isSectionOpen', () => {
  it('opens a section the operator opened, and no other, while nothing is searched', () => {
    const opened = new Set(['a']);

    assert.equal(isSectionOpen('a', opened, ''), true);
    assert.equal(isSectionOpen('b', opened, ''), false);
  });

  it('opens every section a search kept, which each hold a match', () => {
    assert.equal(isSectionOpen('b', new Set(), 'gate'), true);
  });

  it('treats a blank search as none', () => {
    assert.equal(isSectionOpen('b', new Set(), '  '), false);
  });
});
