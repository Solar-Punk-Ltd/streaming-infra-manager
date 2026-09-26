/**
 * With CHEQUEBOOK_DOCKER_TRANSPORTS unset, a transfer reaches Docker the way
 * the manager already does for that host: its own local socket for localhost,
 * following DOCKER_HOST as its Docker client does, and for a remote alias a
 * forward of the remote socket through the manager's ssh configuration.
 */
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import pg from 'pg';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { createChequebookOperationsService, type ChequebookServiceDependencies } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import type { SshDockerForwardCommand } from '../../src/domain/chequebook/sshDockerForwardCommand.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { fakeForwardHarness } from '../support/sshForwardLifecycle.js';
import { syntheticDockerBee, syntheticTarget } from '../support/syntheticDockerBee.js';

const chainReader = { async chainId() { return 100; }, async transactionCount() { return '8'; }, async transaction() { return null; },
  async receipt() { return null; }, async blockTransactions() { return null; },
  async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; } };
const targetOn = (alias: string, host: string | null): FrozenChequebookTarget =>
  ({ ...structuredClone(syntheticTarget), alias, profile: { ...structuredClone(syntheticTarget.profile), host } });

function unconfigured(t: TestContext, target: FrozenChequebookTarget, dockerHost: string | undefined, extra: Partial<ChequebookServiceDependencies> = {}) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
  const fixture = syntheticDockerBee(t);
  const socketPaths: string[] = [];
  const service = createChequebookOperationsService(pool, { rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: undefined, dockerHost }, {
    repository: new InMemoryChequebookOperations(), qualificationCatalog: [qualifiedBridge()], captureTarget: async () => target,
    createChainReader: () => chainReader, preparation: { cleanupGraceMs: 20, timeoutMs: 3000 },
    connectUnix: path => { socketPaths.push(path); return { stream: fixture.transport, connected: Promise.resolve() }; }, ...extra,
  });
  t.after(() => service.shutdown());
  return { service, fixture, socketPaths };
}

it('reaches localhost through the manager\'s own Docker socket when nothing is configured', async t => {
  const h = unconfigured(t, targetOn('localhost', null), undefined);
  assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
  assert.deepEqual(h.socketPaths, ['/var/run/docker.sock']);
  assert.equal(h.fixture.counts().posts, 1);
});

it('follows DOCKER_HOST to the local socket the manager\'s Docker client uses', async t => {
  const h = unconfigured(t, targetOn('localhost', null), 'unix:///run/user/1000/docker.sock');
  assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
  assert.deepEqual(h.socketPaths, ['/run/user/1000/docker.sock']);
});

it('forwards a remote host\'s Docker socket through the manager\'s ssh configuration for its alias', async t => {
  const remote = fakeForwardHarness();
  const commands: SshDockerForwardCommand[] = [];
  const fixture = syntheticDockerBee(t, undefined, false);
  remote.dependencies.clock = { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } };
  remote.dependencies.connect = () => ({ stream: fixture.transport, connected: Promise.resolve() });
  remote.dependencies.acquire = acquireDockerBeeStream;
  const spawn = remote.dependencies.spawn;
  remote.dependencies.spawn = (command, ownership) => { commands.push(command); return spawn(command, ownership); };
  const h = unconfigured(t, targetOn('bee-eu-1', 'bee-eu-1'), undefined, { ssh: remote.dependencies });
  assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]!.target, { kind: 'ssh-config', alias: 'bee-eu-1', remoteSocketPath: '/var/run/docker.sock' });
  assert.deepEqual(commands[0]!.args.slice(-2), ['--', 'bee-eu-1']);
  assert.equal(commands[0]!.args.includes('-F'), false, 'the manager\'s own ssh configuration is read');
  assert.deepEqual(h.socketPaths, [], 'no local socket was opened for a remote host');
  assert.equal(fixture.counts().posts, 1);
});
