/**
 * What the manager reads out of a version's checkout.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The fixtures under test/fixtures/stack are cut from the two real branches, so
 * these assertions are the two contracts the manager actually has to tell
 * apart: nine ports and slots to 999 and no secrets on the pinned `main-v2`,
 * sixteen ports across two bands and slots to 99 and two secrets and a
 * chequebook floor on `main-v3`. Every number here was read off the branch on
 * 2026-09-05, and a fixture that stops matching upstream is the point: the
 * contract changed and the reader has to be looked at again.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeStackContract } from '@streaming-infra-manager/common';

import { readStackContract } from '../../src/domain/versions/stackContract.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (branch: string) =>
  join(here, '..', 'fixtures', 'stack', branch);

const v2 = readStackContract(fixture('v2'));
const v3 = readStackContract(fixture('v3'));

const portNames = (contract: typeof v2) =>
  contract.ports.map((port) => port.name);

describe('readStackContract on main-v2', () => {
  it('reads the nine ports, default and slot base being the same field', () => {
    assert.equal(v2.ports.length, 9);
    assert.deepEqual(v2.ports[0], {
      name: 'API_PORT',
      defaultPort: 10000,
      slotBase: 10000,
      protocol: 'tcp',
    });
    assert.equal(portNames(v2).includes('SRS_HTTP_API_PORT'), false);
  });

  it('reads the slot ceiling of 999', () => {
    assert.equal(v2.maxSlot, 999);
  });

  it('finds no secret to generate', () => {
    assert.deepEqual(v2.requiredSecrets, []);
  });

  it('reads the engine defaults from the entrypoints', () => {
    assert.equal(v2.engineDefaults.HLS_FRAGMENT, '1.5');
    assert.equal(v2.engineDefaults.HLS_WINDOW, '22.5');
    assert.equal(v2.engineDefaults.SRT_LATENCY, undefined);
    assert.equal(v2.engineDefaults.HLS_SEGMENT_DURATION, '2');
    assert.equal(v2.engineDefaults.HLS_SEGMENT_COUNT, '5');
  });

  it('reports neither the SRS API nor a chequebook gate', () => {
    assert.deepEqual(v2.features, { srsApiPort: false, chequebookGate: false, sharedImageTags: true });
    assert.equal(v2.chequebookMinBzz, null);
  });

  it('understood every line of the table', () => {
    assert.deepEqual(v2.warnings, []);
  });

  it('reads in plain words as the Versions page shows it', () => {
    assert.equal(
      describeStackContract(v2),
      '9 ports, slots 1 to 999, no generated secrets',
    );
  });

  it('runs neither engine on a config file of its own', () => {
    assert.deepEqual(v2.engineConfig, { srs: false, ome: false });
  });

  it('names the image each engine service runs', () => {
    assert.deepEqual(v2.engineImages, {
      srs: 'ossrs/srs:6',
      ome: 'airensoft/ovenmediaengine:latest',
    });
  });
});

describe('readStackContract on main-v3', () => {
  it('reads the ten first-band ports plus the six of the second band', () => {
    assert.equal(v3.ports.length, 16);
    assert.equal(portNames(v3).includes('SRS_HTTP_API_PORT'), true);
  });

  it('takes the slot base from the last field, not the default port', () => {
    assert.deepEqual(v3.ports[0], {
      name: 'API_PORT',
      defaultPort: 3000,
      slotBase: 10000,
      protocol: 'tcp',
    });
    assert.deepEqual(v3.ports[15], {
      name: 'BEE_RUNG_1080P_P2P_PORT',
      defaultPort: 11006,
      slotBase: 11006,
      protocol: 'tcp',
    });
  });

  it('reads the slot ceiling of 99, which the second band forced', () => {
    assert.equal(v3.maxSlot, 99);
  });

  it('finds the two secrets the containers refuse to start without', () => {
    assert.deepEqual(v3.requiredSecrets, [
      'API_AUTH_TOKEN',
      'SRS_WEBHOOK_TOKEN',
    ]);
  });

  it('leaves out the optional secret, which is off when empty', () => {
    assert.equal(v3.requiredSecrets.includes('PUBLISH_KEY_SECRET'), false);
  });

  it('reads the shorter fragment and the SRT latency knob', () => {
    assert.equal(v3.engineDefaults.HLS_FRAGMENT, '0.5');
    assert.equal(v3.engineDefaults.HLS_WINDOW, '15');
    assert.equal(v3.engineDefaults.SRT_LATENCY, '200');
  });

  it('reports the SRS API and the chequebook floor of 0.5 BZZ', () => {
    assert.deepEqual(v3.features, { srsApiPort: true, chequebookGate: true, sharedImageTags: true });
    assert.equal(v3.chequebookMinBzz, '0.5');
  });

  it('reads in plain words as the Versions page shows it', () => {
    assert.equal(
      describeStackContract(v3),
      '16 ports, slots 1 to 99, needs 2 generated secrets, SRS API published, chequebook gate 0.5 BZZ, own config file for both engines',
    );
  });

  it('runs both engines on a config file of their own, because it ships the overrides', () => {
    assert.deepEqual(v3.engineConfig, { srs: true, ome: true });
  });
});

describe('readStackContract on a table it cannot fully read', () => {
  const odd = readStackContract(fixture('unparsable'));

  it('keeps the entries it understood', () => {
    assert.deepEqual(portNames(odd), ['API_PORT', 'CLIENT_PORT']);
  });

  it('names the line it did not, rather than dropping it in silence', () => {
    // A port missing from the table is a port the manager never shifts per
    // slot, so two deployments of that version bind the same one.
    assert.equal(odd.warnings.length, 1);
    assert.match(odd.warnings[0] ?? '', /_lib\.sh line 8/);
    assert.match(odd.warnings[0] ?? '', /SRS_SRT_PORT/);
  });

  it('leaves out an engine default that is itself a substitution', () => {
    // `${HLS_FRAGMENT:-${FALLBACK_FRAGMENT:-1.5}}` would come back as
    // `${FALLBACK_FRAGMENT:-1.5` with the brace missing, and the engine
    // settings drawer would offer that to an operator as a number.
    assert.equal(odd.engineDefaults.HLS_FRAGMENT, undefined);
    assert.equal(odd.engineDefaults.HLS_WINDOW, '22.5');
  });

  it('carries the count into the plain words the page shows', () => {
    assert.match(
      describeStackContract(odd),
      /2 ports, slots 1 to 999, no generated secrets, 1 line not understood/,
    );
  });
});

describe('readStackContract on a checkout that is not a stack', () => {
  it('says which file is missing rather than answering an empty contract', () => {
    assert.throws(
      () => readStackContract(join(here, '..', 'fixtures')),
      /_lib\.sh is missing/,
    );
  });
});

describe('readStackContract and the image tags a version builds', () => {
  /** The v3 fixture with its compose file replaced, or removed for null. */
  const withCompose = (compose: string | null): string => {
    const root = mkdtempSync(join(tmpdir(), 'stack-contract-'));
    cpSync(fixture('v3'), root, { recursive: true });
    const path = join(root, 'deploy', 'docker-compose.yml');
    if (compose === null) rmSync(path);
    else writeFileSync(path, compose);
    return root;
  };

  it('reports shared tags when a built service declares an image name, as both branches do today', () => {
    assert.equal(v2.features.sharedImageTags, true);
    assert.equal(v3.features.sharedImageTags, true);
  });

  it('reports fixed images once no built service names its image, so compose names each after its project', () => {
    const contract = readStackContract(
      withCompose('services:\n  stream-uploader:\n    build:\n      context: ..\n  srs:\n    image: ossrs/srs:6\n'),
    );

    assert.equal(contract.features.sharedImageTags, false);
    assert.deepEqual(contract.warnings, []);
  });

  it('counts a service whose build and image are declared in either order', () => {
    const contract = readStackContract(
      withCompose('services:\n  stream-client:\n    build:\n      context: ..\n    image: stream-client\n'),
    );

    assert.equal(contract.features.sharedImageTags, true);
  });

  it('treats a compose file it cannot read as shared', () => {
    const contract = readStackContract(withCompose(null));

    assert.equal(contract.features.sharedImageTags, true);
  });

  it('treats a compose file whose services it could not read as shared, and says which file', () => {
    const contract = readStackContract(
      withCompose('services:\n    stream-uploader:\n        build: .\n        image: stream-uploader\n'),
    );

    assert.equal(contract.features.sharedImageTags, true);
    assert.equal(contract.warnings.length, 1);
    assert.match(contract.warnings[0] ?? '', /docker-compose\.yml/);
  });

  it('counts an image key whose value it cannot read as a name, since a build under any name is shared', () => {
    const contract = readStackContract(
      withCompose('services:\n  stream-uploader:\n    build:\n      context: ..\n    image: stream-uploader # one tag for every deployment\n'),
    );

    assert.equal(contract.features.sharedImageTags, true);
    assert.deepEqual(contract.warnings, []);
  });
});

describe('readStackContract and the protocol of each port', () => {
  const withCompose = (compose: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'stack-contract-ports-'));
    cpSync(fixture('v3'), root, { recursive: true });
    writeFileSync(join(root, 'deploy', 'docker-compose.yml'), compose);
    return root;
  };
  const protocolOf = (contract: typeof v2, name: string) =>
    contract.ports.find((port) => port.name === name)?.protocol;

  it('reads udp for the SRT ingest and tcp for every other port, on both branches', () => {
    assert.equal(protocolOf(v2, 'SRS_SRT_PORT'), 'udp');
    assert.equal(protocolOf(v2, 'API_PORT'), 'tcp');
    assert.deepEqual(v2.ports.filter((port) => port.protocol === 'udp').map((port) => port.name), ['SRS_SRT_PORT']);
    assert.equal(protocolOf(v3, 'SRS_SRT_PORT'), 'udp');
    assert.equal(protocolOf(v3, 'SRS_HTTP_API_PORT'), 'tcp');
    assert.equal(protocolOf(v3, 'BEE_RUNG_480P_P2P_PORT'), 'tcp');
    assert.equal(v2.allocationProblem, null);
    assert.equal(v3.allocationProblem, null);
  });

  it('reads a mapping with a bind address in front and a fixed container port behind', () => {
    assert.equal(protocolOf(v2, 'BEE_UPLOADER_API_PORT'), 'tcp');
    assert.equal(protocolOf(v2, 'CLIENT_PORT'), 'tcp');
  });

  it('reads the long form too', () => {
    const contract = readStackContract(
      withCompose(
        'services:\n  srs:\n    image: ossrs/srs:6\n    ports:\n      - target: 10080\n        published: "${SRS_SRT_PORT:-10080}"\n        protocol: udp\n      - target: 1935\n        published: ${SRS_RTMP_PORT:-1935}\n',
      ),
    );

    assert.equal(protocolOf(contract, 'SRS_SRT_PORT'), 'udp');
    assert.equal(protocolOf(contract, 'SRS_RTMP_PORT'), 'tcp');
    assert.equal(contract.allocationProblem, null);
  });

  it('takes tcp for a port the compose file does not map', () => {
    const contract = readStackContract(withCompose('services:\n  srs:\n    image: ossrs/srs:6\n'));

    assert.ok(contract.ports.every((port) => port.protocol === 'tcp'));
    assert.equal(contract.allocationProblem, null);
  });

  it('refuses allocation, naming the file and the line, for a mapping it cannot read, and still reads the rest', () => {
    const contract = readStackContract(
      withCompose('services:\n  srs:\n    image: ossrs/srs:6\n    ports:\n      - "${SRS_SRT_PORT:-10080}:10080/udp"\n      - "what:is:this:even:here"\n'),
    );

    assert.equal(protocolOf(contract, 'SRS_SRT_PORT'), 'udp');
    assert.match(contract.allocationProblem ?? '', /docker-compose\.yml line 6/);
  });

  it('refuses allocation for a published port no variable shifts, since every deployment would bind it', () => {
    const contract = readStackContract(
      withCompose('services:\n  srs:\n    image: ossrs/srs:6\n    ports:\n      - "8080:80"\n'),
    );

    assert.match(contract.allocationProblem ?? '', /8080/);
  });
});
