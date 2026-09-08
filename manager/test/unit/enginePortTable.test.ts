import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseStackContract, portExposureProblem } from '@streaming-infra-manager/common';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import { portTableForEngine } from '../../src/domain/versions/enginePortTable.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';

const contract = readStackContract(fileURLToPath(new URL('../fixtures/stack/v3/', import.meta.url)));

describe('effective OME port ownership', () => {
  it('reads the two actual Compose aliases and preserves them through stored-contract parsing', () => {
    assert.deepEqual(contract.portAliases?.map(port => [port.name, port.service, port.protocol]).sort(), [
      ['OME_HLS_PORT', 'ome', 'tcp'], ['OME_SRT_PORT', 'ome', 'udp'],
    ]);
    assert.deepEqual(parseStackContract(contract)?.portAliases, contract.portAliases);
  });

  it('projects only SRT and HLS while preserving the remaining whole-table reservations', () => {
    const ome = portTableForEngine(contract, 'ome');
    const owned = portPlanFor(ome, 1).filter(port => port.service === 'ome');
    assert.deepEqual(owned.map(port => [port.portVar, port.protocol, port.port]), [
      ['OME_SRT_PORT', 'udp', 10011], ['OME_HLS_PORT', 'tcp', 10013],
    ]);
    assert.ok(ome.some(port => port.name === 'SRS_RTMP_PORT' && port.service === 'srs'));
    assert.ok(ome.some(port => port.name === 'API_PORT' && port.service === 'stream-uploader'));
    assert.ok(owned.every(port => portExposureProblem(port) === null));
    assert.deepEqual(portTableForEngine(contract, 'srs'), contract.ports);
  });

  for (const broken of ['missing', 'service', 'protocol'] as const) {
    it(`refuses ${broken} alias evidence for OME`, () => {
      const value = structuredClone(contract);
      if (broken === 'missing') value.portAliases = [];
      if (broken === 'service') value.portAliases![0]!.service = 'other';
      if (broken === 'protocol') value.portAliases![0]!.protocol = value.portAliases![0]!.protocol === 'tcp' ? 'udp' : 'tcp';
      assert.throws(() => portTableForEngine(value, 'ome'), /OME|alias/);
    });
  }
});
