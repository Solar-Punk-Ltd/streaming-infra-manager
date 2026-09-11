/**
 * Reading a version's env sample and rewriting the operator's own env file.
 *
 * Unit test. The shapes are the strings below, and the last group reads the v3
 * fixture's own samples, because what the descriptions have to survive is the
 * way upstream actually writes these files. `pnpm test` in manager/.
 *
 * The settings page shows what each key is for, which is the comment block the
 * sample carries above it, and saves a value back into the operator's file.
 * That file is the one the containers read, so a save has to touch the line it
 * was asked to and nothing else: a comment lost here is documentation lost off
 * the host, and a reflowed file is a diff nobody can review over ssh.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  envAssignmentsOf,
  rewriteEnvText,
  sampleSettingsOf,
} from '../../src/domain/versions/envSettingsText.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const SAMPLE = [
  '# The section this file opens with, which no key follows directly.',
  '',
  'STAMP=',
  'STREAM_KEY=',
  '',
  '# Bearer token for every gated route. Required, with no unauthenticated mode,',
  '# because every accepted segment spends postage stamp money. Minimum 32',
  '# characters.',
  'API_AUTH_TOKEN=',
  '',
  '# Commented out on purpose upstream, so the entrypoint decides it.',
  '# HLS_FRAGMENT=0.5',
  '',
  'API_PORT=3000',
  '',
].join('\n');

describe('sampleSettingsOf', () => {
  it('reads the keys in the sample order with the values the sample assigns', () => {
    assert.deepEqual(
      sampleSettingsOf(SAMPLE).map((setting) => [setting.key, setting.value]),
      [
        ['STAMP', ''],
        ['STREAM_KEY', ''],
        ['API_AUTH_TOKEN', ''],
        ['API_PORT', '3000'],
      ],
    );
  });

  it('takes the comment run directly above a key as its description', () => {
    const settings = sampleSettingsOf(SAMPLE);
    const api = settings.find((setting) => setting.key === 'API_AUTH_TOKEN');

    assert.equal(
      api?.description,
      'Bearer token for every gated route. Required, with no unauthenticated mode, because every accepted segment spends postage stamp money. Minimum 32 characters.',
    );
  });

  it('leaves a key with a blank line above it undescribed', () => {
    const settings = sampleSettingsOf(SAMPLE);

    assert.equal(settings.find((setting) => setting.key === 'STAMP')?.description, '');
    assert.equal(settings.find((setting) => setting.key === 'API_PORT')?.description, '');
  });

  it('leaves a key with another key above it undescribed', () => {
    const settings = sampleSettingsOf(SAMPLE);

    assert.equal(settings.find((setting) => setting.key === 'STREAM_KEY')?.description, '');
  });

  it('ends the run at a commented out assignment of another key, whose lines those are', () => {
    const settings = sampleSettingsOf(
      ['# What HLS_FRAGMENT is.', '# HLS_FRAGMENT=0.5', '# What this one is.', 'HLS_WINDOW=15'].join('\n'),
    );

    assert.deepEqual(settings.map((setting) => setting.key), ['HLS_WINDOW']);
    assert.equal(settings[0]?.description, 'What this one is.');
  });

  it('keeps a commented out assignment of the key itself, which is its example', () => {
    const settings = sampleSettingsOf(
      ['# What it is.', '# HLS_WINDOW=15', 'HLS_WINDOW='].join('\n'),
    );

    assert.equal(settings[0]?.description, 'What it is. HLS_WINDOW=15');
  });

  it('keeps a wrapped sentence that happens to open with a key name', () => {
    const settings = sampleSettingsOf(
      [
        '# What it is, and what it needs. Requires',
        '# HLS_ENABLED=true, since there is nothing to fragment otherwise.',
        'HLS_WINDOW=15',
      ].join('\n'),
    );

    assert.equal(
      settings[0]?.description,
      'What it is, and what it needs. Requires HLS_ENABLED=true, since there is nothing to fragment otherwise.',
    );
  });

  it('drops a section rule, so a description opens with a sentence', () => {
    const settings = sampleSettingsOf(
      ['# --- Logging ------------', '# What it is.', 'LOG_LEVEL=debug'].join('\n'),
    );

    assert.equal(settings[0]?.description, 'What it is.');
  });

  it('reads a sample whose lines end with a carriage return', () => {
    const settings = sampleSettingsOf('# What it is.\r\nAPI_PORT=3000\r\n');

    assert.deepEqual(settings, [
      { key: 'API_PORT', value: '3000', description: 'What it is.' },
    ]);
  });
});

describe('envAssignmentsOf', () => {
  it('answers the keys in file order, comments and blank lines passed by', () => {
    const assignments = envAssignmentsOf(
      ['# a comment', '', 'API_PORT=3000', 'export ENGINE=srs', '  SPACED = yes '].join('\n'),
    );

    assert.deepEqual([...assignments], [
      ['API_PORT', '3000'],
      ['ENGINE', 'srs'],
      ['SPACED', ' yes '],
    ]);
  });

  it('keeps the last assignment of a repeated key, where the reader ends up', () => {
    assert.deepEqual([...envAssignmentsOf('A=first\nB=2\nA=last\n')], [
      ['A', 'last'],
      ['B', '2'],
    ]);
  });
});

/** An operator's own file: comments, a blank line, trailing spaces, an export and a CRLF line. */
const LIVE = [
  '# The token every gated route reads.',
  'API_AUTH_TOKEN=old-token   ',
  '',
  '# A comment nothing edits.',
  'export API_PORT=3000',
  'CRLF_KEY=old\r',
  'REMOVE_ME=gone',
].join('\n');

describe('rewriteEnvText', () => {
  it('replaces one value and leaves every other byte where it was', () => {
    const rewritten = rewriteEnvText(LIVE, [
      { key: 'API_AUTH_TOKEN', value: 'new-token' },
    ]);

    assert.equal(
      rewritten,
      [
        '# The token every gated route reads.',
        'API_AUTH_TOKEN=new-token',
        '',
        '# A comment nothing edits.',
        'export API_PORT=3000',
        'CRLF_KEY=old\r',
        'REMOVE_ME=gone',
      ].join('\n'),
    );
  });

  it('keeps the export prefix and the spacing up to the equals sign', () => {
    assert.equal(
      rewriteEnvText('export  API_PORT =3000\n', [{ key: 'API_PORT', value: '4000' }]),
      'export  API_PORT =4000\n',
    );
  });

  it('round trips a line whose value the reader would see spaced', () => {
    const spaced = 'API_PORT = 3000 \n';
    const value = envAssignmentsOf(spaced).get('API_PORT') ?? '';

    assert.equal(value, ' 3000 ');
    assert.equal(rewriteEnvText(spaced, [{ key: 'API_PORT', value }]), spaced);
  });

  it('keeps a carriage return at the end of the line it rewrites', () => {
    assert.equal(
      rewriteEnvText(LIVE, [{ key: 'CRLF_KEY', value: 'new' }]).split('\n')[5],
      'CRLF_KEY=new\r',
    );
  });

  it('appends a key the file does not assign yet', () => {
    assert.equal(
      rewriteEnvText('A=1\n', [{ key: 'B', value: '2' }]),
      'A=1\nB=2\n',
    );
  });

  it('separates an appended key from a file whose last line is unterminated', () => {
    assert.equal(rewriteEnvText('A=1', [{ key: 'B', value: '2' }]), 'A=1\nB=2\n');
  });

  it('deletes the line of a key it is asked to remove', () => {
    assert.equal(
      rewriteEnvText(LIVE, [{ key: 'REMOVE_ME', value: '', remove: true }]),
      LIVE.split('\n').slice(0, -1).join('\n'),
    );
  });

  it('writes nothing for a key it is asked to remove that is not there', () => {
    assert.equal(rewriteEnvText('A=1\n', [{ key: 'B', value: '', remove: true }]), 'A=1\n');
  });

  it('gives every line assigning a repeated key the value the operator typed', () => {
    assert.equal(
      rewriteEnvText('A=first\nB=2\nA=last\n', [{ key: 'A', value: 'one' }]),
      'A=one\nB=2\nA=one\n',
    );
  });

  it('returns the text unchanged when it is asked for nothing', () => {
    assert.equal(rewriteEnvText(LIVE, []), LIVE);
  });
});

/**
 * The samples upstream ships, rather than the shapes above.
 *
 * A description that absorbs the block above a commented out assignment
 * documents the wrong key, and a section rule at the top of a run is a row of
 * dashes where a sentence should be.
 */
describe('sampleSettingsOf over the version samples themselves', () => {
  const settingsIn = (relative: string) =>
    sampleSettingsOf(readFileSync(join(V3_FIXTURE, `${relative}.sample`), 'utf8'));
  const describedAs = (relative: string, key: string): string =>
    settingsIn(relative).find((setting) => setting.key === key)?.description ?? '';

  it('gives a key its own sentences and not the ones above a commented out other key', () => {
    const orphan = describedAs('.env', 'ORPHAN_REAP_MS');

    assert.match(orphan, /^How long a live stream may receive nothing/);
    assert.match(orphan, /RECOVERY_TIMEOUT rather than SEGMENT_STALL_MS\.$/);
    assert.equal(orphan.includes('HLS_FRAGMENT'), false, 'it took the block documenting another key');
  });

  it('keeps a commented out assignment of the key itself, which is the example', () => {
    const publishers = describedAs('.env', 'BEE_PUBLISHERS');

    assert.match(publishers, /^One Bee node per ABR rung/);
    assert.match(publishers, /BEE_PUBLISHERS=360p@/);
    assert.match(publishers, /1080p@http:\/\/localhost:1663<batchid>$/);
  });

  it('keeps the sentences a wrapped line beginning with another key name would cut', () => {
    const publishers = describedAs('.env', 'BEE_PUBLISHERS');

    assert.match(publishers, /Every rung in ABR_LADDER must appear here and nothing else may/);
    assert.match(publishers, /Requires ABR_ENABLED=true, since with no ladder there is nothing to map onto\./);
  });

  it('opens a description with a sentence rather than with a section rule', () => {
    assert.match(describedAs('.env', 'LOG_LEVEL'), /^How much the stream-uploader prints/);
    assert.match(describedAs('engines/srs/.env', 'ABR_ENABLED'), /^Off by default/);
    assert.equal(describedAs('.env', 'LOG_LEVEL').includes('---'), false);
    assert.equal(describedAs('engines/srs/.env', 'ABR_ENABLED').includes('==='), false);
  });

  it('leaves the key that follows a commented out assignment of another key undescribed', () => {
    assert.equal(describedAs('.env', 'API_PORT'), '');
  });
});
