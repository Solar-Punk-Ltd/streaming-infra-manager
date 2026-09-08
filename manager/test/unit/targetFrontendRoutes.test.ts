import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vite from '../../../frontend/vite.config.js';

it('routes Host target requests to the API in development and production', () => {
  const config = vite as { server: { proxy: Record<string, { target: string }> } };
  assert.ok(config.server.proxy['/targets']?.target, 'Vite must proxy targets instead of returning the SPA');
  const nginx = readFileSync(new URL('../../../frontend/nginx.conf', import.meta.url), 'utf8');
  const apiBlocks = [...nginx.matchAll(/location\s+([^\n{]+)\{([^}]+)\}/g)]
    .filter(match => match[2]!.includes('proxy_pass http://manager_api;'));
  assert.ok(apiBlocks.some(match => match[1]!.includes('targets')), 'nginx must send targets to the manager');
});
