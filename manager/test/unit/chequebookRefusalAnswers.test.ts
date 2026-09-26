/**
 * Every reason the manager refuses to prepare a transfer reaches the answer.
 *
 * Each case drives the production composition behind the real router and error
 * handler, breaks exactly one thing on the way to the node or the chain, and
 * reads the 503 back over HTTP: the cause the page keys its sentence on, the
 * failed bridge check where there is one, and the sentence itself. Nothing is
 * admitted and nothing is sent in any of them, and no answer carries upstream
 * text, an endpoint or a socket path.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import express from 'express';
import pg from 'pg';
import { chequebookRefusalSentence, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME,
  type BeeBridgeCheck, type ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { createChequebookOperationsService, type ChequebookServiceDependencies } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import { ChequebookTargetChangedError } from '../../src/domain/errors/ChequebookTargetChangedError.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { fakeForwardHarness, remoteLocator } from '../support/sshForwardLifecycle.js';
import { syntheticContainerId, syntheticContainerInspect, syntheticDockerBee, syntheticTarget,
  type SyntheticBeeHandler, type SyntheticDockerAnswer } from '../support/syntheticDockerBee.js';

const localTransports = () => JSON.stringify({ [syntheticTarget.alias]: {
  locator: { kind: 'unix', alias: syntheticTarget.alias, socketPath: '/synthetic/docker.sock' }, qualificationIds: ['synthetic-only'] } });
const remoteTransports = () => JSON.stringify({ [syntheticTarget.alias]: { locator: remoteLocator(), qualificationIds: ['synthetic-only'] } });
const configuredChain = '{"100":"https://rpc.example.invalid/private-token"}';

function chainReader(overrides: Partial<ChequebookChainReader> = {}): ChequebookChainReader {
  return { async chainId() { return 100; }, async transactionCount() { return '8'; }, async transaction() { return null; },
    async receipt() { return null; }, async blockTransactions() { return null; },
    async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; }, ...overrides };
}

interface Breakage {
  readonly runtime?: { readonly rpcEndpoints?: string; readonly dockerTransports?: string; readonly dockerHost?: string };
  readonly dependencies?: (fixture: ReturnType<typeof syntheticDockerBee>) => Partial<ChequebookServiceDependencies>;
  readonly bee?: SyntheticBeeHandler;
  readonly docker?: SyntheticDockerAnswer;
}

async function refusedDeposit(t: TestContext, breakage: Breakage) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
  const fixture = syntheticDockerBee(t, breakage.bee, false, breakage.docker);
  const repository = new InMemoryChequebookOperations();
  const service = createChequebookOperationsService(pool, { rpcEndpoints: configuredChain, dockerTransports: localTransports(), ...breakage.runtime }, {
    repository, qualificationCatalog: [qualifiedBridge()], captureTarget: async () => structuredClone(syntheticTarget),
    createChainReader: () => chainReader(), connectUnix: () => ({ stream: fixture.transport, connected: Promise.resolve() }),
    preparation: { cleanupGraceMs: 20, timeoutMs: 3000 }, ...breakage.dependencies?.(fixture),
  });
  t.after(() => service.shutdown());
  const app = express();
  app.use(express.json());
  app.use(createRequireSession({ sessionFor: async () => ({ user: { id: 7, username: 'operator', isAdmin: false }, tokenHash: 'synthetic-hash',
    expiresAt: new Date(Date.now() + 60_000) }) } as unknown as AuthService));
  app.use(createChequebookRouter({} as ChequebookService, service), errorHandler);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const intent = transferIntent();
  const response = await fetch(`http://127.0.0.1:${address.port}/profiles/${intent.profileName}/chequebook/deposit`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=synthetic-session`, [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify({ requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7, amount: intent.amountPlur }),
    signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text, repository, fixture };
}

function assertRefused(answer: Awaited<ReturnType<typeof refusedDeposit>>, cause: ChequebookRefusalCause, check: BeeBridgeCheck | null = null) {
  assert.equal(answer.status, 503, answer.text);
  assert.deepEqual(answer.body, { error: 'chequebook_preparation_unavailable', cause, check, message: chequebookRefusalSentence({ cause, check }) });
  assert.equal(answer.repository.rows.size, 0, 'nothing was admitted');
  assert.equal(answer.fixture.counts().posts, 0, 'nothing was sent');
  for (const secret of ['rpc.example.invalid', 'private', '/synthetic', 'ECONNREFUSED', 'example.invalid']) {
    assert.equal(answer.text.includes(secret), false, `the answer carries no ${secret}`);
  }
}

const refuseContainerList = (containers: unknown[]): SyntheticDockerAnswer => path => path === '/containers/json' ? { body: containers } : undefined;
const inspectWith = (change: (inspect: ReturnType<typeof syntheticContainerInspect>) => void): SyntheticDockerAnswer => path => {
  if (path !== `/containers/${syntheticContainerId}/json`) return undefined;
  const inspect = syntheticContainerInspect(); change(inspect); return { body: inspect };
};
const beeAnswers = (url: string, status: number, body: unknown): SyntheticBeeHandler => (request, response) => {
  if (request.url !== url) return false;
  response.statusCode = status; response.end(JSON.stringify(body)); return true;
};

function remoteForward(fixture: ReturnType<typeof syntheticDockerBee>): Partial<ChequebookServiceDependencies> {
  const remote = fakeForwardHarness();
  remote.dependencies.clock = { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } };
  remote.dependencies.connect = () => ({ stream: fixture.transport, connected: Promise.resolve() });
  remote.dependencies.acquire = acquireDockerBeeStream;
  return { ssh: remote.dependencies };
}

describe('a refused transfer names its cause in the answer', { timeout: 20_000 }, () => {
  it('Docker unreachable: the local socket refused the connection', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ connectUnix: () => {
      const stream = new PassThrough(); stream.destroy();
      return { stream, connected: Promise.reject(new Error('connect ECONNREFUSED /synthetic/docker.sock')) };
    } }) }), 'docker_unreachable');
  });

  it('Docker setting invalid: CHEQUEBOOK_DOCKER_TRANSPORTS does not parse', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { dockerTransports: '{broken' } }), 'docker_setting_invalid');
  });

  it('Docker route missing: a host written as user@host names no Host block, and nothing is configured for it', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { dockerTransports: undefined },
      dependencies: () => ({ captureTarget: async () => ({ ...structuredClone(syntheticTarget), alias: 'deploy@bee-eu-1' }) }) }), 'docker_route_missing');
  });

  it('Docker route missing: DOCKER_HOST reaches the local Docker some other way than a socket', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { dockerTransports: undefined, dockerHost: 'tcp://127.0.0.1:2375' },
      dependencies: () => ({ captureTarget: async () => ({ ...structuredClone(syntheticTarget), alias: 'localhost' }) }) }), 'docker_route_missing');
  });

  it('Bee container not found: Docker lists no running container for the deployment', async t => {
    assertRefused(await refusedDeposit(t, { docker: refuseContainerList([]) }), 'bee_container_not_found');
  });

  it('Bee container not found reaches the answer through the ssh path too', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { dockerTransports: remoteTransports() }, docker: refuseContainerList([]),
      dependencies: remoteForward }), 'bee_container_not_found');
  });

  it('Bee container unsupported: it publishes its API on another port than the reserved one', async t => {
    assertRefused(await refusedDeposit(t, { docker: inspectWith(inspect => {
      inspect.NetworkSettings.Ports['1633/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '11634' }];
    }) }), 'bee_container_unsupported');
  });

  it('Bee container unsupported: it runs on the host network', async t => {
    assertRefused(await refusedDeposit(t, { docker: inspectWith(inspect => { inspect.HostConfig.NetworkMode = 'host'; }) }), 'bee_container_unsupported');
  });

  it('bridge not qualified: the pinned qualification ids match no image the host runs', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ qualificationCatalog: [{ ...qualifiedBridge(), engineVersion: '29.1.4' }] }) }),
      'bridge_not_qualified', null);
  });

  it('target changed: the deployment is not in a state a transfer can own', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ captureTarget: async () => { throw new ChequebookTargetChangedError(); } }) }), 'target_changed');
  });

  it('target changed: the Docker it reached is another daemon than the verified one', async t => {
    assertRefused(await refusedDeposit(t, { docker: path => path === '/info' ? { body: { ID: 'another-daemon', ServerVersion: '29.1.3' } } : undefined }),
      'target_changed');
  });

  it('Bee unreadable: the node answers its wallet with an error', async t => {
    assertRefused(await refusedDeposit(t, { bee: beeAnswers('/wallet', 500, { message: 'private upstream diagnostic' }) }), 'bee_unreadable');
  });

  it('unsupported chain: the node runs on a chain with no pinned BZZ token', async t => {
    assertRefused(await refusedDeposit(t, { bee: beeAnswers('/wallet', 200, { chainID: 31337, walletAddress: transferContext.nodeAddress,
      chequebookContractAddress: transferContext.chequebookAddress, bzzBalance: '1', nativeTokenBalance: '1' }) }), 'unsupported_chain');
  });

  it('chain setting invalid: CHEQUEBOOK_RPC_ENDPOINTS does not parse', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { rpcEndpoints: '{broken' } }), 'chain_setting_invalid');
  });

  it('chain endpoint missing: nothing is configured for the node\'s chain and the node was started without one', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { rpcEndpoints: '{"1":"https://rpc.example.invalid"}' },
      docker: inspectWith(inspect => { inspect.Config.Cmd = ['start', '--full-node=false']; }) }), 'chain_endpoint_missing');
  });

  it('wrong chain: the endpoint the node was started with answers for another chain', async t => {
    assertRefused(await refusedDeposit(t, { runtime: { rpcEndpoints: undefined },
      dependencies: () => ({ createChainReader: () => chainReader({ async chainId() { return 1; } }) }) }), 'wrong_chain');
  });

  it('chain unreachable: the endpoint does not answer', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ createChainReader: () => chainReader({
      async chainId() { throw new Error('fetch failed https://rpc.example.invalid/private-token'); } }) }) }), 'chain_unreachable');
  });

  it('wrong chain: the endpoint answers for another chain than the node\'s', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ createChainReader: () => chainReader({ async chainId() { return 1; } }) }) }), 'wrong_chain');
  });

  it('unavailable: a failure nothing classified still answers a fixed sentence', async t => {
    assertRefused(await refusedDeposit(t, { dependencies: () => ({ captureTarget: async () => { throw new Error('private synthetic driver diagnostic'); } }) }),
      'unavailable');
  });
});
