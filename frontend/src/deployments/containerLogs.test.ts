import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '../app/theme';
import { ContainersCard } from './ContainersCard';
import { initialLogService } from './logSelection';
import type { Profile } from '../types';

describe('container-specific diagnostics', () => {
  it('exposes a named logs action for every container, including Bee-only deployments', () => {
    const profile = { name: 'node', status: 'RUNNING', kind: 'custom', components: ['bee-uploader'], containers: [{ service: 'bee-uploader', ports: {} }, { service: 'stream-uploader', ports: {} }] } as Profile;
    const html = renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(ContainersCard, { profile, host: 'localhost', snapshot: null, uploaderPending: false })));
    assert.match(html, /aria-label="View bee-uploader logs"/);
    assert.match(html, /aria-label="View stream-uploader logs"/);
  });

  it('opens the selected container instead of the engine, with an honest missing fallback', () => {
    assert.equal(initialLogService(['srs', 'bee-uploader'], 'srs', 'bee-uploader'), 'bee-uploader');
    assert.equal(initialLogService(['bee-uploader'], null, 'bee-uploader'), 'bee-uploader');
    assert.equal(initialLogService([], null, 'bee-uploader'), null);
  });
});
