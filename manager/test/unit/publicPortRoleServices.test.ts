/**
 * Every service a public firewall band is opened for is one this manager runs.
 *
 * `PUBLIC_PORT_ROLES` in the shared policy decides which ports the generated
 * nftables draft opens from outside, and `ALL_SERVICES` is the whole of what a
 * deployment here can run. Three per-rung Bee peer roles sat in the first and
 * in neither the second nor the stack's own sample config, so the draft opened
 * 297 ports no container was ever going to bind. Nothing joined the two lists,
 * which is why it stood for as long as it did.
 *
 * The check runs one way on purpose. A service with no public port is ordinary,
 * and most of them have none. A public port for a service that never starts is
 * the mistake.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PUBLIC_PORT_ROLES } from '@streaming-infra-manager/common';

import { ALL_SERVICES } from '../../src/types/index.js';

/** Every service a role opens a port for, the alias owners included. */
function servicesWithAPublicBand(): string[] {
  const names = new Set<string>();
  for (const role of PUBLIC_PORT_ROLES) {
    names.add(role.service);
    for (const alias of role.aliases ?? []) names.add(alias.service);
  }
  return [...names];
}

describe('the services a public band is opened for', () => {
  it('names only services this manager runs', () => {
    const started: readonly string[] = ALL_SERVICES;

    assert.deepEqual(
      servicesWithAPublicBand().filter((service) => !started.includes(service)),
      [],
      'the firewall would open a band for a service no deployment here runs',
    );
  });

  it('reaches the services that do have one, so the check can fail', () => {
    assert.deepEqual(servicesWithAPublicBand().sort(), [
      'bee-gateway',
      'bee-uploader',
      'client',
      'ome',
      'srs',
    ]);
  });
});
