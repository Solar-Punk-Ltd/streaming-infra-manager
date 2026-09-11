import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ChequebookDockerTransports } from '../../src/domain/chequebook/ChequebookDockerTransports.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import { DOCKER_BEE_STREAM_BOUNDS } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { remoteLocator } from '../support/sshForwardLifecycle.js';
import { syntheticImageId } from '../support/syntheticDockerBee.js';

const local = () => ({ localhost: { locator: { kind: 'unix', alias: 'localhost', socketPath: '/synthetic/docker.sock' }, qualificationIds: ['synthetic-only'] } });

it('does not parse missing or malformed transport configuration until acquisition selects an alias', () => {
  for (const input of [undefined, '', '{broken', 'null', '[]', JSON.stringify(local())]) {
    const registry = new ChequebookDockerTransports(input);
    assert.throws(() => registry.select('localhost'), { name: 'ChequebookConfigurationError', message: 'Invalid runtime chequebook configuration.' });
  }
});

it('selects only a complete compiled qualification and a frozen exact local locator', () => {
  const registry = new ChequebookDockerTransports(JSON.stringify(local()), [qualifiedBridge()]);
  const selected = registry.select('localhost');
  assert.deepEqual(selected.locator, local().localhost.locator); assert.ok(Object.isFrozen(selected.locator));
  const execution = { imageId: syntheticImageId, engineVersion: '29.1.3', platform: qualifiedBridge().platform,
    bridgeRevision: DOCKER_BEE_BRIDGE_REVISION, bridgeLifetimeSeconds: 220, cleanupGraceMs: 5000, streamBounds: DOCKER_BEE_STREAM_BOUNDS };
  assert.equal(selected.qualify(execution), true); assert.equal(selected.qualify({ ...execution, engineVersion: '29.1.4' }), false);
  assert.throws(() => registry.select('another-alias'));
});

it('reuses strict SSH locator validation without accepting an executable, config file, proxy or arbitrary options', () => {
  const locator = remoteLocator(); const configuration = { [locator.alias]: { locator, qualificationIds: ['synthetic-only'] } };
  assert.deepEqual(new ChequebookDockerTransports(JSON.stringify(configuration), [qualifiedBridge()]).select(locator.alias).locator, locator);
  for (const additional of [{ command: 'synthetic' }, { ProxyCommand: 'synthetic' }, { sshConfig: '/synthetic/config' }, { args: [] }]) {
    const changed = { [locator.alias]: { locator: { ...locator, ...additional }, qualificationIds: ['synthetic-only'] } };
    assert.throws(() => new ChequebookDockerTransports(JSON.stringify(changed), [qualifiedBridge()]).select(locator.alias), { name: 'ChequebookConfigurationError' });
  }
});

for (const [name, change] of [
  ['mismatched alias', (input: any) => { input.localhost.locator.alias = 'elsewhere'; }],
  ['relative socket', (input: any) => { input.localhost.locator.socketPath = 'docker.sock'; }],
  ['NUL socket', (input: any) => { input.localhost.locator.socketPath = '/synthetic/a\0b'; }],
  ['URL fallback', (input: any) => { input.localhost.locator.socketPath = 'http://bee.invalid'; }],
  ['endpoint override', (input: any) => { input.localhost.locator.url = 'http://bee.invalid'; }],
  ['qualification object', (input: any) => { input.localhost.qualificationIds = [qualifiedBridge()]; }],
  ['no qualification', (input: any) => { input.localhost.qualificationIds = []; }],
  ['unknown qualification', (input: any) => { input.localhost.qualificationIds = ['another']; }],
  ['partly unknown qualification', (input: any) => { input.localhost.qualificationIds = ['synthetic-only', 'another']; }],
  ['duplicate qualification', (input: any) => { input.localhost.qualificationIds = ['synthetic-only', 'synthetic-only']; }],
  ['unrecognised entry option', (input: any) => { input.localhost.insecure = true; }],
] as const) it(`refuses ${name} with a fixed error`, () => {
  const input = local(); change(input);
  const registry = new ChequebookDockerTransports(JSON.stringify(input), [qualifiedBridge()]);
  assert.throws(() => registry.select('localhost'), { name: 'ChequebookConfigurationError', message: 'Invalid runtime chequebook configuration.' });
});

it('captures the trusted catalog before delayed selection and bounds runtime configuration size', () => {
  const record = qualifiedBridge(); const registry = new ChequebookDockerTransports(JSON.stringify(local()), [record]);
  Object.assign(record, { imageId: `sha256:${'e'.repeat(64)}` });
  assert.equal(registry.select('localhost').qualify({ imageId: syntheticImageId, engineVersion: '29.1.3', platform: record.platform,
    bridgeRevision: DOCKER_BEE_BRIDGE_REVISION, bridgeLifetimeSeconds: 220, cleanupGraceMs: 5000, streamBounds: DOCKER_BEE_STREAM_BOUNDS }), true);
  assert.throws(() => new ChequebookDockerTransports(' '.repeat(65537), [qualifiedBridge()]).select('localhost'));
});
