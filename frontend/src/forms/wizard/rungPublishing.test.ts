import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LadderRungState } from '@streaming-infra-manager/common';

import { probedRungUrl, rungPublishingSummary } from './rungPublishing';

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
    assert.equal(probedRungUrl(rung('ok')), 'http://node.test:10055');
  });

  it('says the address did not answer where nothing was listening', () => {
    assert.equal(
      rungPublishingSummary(rung('unreachable')),
      'Node checks passed. Publishing address did not answer.',
    );
    assert.equal(probedRungUrl(rung('unreachable')), 'http://node.test:10055');
  });

  it('claims nothing about an address no probe answered for', () => {
    for (const state of [undefined, 'unknown', 'loopback', 'ssh-target', 'malformed'] as const) {
      assert.equal(
        rungPublishingSummary(rung(state)),
        'Node checks passed. Publishing is not verified.',
        String(state),
      );
      assert.equal(probedRungUrl(rung(state)), null, String(state));
    }
  });

  it('claims nothing while the pool result has not arrived', () => {
    assert.equal(
      rungPublishingSummary(null),
      'Node checks passed. Publishing is not verified.',
    );
    assert.equal(probedRungUrl(null), null);
  });
});
