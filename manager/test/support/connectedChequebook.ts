/**
 * The production money composition with only its outsides replaced.
 *
 * A disposable PostgreSQL schema, a temporary Unix socket serving the
 * synthetic Docker and Bee fixture, and a scripted chain. Everything between
 * them is what the manager runs: the real repository, the real preparation and
 * transport, the real receipt poller and the real router behind the real
 * session gate. Two callers share it, the connected SQL suite and the forked
 * server the connected browser suite drives.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import express, { type Express, type RequestHandler } from 'express';
import pg, { type Pool } from 'pg';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { ChequebookOperationsService } from '../../src/domain/chequebook/ChequebookOperationsService.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { InMemoryCredentialRepository } from './InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from './InMemorySessionRepository.js';
import { InMemoryUserRepository } from './InMemoryUserRepository.js';
import { instanceForProfile, transferContext } from './chequebookOperations.js';
import { qualifiedBridge } from './qualifiedBeeBridge.js';
import { seedSyntheticChequebookTarget, SyntheticTargetChequebookRepository } from './syntheticChequebookTargets.js';
import { syntheticDockerBee } from './syntheticDockerBee.js';

export const CONNECTED_PROFILE = 'test-deployment';
/** The port the synthetic container publishes, which the SQL reservation has to agree with. */
const PUBLISHED_BEE_PORT = 11633;
export const CONNECTED_OPERATOR = 'connected-operator';
/** A synthetic password for a synthetic in-memory user. It opens nothing outside this process. */
export const CONNECTED_OPERATOR_PASSWORD = 'a-long-enough-synthetic-password';
const START_BLOCK = 500n;
const RECEIPT_BLOCK = 501n;
const CHAIN_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';

export type ReceiptAnswer = 'pending' | 'success' | 'reverted';
const hashAt = (block: bigint) => block === START_BLOCK ? transferContext.startBlockHash : `0x${block.toString(16).padStart(64, '0')}`;

export interface SyntheticChain {
  readonly reader: ChequebookChainReader;
  receiptReads(): number;
  answers(next: ReceiptAnswer): void;
  outage(on: boolean): void;
}

/** One chain, scripted, so a case can say what changed rather than what the chain happened to do. */
export function syntheticChain(): SyntheticChain {
  let answer: ReceiptAnswer = 'pending';
  let available = true;
  let receiptReads = 0;
  const unavailable = (): never => { throw new Error('synthetic-rpc-outage'); };
  const reader: ChequebookChainReader = {
    async chainId() { return available ? 100 : unavailable(); },
    async transactionCount() { return available ? '8' : unavailable(); },
    async blockTransactions() { return available ? null : unavailable(); },
    async blockHeader(block) {
      if (!available) unavailable();
      const number = block === 'finalized' || block === 'latest' ? (answer === 'pending' ? START_BLOCK : RECEIPT_BLOCK) : block;
      return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) };
    },
    async transaction(hash) {
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return { hash, chainId: 100, from: transferContext.nodeAddress, to: CHAIN_TOKEN,
        data: `0xa9059cbb${transferContext.chequebookAddress.slice(2).padStart(64, '0')}${(5000000000000000n).toString(16).padStart(64, '0')}`,
        nonce: '9', value: '0', blockNumber: String(RECEIPT_BLOCK), blockHash: hashAt(RECEIPT_BLOCK) };
    },
    async receipt(hash) {
      receiptReads++;
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return { transactionHash: hash, from: transferContext.nodeAddress, to: CHAIN_TOKEN,
        blockNumber: String(RECEIPT_BLOCK), blockHash: hashAt(RECEIPT_BLOCK), status: answer === 'success' ? 'success' : 'reverted' };
    },
  };
  return { reader, receiptReads: () => receiptReads, answers(next) { answer = next; }, outage(on) { available = !on; } };
}

export interface ConnectedChequebookOptions {
  readonly pgPort: number;
  readonly database?: string;
  readonly dropNextResponse?: boolean;
  readonly receiptPollBudgetMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ConnectedChequebookBackend {
  readonly pool: Pool;
  readonly repository: SyntheticTargetChequebookRepository;
  readonly service: ChequebookOperationsService;
  readonly chain: SyntheticChain;
  readonly directory: string;
  readonly schema: string;
  pollerLines(): readonly string[];
  beePosts(): number;
  beeRequests(): readonly { method: string; url: string }[];
  dropNextResponse(): void;
  close(): Promise<void>;
}

/** syntheticDockerBee only needs somewhere to register cleanup once its network guard is off. */
function cleanupContext(collect: (task: () => void | Promise<void>) => void): TestContext {
  return { after: collect, mock: { restoreAll() {} } } as unknown as TestContext;
}

export async function startConnectedChequebook(options: ConnectedChequebookOptions): Promise<ConnectedChequebookBackend> {
  const connection = { host: '127.0.0.1', port: options.pgPort, user: 'postgres', database: options.database ?? 't09_test', connectionTimeoutMillis: 30000 };
  const schema = `t09c_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...connection, max: 20, options: `-c search_path=${schema}` });
  const migrations = new URL('../../src/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrations), 'utf8'));
  }
  await pool.query('INSERT INTO profiles (name, port_slot, instance_id, stack_version_id) VALUES ($1, 1, $2, 1)',
    [CONNECTED_PROFILE, instanceForProfile(CONNECTED_PROFILE)]);
  await seedSyntheticChequebookTarget(pool, CONNECTED_PROFILE);
  await pool.query('UPDATE port_reservations SET port = $2 WHERE profile_name = $1', [CONNECTED_PROFILE, PUBLISHED_BEE_PORT]);

  const directory = await mkdtemp(join(tmpdir(), 't09-connected-'));
  const socketPath = join(directory, 'docker.sock');
  const fixtureCleanups: (() => void | Promise<void>)[] = [];
  const beeFixtures: ReturnType<typeof syntheticDockerBee>[] = [];
  const connections = new Set<net.Socket>();
  let dropResponse = options.dropNextResponse === true;
  const sockets = net.createServer(socket => {
    const bee = syntheticDockerBee(cleanupContext(task => fixtureCleanups.push(task)), request => {
      if (request.method !== 'POST' || !dropResponse) return false;
      dropResponse = false;
      request.socket.destroy();
      return true;
    }, false);
    beeFixtures.push(bee);
    connections.add(socket);
    socket.on('error', () => {});
    socket.pipe(bee.transport).pipe(socket);
    socket.on('close', () => connections.delete(socket));
    bee.transport.once('close', () => socket.destroy());
  });
  sockets.listen(socketPath);
  await once(sockets, 'listening');
  // The synthetic Bee answers unauthenticated Docker requests, so its only reachable address is this path.
  if (sockets.address() !== socketPath) throw new Error(`The connected fixture must serve its synthetic Docker on ${socketPath}`);
  const directoryMode = (await stat(directory)).mode & 0o777;
  if (directoryMode !== 0o700) throw new Error(`The connected fixture socket directory must stay at 0700 and is ${directoryMode.toString(8)}`);

  const chain = syntheticChain();
  const pollerLines: string[] = [];
  const repository = new SyntheticTargetChequebookRepository(pool, { receiptPollBudgetMs: options.receiptPollBudgetMs });
  const runtime = { rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: JSON.stringify({
    localhost: { locator: { kind: 'unix', alias: 'localhost', socketPath }, qualificationIds: ['synthetic-only'] } }) };
  const service = createChequebookOperationsService(pool, runtime, {
    repository, qualificationCatalog: [qualifiedBridge()], createChainReader: () => chain.reader,
    preparation: { cleanupGraceMs: 20, timeoutMs: 3000 },
    receiptPolling: { intervalMs: options.pollIntervalMs ?? 50, log: { info: line => pollerLines.push(line), warn: line => pollerLines.push(line) } },
  });

  let closed = false;
  return {
    pool, repository, service, chain, directory, schema,
    pollerLines: () => pollerLines,
    beePosts: () => beeFixtures.reduce((total, fixture) => total + fixture.counts().posts, 0),
    beeRequests: () => beeFixtures.flatMap(fixture => fixture.beeRequests),
    dropNextResponse() { dropResponse = true; },
    async close() {
      if (closed) return;
      closed = true;
      await service.shutdown();
      for (const socket of connections) socket.destroy();
      if (sockets.listening) await new Promise<void>(resolve => sockets.close(() => resolve()));
      for (const task of fixtureCleanups.reverse()) await task();
      await rm(directory, { recursive: true, force: true });
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export interface ConnectedChequebookAuth {
  readonly authService: AuthService;
  readonly users: InMemoryUserRepository;
  readonly requireSession: RequestHandler;
  accountId(): Promise<number>;
}

export async function connectedChequebookAuth(): Promise<ConnectedChequebookAuth> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), new OpenStreams());
  await authService.addUser(CONNECTED_OPERATOR, CONNECTED_OPERATOR_PASSWORD);
  return { authService, users, requireSession: createRequireSession(authService),
    accountId: async () => (await users.findByUsername(CONNECTED_OPERATOR))!.id };
}

export interface ConnectedChequebookApiOptions {
  readonly onRequest?: (method: string, path: string) => void;
  /** Everything the pages need that is not money. Mounted behind the session gate, before the money router. */
  readonly stubs?: RequestHandler;
  readonly chequebookSummary?: ChequebookService;
}

/** The manager's own gate order: same-site, then open auth, then a session, then the money routes. */
export function connectedChequebookApi(service: ChequebookOperationsService, auth: ConnectedChequebookAuth,
  options: ConnectedChequebookApiOptions = {}): Express {
  const app = express();
  app.use(requireSameSite, express.json({ limit: '256kb' }));
  if (options.onRequest) app.use((req, _res, next) => { options.onRequest!(req.method, req.path); next(); });
  app.use('/auth', createAuthRouter(auth.authService, auth.requireSession));
  app.use(auth.requireSession);
  if (options.stubs) app.use(options.stubs);
  app.use(createChequebookRouter(options.chequebookSummary ?? ({} as ChequebookService), service), errorHandler);
  return app;
}

export const connectedRequestId = (): string => randomUUID();
