/**
 * What the Containers card calls public against what the firewall opens.
 *
 * Two lists decide that and neither reads the other. `endpointKindOf` in the
 * frontend reads a port's audience off its key, and `PUBLIC_PORT_ROLES` in the
 * shared policy is what the generated nftables draft opens. RTMP was in the
 * first and never in the second, so the card offered an ingest address the
 * firewall drops, which is the one thing an operator cannot check from the
 * screen. It is a manager test because the shared policy and the manager's own
 * port table both live on this side.
 *
 * The keys checked are the ones a deployment can show: the bundled port table,
 * the OME variables the engine swap resolves to, and every variable a public
 * role names.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OME_PORT_SOURCES,
  PUBLIC_PORT_ROLES,
} from '@streaming-infra-manager/common';

import { BUNDLED_PORT_TABLE } from '../../src/domain/versions/portTable.js';

const { endpointKindOf } = await import(
  new URL('../../../frontend/src/deployments/endpoints.ts', import.meta.url).href
);

/** Every port variable a public role admits, aliases included. */
function openedPortVars(): Set<string> {
  const names = new Set<string>();
  for (const role of PUBLIC_PORT_ROLES) {
    names.add(role.portVar);
    for (const alias of role.aliases ?? []) names.add(alias.portVar);
  }
  return names;
}

const PORT_KEYS = [
  ...BUNDLED_PORT_TABLE.map((port) => port.name),
  ...Object.keys(OME_PORT_SOURCES),
  ...openedPortVars(),
];

function calledPublic(): string[] {
  return [...new Set(PORT_KEYS)].filter(
    (key) => endpointKindOf(key).audience === 'public',
  );
}

describe('what the port cell calls public', () => {
  it('names only ports the generated firewall opens', () => {
    const opened = openedPortVars();

    assert.deepEqual(
      calledPublic().filter((key) => !opened.has(key)),
      [],
      'the card calls these public and the generated rules drop them from outside',
    );
  });

  it('reaches the ports that are genuinely public, so it can fail', () => {
    assert.deepEqual(
      calledPublic().sort(),
      [
        'BEE_GATEWAY_P2P_PORT',
        'BEE_RUNG_1080P_P2P_PORT',
        'BEE_RUNG_480P_P2P_PORT',
        'BEE_RUNG_720P_P2P_PORT',
        'BEE_UPLOADER_P2P_PORT',
        'CLIENT_PORT',
        'OME_SRT_PORT',
        'SRS_SRT_PORT',
      ],
    );
  });

  it('was written for the RTMP port, which no role names at all', () => {
    assert.equal(openedPortVars().has('SRS_RTMP_PORT'), false);
    assert.notEqual(endpointKindOf('SRS_RTMP_PORT').audience, 'public');
  });
});
