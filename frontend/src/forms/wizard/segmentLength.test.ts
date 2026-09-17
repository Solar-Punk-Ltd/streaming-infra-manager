/**
 * The segment length a new deployment is created with, tested without a
 * browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * A deployment that stores nothing runs on whatever its stack version's
 * entrypoints fall back to, which is half a second on main-v3. The wizard
 * therefore carries the manager's own default explicitly rather than leaving
 * the field empty, so what the operator saw at create is what the drawer shows
 * afterwards and what the container cuts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from '@streaming-infra-manager/common';

import {
  SEGMENT_LENGTH_FIELD,
  segmentLengthError,
  segmentLengthSettings,
} from './segmentLength';
import {
  initialWizardState,
  offersSegmentLength,
  type WizardContext,
  type WizardState,
} from './wizardState';

const context: WizardContext = {
  profiles: [],
  groups: [],
  serverHost: 'fixture.test',
  hostPassphrase: null,
  beeRpcEndpoint: { configured: false, host: null },
  poolResults: new Map(),
  versions: [],
};

const streamState = (patch: Partial<WizardState> = {}): WizardState => ({
  ...initialWizardState({ goal: 'stream' }, context),
  ...patch,
});

describe('the segment length a new deployment starts at', () => {
  it("is the manager's own two seconds, read off the shared field", () => {
    assert.equal(SEGMENT_LENGTH_FIELD.key, 'HLS_FRAGMENT');
    assert.equal(SEGMENT_LENGTH_FIELD.defaultValue, '2');
    assert.equal(streamState().segmentSeconds, '2');
  });

  it('travels on the create body, so the drawer shows what was chosen', () => {
    assert.deepEqual(segmentLengthSettings('2'), { HLS_FRAGMENT: '2' });
    assert.deepEqual(segmentLengthSettings(' 1.5 '), { HLS_FRAGMENT: '1.5' });
  });

  it("sends nothing when the field is cleared, so the version's own default stands", () => {
    assert.equal(segmentLengthSettings(''), undefined);
    assert.equal(segmentLengthSettings('   '), undefined);
  });
});

describe('where the segment length is offered', () => {
  it('is a deployment that runs the engine reading it', () => {
    assert.equal(offersSegmentLength(streamState()), true);
    assert.equal(
      offersSegmentLength(streamState({ engine: OME_SERVICE })),
      false,
      'HLS_FRAGMENT is an SRS key and OME reads a duration of its own',
    );
  });

  it('is not a viewer, which runs no media server at all', () => {
    assert.equal(
      offersSegmentLength(initialWizardState({ goal: 'viewer' }, context)),
      false,
    );
  });

  it('is an ABR uploader, which always runs SRS', () => {
    assert.equal(
      offersSegmentLength(initialWizardState({ goal: 'abr-uploader' }, context)),
      true,
    );
  });

  it('is not a node pool, which is Bee nodes and no engine', () => {
    assert.equal(
      offersSegmentLength(initialWizardState({ goal: 'abr-pool' }, context)),
      false,
    );
  });

  it('follows the components a custom deployment picked', () => {
    const custom = initialWizardState({ goal: 'custom' }, context);

    assert.equal(
      offersSegmentLength({ ...custom, components: [SRS_SERVICE] }),
      true,
    );
    assert.equal(offersSegmentLength({ ...custom, components: [] }), false);
  });
});

describe('what the wizard says about a segment length it would refuse', () => {
  it('refuses it in the drawer\'s own words, so the two never disagree', () => {
    assert.match(
      segmentLengthError('two') ?? '',
      /Segment length must be a positive number, use a period for decimals/,
    );
    assert.match(segmentLengthError('90') ?? '', /must be at most 30/);
  });

  it('says nothing about an empty field, which means send nothing', () => {
    assert.equal(segmentLengthError(''), null);
    assert.equal(segmentLengthError('  '), null);
  });
});
