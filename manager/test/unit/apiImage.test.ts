/**
 * What the api image pins, read off the Dockerfile.
 *
 * The deploy scripts run docker compose from inside the api container, so
 * the Compose that decides how a container is created from a shared tag is
 * the api image's. The host's api container was read on 2026-09-07 at
 * Compose v5.1.4, which is what the shared image race harness runs against,
 * and an unpinned package would move under that reading.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, '..', '..', 'Dockerfile'), 'utf8');

describe('the api image', () => {
  it('pins the Compose plugin to the version the host runs and the harness verifies', () => {
    assert.match(dockerfile, /docker-cli-compose=5\.1\.4-r\d+/);
    assert.equal(/\bdocker-cli-compose\s/.test(dockerfile.replace(/docker-cli-compose=[^\s]+/g, '')), false, 'the plugin is installed only pinned');
  });
});
