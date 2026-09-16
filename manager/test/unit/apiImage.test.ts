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
const compose = readFileSync(join(here, '..', '..', 'docker-compose.yml'), 'utf8');

describe('the api image', () => {
  it('pins the Compose plugin to the version the host runs and the harness verifies', () => {
    assert.match(dockerfile, /docker-cli-compose=5\.1\.4-r\d+/);
    assert.equal(/\bdocker-cli-compose\s/.test(dockerfile.replace(/docker-cli-compose=[^\s]+/g, '')), false, 'the plugin is installed only pinned');
  });

  /**
   * The manager's ssh identity for deployments on other hosts is a directory
   * the host mounts, and its ssh_config has to be read as the system-wide
   * config, because ssh refuses a per-user config file another uid owns. The
   * first shape of that was a second bind mount of the file itself, which a
   * host with no such file cannot start: Docker makes a root-owned directory
   * at the missing path and refuses to mount a directory onto a file. That
   * stopped the deploy of 2026-09-16 on a freshly rebuilt host before the
   * upgrade ran. A link inside the image points at nothing on such a host,
   * which ssh treats as no config at all.
   */
  it('links the system-wide ssh config to the mounted identity, so a host without one starts with none', () => {
    assert.match(dockerfile, /^RUN ln -sf? \/root\/\.ssh\/ssh_config \/etc\/ssh\/ssh_config\s*$/m);
  });
});

describe('the api container', () => {
  it('mounts the ssh identity as a directory and never as a file a fresh host lacks', () => {
    assert.match(compose, /\$\{MANAGER_SSH_DIR:-[^}]+\}:\/root\/\.ssh\b/);
    assert.doesNotMatch(compose, /:\/etc\/ssh\/ssh_config/, 'no bind mount onto the system ssh config');
  });
});
