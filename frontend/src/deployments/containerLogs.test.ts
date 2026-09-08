import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialLogService } from './logSelection';

describe('container-specific diagnostics', () => {
  it('opens the selected container instead of the engine, with an honest missing fallback', () => {
    assert.equal(initialLogService(['srs', 'bee-uploader'], 'srs', 'bee-uploader'), 'bee-uploader');
    assert.equal(initialLogService(['bee-uploader'], null, 'bee-uploader'), 'bee-uploader');
    assert.equal(initialLogService([], null, 'bee-uploader'), null);
  });
});
