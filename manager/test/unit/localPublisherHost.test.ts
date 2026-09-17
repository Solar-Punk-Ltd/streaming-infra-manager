/**
 * The address a pool string hands an uploader for a node deployed on this host.
 *
 * Unit test, no Docker and no dns: the environment, the in-container check and
 * the lookup are injected, so every shape runs on a laptop.
 *
 * Why the shapes are what they are. T06 binds every local bee API to the docker
 * bridge address and to nothing else, so the manager's public address answers on
 * those ports from nowhere at all, and an uploader is a container on this same
 * host. Inside the api container the bridge is what host.docker.internal resolves
 * to. The name cannot be passed on, because an uploader's compose service carries
 * no extra_hosts and the name resolves nowhere inside it on Linux.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveLocalPublisherHost } from '../../src/domain/localHost.js';

const BRIDGE = '10.200.0.1';
const DOCKER_HOST_NAME = 'host.docker.internal';

function spies() {
  const looked: string[] = [];
  const warnings: string[] = [];
  return {
    looked,
    warnings,
    warn: (message: string) => {
      warnings.push(message);
    },
    answers: async (hostname: string) => {
      looked.push(hostname);
      return BRIDGE;
    },
    fails: async (hostname: string) => {
      looked.push(hostname);
      throw new Error('ENOTFOUND host.docker.internal');
    },
  };
}

describe('resolveLocalPublisherHost', () => {
  it('takes the operator’s override as given, without asking dns', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: { BEE_LOCAL_HOST: '10.42.0.1' },
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, '10.42.0.1');
    assert.deepEqual(spy.looked, []);
  });

  it('resolves an override that names the docker host, since the name reaches no uploader', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: { BEE_LOCAL_HOST: DOCKER_HOST_NAME },
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME]);
  });

  it('answers the bridge address as a literal when the manager runs in a container', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: {},
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME]);
    assert.deepEqual(spy.warnings, []);
  });

  it('falls back to the name and warns once when the lookup fails', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: {},
      isInContainer: () => true,
      lookupIpv4: spy.fails,
      warn: spy.warn,
    });
    assert.equal(host, DOCKER_HOST_NAME);
    assert.equal(spy.warnings.length, 1);
    assert.ok(spy.warnings[0]!.includes(DOCKER_HOST_NAME), spy.warnings[0]);
  });

  it('answers the docker host by name when the manager runs natively', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: {},
      isInContainer: () => false,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, DOCKER_HOST_NAME);
    assert.deepEqual(spy.looked, []);
  });

  it('treats an empty override as no override', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      env: { BEE_LOCAL_HOST: '  ' },
      isInContainer: () => false,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, DOCKER_HOST_NAME);
  });
});
