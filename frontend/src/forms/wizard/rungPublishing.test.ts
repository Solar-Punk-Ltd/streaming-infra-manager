import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { LadderRungState } from '@streaming-infra-manager/common';

import {
  poolProbeFailureNote,
  probedRungNote,
  rungPublishingSummary,
} from './rungPublishing';

const rung = (urlState?: LadderRungState['urlState']): LadderRungState => ({
  rung: '360p',
  name: 'abr-pool-1-360p',
  status: 'RUNNING',
  url: 'http://node.test:10055',
  stampId: `0x${'a'.repeat(64)}`,
  ...(urlState ? { urlState } : {}),
});

describe('what a pool member says about the address it publishes on', () => {
  it('says the address answered where the manager reached it', () => {
    assert.equal(
      rungPublishingSummary(rung('ok')),
      'Node checks passed. Publishing address answers.',
    );
    assert.equal(probedRungNote(rung('ok')), 'Publishing address http://node.test:10055 answers');
  });

  it('says the address did not answer where nothing was listening', () => {
    assert.equal(
      rungPublishingSummary(rung('unreachable')),
      'Node checks passed. Publishing address did not answer.',
    );
    assert.equal(
      probedRungNote(rung('unreachable')),
      'Publishing address http://node.test:10055 did not answer',
    );
  });

  it('claims nothing about an address no probe answered for', () => {
    for (const state of [undefined, 'unknown', 'loopback', 'ssh-target', 'malformed'] as const) {
      assert.equal(
        rungPublishingSummary(rung(state)),
        'Node checks passed. Publishing is not verified.',
        String(state),
      );
      assert.equal(probedRungNote(rung(state)), null, String(state));
    }
  });

  it('claims nothing while the pool result has not arrived', () => {
    assert.equal(
      rungPublishingSummary(null),
      'Node checks passed. Publishing is not verified.',
    );
    assert.equal(probedRungNote(null), null);
  });

  it('says the manager is still asking while the first answer is out', () => {
    assert.equal(
      rungPublishingSummary(null, true),
      'Node checks passed. The manager is asking the publishing address.',
    );
  });

  it('keeps an answer it already has while a refresh is in flight', () => {
    assert.equal(
      rungPublishingSummary(rung('ok'), true),
      'Node checks passed. Publishing address answers.',
    );
  });
});

describe('what the step says when the pool result could not be read', () => {
  it('carries the reason, and says what is unaffected by it', () => {
    const note = poolProbeFailureNote('network error') ?? '';

    assert.match(note, /network error/);
    assert.match(note, /node checks below/i);
  });

  it('says nothing where there was no failure', () => {
    assert.equal(poolProbeFailureNote(null), null);
    assert.equal(poolProbeFailureNote(''), null);
  });
});

describe('the step that shows these sentences', () => {
  it('renders every one of them, because a sentence nobody renders says nothing', () => {
    const source = readFileSync(
      new URL('./steps/PoolPrerequisites.tsx', import.meta.url),
      'utf8',
    );

    for (const shown of ['poolProbeFailureNote', 'rungPublishingSummary', 'probedRungNote']) {
      assert.match(source, new RegExp(`${shown}\\(`), `${shown} reaches no one`);
    }
    assert.match(source, /publishers\.loading/, 'the summary is never told a fetch is in flight');
  });
});
