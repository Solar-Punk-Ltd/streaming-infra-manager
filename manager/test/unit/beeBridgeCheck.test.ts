/**
 * The one check a Bee image passes before money moves through a bridge in it.
 *
 * It only reads: the four absolute paths the bridge script runs are there and
 * executable, and bash has /dev/tcp, which a connect to closed port 9 proves by
 * answering "refused" rather than "No such file". The container classifies
 * bash's answer itself and prints fixed words, so the manager never parses
 * upstream text: anything but the exact expected lines is an unreadable answer.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { BEE_BRIDGE_BINARIES } from '@streaming-infra-manager/common';
import { BEE_BRIDGE_CHECK_REVISION, beeBridgeCheckCommand, beeBridgeCheckEvidence, beeBridgeCheckVerdict } from '../../src/domain/chequebook/beeBridgeCheck.js';
import { syntheticBeeBridgeCheckAnswer } from '../support/beeBridgeCheckAnswer.js';
import { DOCKER_BEE_BRIDGE_REVISION, dockerBeeBridgeCommand } from '../../src/domain/chequebook/dockerBeeBridge.js';

const tuple = () => ({ imageId: `sha256:${'d'.repeat(64)}`, engineVersion: '29.1.3', platform: { os: 'linux', architecture: 'amd64', variant: '' },
  bridgeRevision: DOCKER_BEE_BRIDGE_REVISION });

describe('the bridge check definition', () => {
  it('runs one shell in the container and names every path the bridge runs', () => {
    const command = beeBridgeCheckCommand();
    assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-c']);
    assert.equal(command.length, 3);
    for (const path of Object.values(BEE_BRIDGE_BINARIES)) assert.ok(command[2]!.includes(path), path);
    assert.match(command[2]!, /\/dev\/tcp\/127\.0\.0\.1\/9/);
    for (const path of Object.values(BEE_BRIDGE_BINARIES)) assert.ok(dockerBeeBridgeCommand(1633, 1000, 1000).join(' ').includes(path), `the bridge runs ${path}`);
  });

  it('is identified by a hash of its own definition, the way the bridge revision is', () => {
    assert.equal(BEE_BRIDGE_CHECK_REVISION, `sha256:${createHash('sha256').update(JSON.stringify(beeBridgeCheckCommand())).digest('hex')}`);
    assert.match(BEE_BRIDGE_CHECK_REVISION, /^sha256:[a-f0-9]{64}$/);
  });
});

describe('reading the check\'s answer', () => {
  it('passes an image that has every path and a bash with /dev/tcp', () => {
    const verdict = beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer());
    assert.equal(verdict.failed, null);
    assert.deepEqual(verdict.binaries, { env: true, timeout: true, bash: true, cat: true });
    assert.equal(verdict.devTcp, 'refused');
  });

  for (const check of ['env', 'timeout', 'bash', 'cat'] as const) {
    it(`names ${BEE_BRIDGE_BINARIES[check]} when it is missing`, () => {
      const verdict = beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ missing: [check] }));
      assert.equal(verdict.failed, check);
      assert.equal(verdict.binaries[check], false);
    });
  }

  it('names the first missing path when several are missing', () => {
    assert.equal(beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ missing: ['cat', 'timeout'] })).failed, 'timeout');
  });

  it('names /dev/tcp when bash answers that it has none, or answers anything else', () => {
    assert.equal(beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ devTcp: 'missing' })).failed, 'dev_tcp');
    assert.equal(beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ devTcp: 'unexpected' })).failed, 'dev_tcp');
  });

  it('does not ask about /dev/tcp in an image with no bash, and names bash', () => {
    const verdict = beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ missing: ['bash'] }));
    assert.equal(verdict.failed, 'bash');
    assert.equal(verdict.devTcp, 'not_run');
  });

  for (const [name, output] of [
    ['nothing', ''],
    ['no final line', syntheticBeeBridgeCheckAnswer().replace(/bee-bridge-check done\n$/, '')],
    ['a line it does not know', `${syntheticBeeBridgeCheckAnswer()}Connection refused by 10.0.0.7\n`],
    ['bash\'s own words', syntheticBeeBridgeCheckAnswer().replace('dev_tcp refused', '/bin/bash: connect: Connection refused')],
    ['a path twice', syntheticBeeBridgeCheckAnswer().replace('binary /usr/bin/cat present', 'binary /usr/bin/env present')],
    ['a path it never asked about', syntheticBeeBridgeCheckAnswer().replace('/usr/bin/cat', '/usr/bin/whoami')],
    ['a /dev/tcp answer without bash', syntheticBeeBridgeCheckAnswer({ missing: ['bash'] }).replace('bee-bridge-check done', 'bee-bridge-check dev_tcp refused\nbee-bridge-check done')],
    ['a bash with no /dev/tcp answer', syntheticBeeBridgeCheckAnswer().replace('bee-bridge-check dev_tcp refused\n', '')],
  ] as const) {
    it(`calls an answer with ${name} unreadable`, () => {
      assert.equal(beeBridgeCheckVerdict(output).failed, 'answer', output);
    });
  }
});

describe('the evidence a check leaves', () => {
  it('records the tuple and what was found, never the container\'s own words, with a digest of exactly that', () => {
    const verdict = beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer({ devTcp: 'missing' }));
    const evidence = beeBridgeCheckEvidence(tuple(), verdict);
    assert.deepEqual(evidence.evidence, { ...tuple(), harnessRevision: BEE_BRIDGE_CHECK_REVISION,
      binaries: { '/usr/bin/env': 'present', '/usr/bin/timeout': 'present', '/bin/bash': 'present', '/usr/bin/cat': 'present' }, devTcp: 'missing' });
    assert.match(evidence.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(beeBridgeCheckEvidence(tuple(), verdict).digest, evidence.digest, 'the same observation gives the same digest');
    assert.notEqual(beeBridgeCheckEvidence({ ...tuple(), engineVersion: '29.1.4' }, verdict).digest, evidence.digest);
    assert.notEqual(beeBridgeCheckEvidence(tuple(), beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer())).digest, evidence.digest);
  });
});
