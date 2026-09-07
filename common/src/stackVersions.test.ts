/**
 * The rules all three sides apply to a version: what a branch or tag may look
 * like, what name it suggests, and how a contract reads in plain words.
 *
 * The ref rule is the one with teeth. Its value is handed to `git clone
 * --branch` inside the build script, so a leading dash would arrive there as an
 * option and `..` is how a path walks out of the directory it was given.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeStackContract,
  MANAGER_SLOT_CAP,
  parseStackContract,
  slotCapFor,
  stackRefProblem,
  stackVersionNameProblem,
  versionNameFromRef,
  type StackContract,
} from './stackVersions.js';

const V3_CONTRACT: StackContract = {
  ports: Array.from({ length: 10 }, (_value, index) => ({
    name: `PORT_${index}`,
    defaultPort: 3000 + index,
    slotBase: 10000 + index,
    protocol: index === 1 ? ('udp' as const) : ('tcp' as const),
    service: index === 1 ? 'srs' : null,
  })),
  maxSlot: 99,
  requiredSecrets: ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'],
  engineDefaults: { HLS_FRAGMENT: '0.5' },
  features: { srsApiPort: true, chequebookGate: true, sharedImageTags: true },
  chequebookMinBzz: '0.5',
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: 'airensoft/ovenmediaengine:latest' },
  warnings: [],
  allocationProblem: null,
};

const V2_CONTRACT: StackContract = {
  ports: Array.from({ length: 9 }, (_value, index) => ({
    name: `PORT_${index}`,
    defaultPort: 10000 + index,
    slotBase: 10000 + index,
    protocol: 'tcp' as const,
    service: null,
  })),
  maxSlot: 999,
  requiredSecrets: [],
  engineDefaults: { HLS_FRAGMENT: '1.5' },
  features: { srsApiPort: false, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: 'airensoft/ovenmediaengine:latest' },
  warnings: [],
  allocationProblem: null,
};

describe('stackRefProblem', () => {
  it('accepts the shapes a branch or tag actually takes', () => {
    for (const ref of ['main-v3', 'v2.8.1', 'feature/abr_ladder', 'HEAD']) {
      assert.equal(stackRefProblem(ref), null, ref);
    }
  });

  it('refuses a leading dash, which git would read as an option', () => {
    // Only letters and dashes, so the character rule passes and the leading
    // dash is what has to be refused.
    assert.match(stackRefProblem('--upload-pack') ?? '', /cannot start/);
  });

  it('refuses two dots in a row', () => {
    assert.match(stackRefProblem('main/../etc') ?? '', /two dots/);
  });

  it('refuses characters no ref holds', () => {
    for (const ref of ['main;rm -rf /', 'main$(id)', 'main v3', 'main|tee']) {
      assert.notEqual(stackRefProblem(ref), null, ref);
    }
  });

  it('refuses an empty ref and one over a hundred characters', () => {
    assert.notEqual(stackRefProblem(''), null);
    assert.notEqual(stackRefProblem('a'.repeat(101)), null);
    assert.equal(stackRefProblem('a'.repeat(100)), null);
  });
});

describe('stackVersionNameProblem', () => {
  it('accepts a lower case name of letters, digits and dashes', () => {
    assert.equal(stackVersionNameProblem('main-v3'), null);
    assert.equal(stackVersionNameProblem('bundled'), null);
  });

  it('refuses upper case, slashes, dots and a leading dash', () => {
    for (const name of ['Main', 'main/v3', 'main.v3', '-main', '']) {
      assert.notEqual(stackVersionNameProblem(name), null, name);
    }
  });
});

describe('versionNameFromRef', () => {
  it('keeps a name that is already usable', () => {
    assert.equal(versionNameFromRef('main-v3'), 'main-v3');
  });

  it('folds case and everything else into single dashes', () => {
    assert.equal(versionNameFromRef('feature/Fast_HLS'), 'feature-fast-hls');
    assert.equal(versionNameFromRef('v2.8.1'), 'v2-8-1');
  });

  it('leaves no dash at either end, even after the length clamp', () => {
    assert.equal(versionNameFromRef('--main--'), 'main');
    const long = versionNameFromRef(`${'a'.repeat(39)}/tail`);
    assert.equal(long.length <= 40, true);
    assert.equal(long.endsWith('-'), false);
  });

  it('answers empty when nothing usable is left, so the caller asks', () => {
    assert.equal(versionNameFromRef('///'), '');
  });
});

describe('describeStackContract', () => {
  it('reads the way the Versions page shows it', () => {
    assert.equal(
      describeStackContract(V3_CONTRACT),
      '10 ports, slots 1 to 99, needs 2 generated secrets, SRS API published, chequebook gate 0.5 BZZ, own config file for both engines',
    );
  });

  it('names the one engine that takes a config file when only one does', () => {
    assert.equal(
      describeStackContract({
        ...V2_CONTRACT,
        engineConfig: { srs: true, ome: false },
      }),
      '9 ports, slots 1 to 999, no generated secrets, own config file for SRS',
    );
  });

  it('leaves out what a version does not have', () => {
    assert.equal(
      describeStackContract(V2_CONTRACT),
      '9 ports, slots 1 to 999, no generated secrets',
    );
  });

  it('counts the port lines the reader could not make sense of', () => {
    assert.equal(
      describeStackContract({
        ...V2_CONTRACT,
        warnings: ['_lib.sh line 12 is not a port entry: SRS_SRT_PORT'],
      }),
      '9 ports, slots 1 to 999, no generated secrets, 1 line not understood',
    );
  });

  it('says one secret in the singular', () => {
    assert.match(
      describeStackContract({ ...V2_CONTRACT, requiredSecrets: ['ONE'] }),
      /needs 1 generated secret,|needs 1 generated secret$/,
    );
  });
});

describe('parseStackContract', () => {
  it('reads back what it stored', () => {
    const stored: unknown = JSON.parse(JSON.stringify(V3_CONTRACT));
    assert.deepEqual(parseStackContract(stored), V3_CONTRACT);
  });

  it('answers null for the empty object a version starts with', () => {
    assert.equal(parseStackContract({}), null);
    assert.equal(parseStackContract(null), null);
  });

  it('answers null rather than half a contract when a port entry is broken', () => {
    assert.equal(
      parseStackContract({
        ...V2_CONTRACT,
        ports: [{ name: 'API_PORT', defaultPort: 'ten thousand' }],
      }),
      null,
    );
  });

  it('reads a port stored without a protocol as tcp, and a contract stored without an allocation problem as having none', () => {
    const stored = JSON.parse(JSON.stringify(V3_CONTRACT)) as Record<string, unknown>;
    stored.ports = (stored.ports as Record<string, unknown>[]).map(({ protocol: _protocol, service: _service, ...rest }) => rest);
    delete stored.allocationProblem;

    const parsed = parseStackContract(stored);

    assert.ok(parsed);
    assert.ok(parsed.ports.every((port) => port.protocol === 'tcp'));
    assert.ok(parsed.ports.every((port) => port.service === null), 'a port stored without a service is unmapped');
    assert.equal(parsed.allocationProblem, null);
  });

  it('keeps udp, and reads any other protocol word as tcp', () => {
    const stored = JSON.parse(JSON.stringify(V3_CONTRACT)) as { ports: Record<string, unknown>[] };
    stored.ports[0]!.protocol = 'sctp';

    const parsed = parseStackContract(stored);

    assert.equal(parsed?.ports[0]?.protocol, 'tcp');
    assert.equal(parsed?.ports[1]?.protocol, 'udp');
  });
});

describe('slotCapFor', () => {
  it('is the lower of the version maximum and the manager cap of 100, counting every stored record', () => {
    assert.equal(MANAGER_SLOT_CAP, 100);
    assert.equal(slotCapFor({ ...V2_CONTRACT, maxSlot: 999 }), 100);
    assert.equal(slotCapFor({ ...V3_CONTRACT, maxSlot: 99 }), 99);
    assert.equal(slotCapFor(null), 100);
  });
});
