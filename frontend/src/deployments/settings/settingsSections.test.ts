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

import { type DeploymentSettingEntry, engineSettingsFieldsFor } from '@streaming-infra-manager/common';

import {
  ENGINE_SECTION_TITLE,
  OTHER_SECTION_TITLE,
  UNDECLARED_SECTION_TITLE,
  filteredSections,
  isSectionOpen,
  sectionIdHolding,
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

describe('the engine settings of a deployment', () => {
  /** The SRS fields a deployment without the ladder reads, by key, as the editor hands them to the list. */
  const ENGINE_FIELDS = new Map(engineSettingsFieldsFor('srs', { abr: false }).map((field) => [field.key, field]));
  const WITH_ENGINE = [
    ...ENTRIES,
    entry('SRT_LATENCY', 'SRS Media Server'),
    entry('HLS_WINDOW', ''),
    entry('HLS_SEGMENT_MAX', ''),
  ];

  it('are gathered first in a section of their own, in the order the engine lists them', () => {
    const sections = sectionsOf(WITH_ENGINE, ENGINE_FIELDS);

    assert.equal(sections[0]?.title, ENGINE_SECTION_TITLE);
    assert.deepEqual(keys(sections)[0], ['HLS_FRAGMENT', 'HLS_SEGMENT_MAX', 'HLS_WINDOW', 'SRT_LATENCY']);
    assert.equal(titles(sections).includes('SRS Media Server'), false, 'no key is left in the sample section they came from');
    assert.deepEqual(keys(sections).at(-2), ['LOOSE_KEY']);
  });

  it('are found by their label and their help, as well as by their key', () => {
    const sections = sectionsOf(WITH_ENGINE, ENGINE_FIELDS);

    assert.deepEqual(keys(filteredSections(sections, 'force-close', ENGINE_FIELDS)), [['HLS_SEGMENT_MAX']]);
    assert.deepEqual(keys(filteredSections(sections, 'resent before giving up', ENGINE_FIELDS)), [['SRT_LATENCY']]);
  });

  it('stay where the sample puts them when the list is given no engine fields, as the wizard list is', () => {
    assert.equal(titles(sectionsOf(WITH_ENGINE)).includes(ENGINE_SECTION_TITLE), false);
  });
});

describe('sectionIdHolding', () => {
  it('finds the section a key is folded in, which a request to show that key opens', () => {
    const engineFields = new Map(engineSettingsFieldsFor('srs', { abr: false }).map((field) => [field.key, field]));
    const sections = sectionsOf([...ENTRIES, entry('SRT_LATENCY', 'SRS Media Server')], engineFields);

    assert.equal(sectionIdHolding(sections, 'SRT_LATENCY'), sections[0]?.id);
    assert.equal(sectionIdHolding(sections, 'LOG_LEVEL'), sections.find(({ title }) => title === 'Logging')?.id);
    assert.equal(sectionIdHolding(sections, 'NOT_LISTED'), null);
  });
});
