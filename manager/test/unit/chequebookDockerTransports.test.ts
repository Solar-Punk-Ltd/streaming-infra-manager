import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookDockerTransports } from '../../src/domain/chequebook/ChequebookDockerTransports.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import { DOCKER_BEE_STREAM_BOUNDS } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { ChequebookConfigurationError } from '../../src/domain/errors/ChequebookConfigurationError.js';
import { localDockerSocketPath } from '../../src/domain/chequebook/ChequebookDockerTransports.js';
import { PRODUCTION_BEE_BRIDGE_QUALIFICATIONS } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { remoteLocator } from '../support/sshForwardLifecycle.js';
import { syntheticImageId } from '../support/syntheticDockerBee.js';

const local = () => ({ localhost: { locator: { kind: 'unix', alias: 'localhost', socketPath: '/synthetic/docker.sock' }, qualificationIds: ['synthetic-only'] } });

it('does not parse malformed transport configuration until acquisition selects an alias', () => {
  for (const input of ['{broken', 'null', '[]', JSON.stringify(local())]) {
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
  assert.deepEqual(registry.select('another-alias').locator, { kind: 'ssh-config', alias: 'another-alias', remoteSocketPath: '/var/run/docker.sock' },
    'an alias the configuration does not name gets the default route');
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

const refusedAs = (cause: string) => (error: unknown) => {
  assert.ok(error instanceof ChequebookConfigurationError); assert.equal(error.refusal.cause, cause); return true;
};
const seedExecution = () => { const seed = PRODUCTION_BEE_BRIDGE_QUALIFICATIONS[0]!;
  return { imageId: seed.imageId, engineVersion: seed.engineVersion, platform: { ...seed.platform }, bridgeRevision: seed.bridgeRevision,
    bridgeLifetimeSeconds: 220, cleanupGraceMs: 5000, streamBounds: DOCKER_BEE_STREAM_BOUNDS }; };

describe('the Docker connection a transfer uses when nothing is configured for its host', () => {
  it('uses the manager\'s own local socket for localhost', () => {
    for (const configuration of [undefined, '', JSON.stringify({ 'bee-eu-1': { locator: remoteLocator(), qualificationIds: ['synthetic-only'] } })]) {
      const selected = new ChequebookDockerTransports(configuration, [qualifiedBridge()]).select('localhost');
      assert.deepEqual(selected.locator, { kind: 'unix', alias: 'localhost', socketPath: '/var/run/docker.sock' });
      assert.ok(Object.isFrozen(selected.locator));
    }
  });

  it('follows DOCKER_HOST to another local socket, as the manager\'s own Docker client does', () => {
    const selected = new ChequebookDockerTransports(undefined, undefined, { localSocketPath: '/run/user/1000/docker.sock' }).select('localhost');
    assert.deepEqual(selected.locator, { kind: 'unix', alias: 'localhost', socketPath: '/run/user/1000/docker.sock' });
    assert.throws(() => new ChequebookDockerTransports(undefined, undefined, { localSocketPath: null }).select('localhost'), refusedAs('docker_route_missing'));
  });

  it('forwards a remote host\'s Docker socket through the manager\'s ssh configuration for its alias', () => {
    assert.deepEqual(new ChequebookDockerTransports(undefined).select('bee-eu-1').locator, { kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: '/var/run/docker.sock' });
  });

  it('refuses a host written as user@host, which names no Host block', () => {
    assert.throws(() => new ChequebookDockerTransports(undefined).select('deploy@bee-eu-1'), refusedAs('docker_route_missing'));
  });

  it('qualifies the default route with the whole catalog', () => {
    assert.equal(new ChequebookDockerTransports(undefined).select('bee-eu-1').qualify(seedExecution()), true);
    assert.equal(new ChequebookDockerTransports(undefined).select('localhost').qualify({ ...seedExecution(), engineVersion: '29.1.4' }), false);
  });

  it('lets a configured entry win for the alias it names, in its current format', () => {
    const configuration = JSON.stringify({ localhost: { locator: { kind: 'unix', alias: 'localhost', socketPath: '/srv/docker.sock' }, qualificationIds: ['synthetic-only'] } });
    assert.deepEqual(new ChequebookDockerTransports(configuration, [qualifiedBridge()]).select('localhost').locator,
      { kind: 'unix', alias: 'localhost', socketPath: '/srv/docker.sock' });
  });

  it('accepts a configured ssh-config entry that names another remote socket, and nothing more', () => {
    const entry = (locator: unknown) => JSON.stringify({ 'bee-eu-1': { locator, qualificationIds: ['synthetic-only'] } });
    assert.deepEqual(new ChequebookDockerTransports(entry({ kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: '/run/docker.sock' }), [qualifiedBridge()])
      .select('bee-eu-1').locator, { kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: '/run/docker.sock' });
    for (const locator of [{ kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: '/run/docker.sock', host: 'bee.example.invalid' },
      { kind: 'ssh-config', alias: 'bee-eu-2', remoteSocketPath: '/run/docker.sock' }, { kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: 'docker.sock' }]) {
      assert.throws(() => new ChequebookDockerTransports(entry(locator), [qualifiedBridge()]).select('bee-eu-1'), refusedAs('docker_setting_invalid'));
    }
  });

  it('refuses every alias while the configuration does not parse, rather than guess which it would have named', () => {
    for (const alias of ['localhost', 'bee-eu-1']) assert.throws(() => new ChequebookDockerTransports('{broken').select(alias), refusedAs('docker_setting_invalid'));
  });
});

describe('the local Docker socket the manager\'s own client uses', () => {
  it('reads DOCKER_HOST the way the Docker client library does, for a Unix socket', () => {
    assert.equal(localDockerSocketPath(undefined), '/var/run/docker.sock');
    assert.equal(localDockerSocketPath(''), '/var/run/docker.sock');
    assert.equal(localDockerSocketPath('unix://'), '/var/run/docker.sock');
    assert.equal(localDockerSocketPath('unix:///run/user/1000/docker.sock'), '/run/user/1000/docker.sock');
  });

  it('answers none for a Docker reached any other way, which a transfer cannot own as a socket', () => {
    for (const value of ['tcp://127.0.0.1:2375', 'ssh://deploy@bee-eu-1', 'npipe:////./pipe/docker_engine', 'localhost:2375', 'unix://relative.sock']) {
      assert.equal(localDockerSocketPath(value), null, value);
    }
  });
});
