import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineForComponents, hasConflictingEngines } from './engines.js';

describe('engineForComponents', () => {
  it('defaults to srs when components are unset', () => {
    assert.equal(engineForComponents(null), 'srs');
    assert.equal(engineForComponents(undefined), 'srs');
    assert.equal(engineForComponents([]), 'srs');
  });

  it('defaults to srs when no engine is selected', () => {
    assert.equal(engineForComponents(['client', 'bee-gateway']), 'srs');
  });

  it('selects ome only when the ome component is present', () => {
    assert.equal(engineForComponents(['srs', 'stream-uploader']), 'srs');
    assert.equal(
      engineForComponents(['bee-uploader', 'ome', 'stream-uploader']),
      'ome',
    );
  });
});

describe('hasConflictingEngines', () => {
  it('flags only component lists containing both engines', () => {
    assert.equal(hasConflictingEngines(['srs', 'ome']), true);
    assert.equal(hasConflictingEngines(['srs']), false);
    assert.equal(hasConflictingEngines(['ome']), false);
    assert.equal(hasConflictingEngines([]), false);
    assert.equal(hasConflictingEngines(null), false);
  });
});
