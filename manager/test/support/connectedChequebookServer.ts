/**
 * The connected manager as a process the browser suite can drive.
 *
 * It boots the same composition as the connected SQL suite on a loopback port,
 * reports where it listens over IPC, and takes IPC messages that script the
 * synthetic Bee and the synthetic chain. Everything under /chequebook and the
 * two money POSTs is the real router. Everything else it answers is marked as
 * a stub below, because the pages need a shell to load into and none of that
 * shell is what these cases are about.
 *
 * It cleans its schema and its socket directory when the parent disconnects.
 */
import http from 'node:http';
import express, { Router } from 'express';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { CONNECTED_OPERATOR, CONNECTED_OPERATOR_PASSWORD, CONNECTED_PROFILE, connectedChequebookApi, connectedChequebookAuth,
  startConnectedChequebook, type ReceiptAnswer } from './connectedChequebook.js';
import { instanceForProfile } from './chequebookOperations.js';

const LOOPBACK = '127.0.0.1';

export type ConnectedServerCommand =
  | { readonly id: number; readonly kind: 'receipt'; readonly answer: ReceiptAnswer }
  | { readonly id: number; readonly kind: 'drop-next-response' }
  | { readonly id: number; readonly kind: 'counts' };
export interface ConnectedServerReply {
  readonly id: number;
  readonly beePosts: number;
  readonly receiptReads: number;
}
export interface ConnectedServerReady {
  readonly ready: true;
  readonly port: number;
  readonly profileName: string;
  readonly profileInstanceId: string;
  readonly username: string;
  readonly password: string;
}

// Stub. The shape the deployments page reads, with one synthetic deployment in it.
const syntheticProfile = {
  name: CONNECTED_PROFILE, instance_id: instanceForProfile(CONNECTED_PROFILE), kind: 'streamer', status: 'RUNNING', containers: [],
  port_slot: 1, stamp_id: null, engine_settings: {}, has_engine_config: false, engine_config_error: null, engine_config_state: null,
  engine_config_revision: 0, intent_revision: 0, group_id: null, pendingStamp: false, stack_version_id: 1,
  created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
};

// Stub. Synthetic balances so the funding card renders. No node is read.
const syntheticSummary = {
  async summary() {
    return { name: CONNECTED_PROFILE, chequebook: { address: `0x${'22'.repeat(20)}`, totalBalance: '10000000000000000',
      availableBalance: '10000000000000000', totalSent: '0', totalReceived: '0' }, floorBzz: '0.5' };
  },
} as unknown as ChequebookService;

function shellStubs(): Router {
  const router = Router();
  router.get('/config', (_req, res) => { res.json({ host: 'connected-fixture', srtPassphrase: null, chequebookFloorBzz: '0.5' }); });
  router.get('/groups', (_req, res) => { res.json({ groups: [] }); });
  router.get('/versions', (_req, res) => { res.json([]); });
  router.get('/profiles', (_req, res) => { res.json([syntheticProfile]); });
  router.get('/events', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': synthetic connected\n\n');
  });
  router.get('/profiles/:name', (_req, res) => { res.json(syntheticProfile); });
  return router;
}

async function main(): Promise<void> {
  const pgPort = Number(process.env.T09_TEST_PG_PORT);
  if (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535) throw new Error('T09_TEST_PG_PORT is required');
  const backend = await startConnectedChequebook({ pgPort });
  const auth = await connectedChequebookAuth();
  const app = express();
  app.use(connectedChequebookApi(backend.service, auth, { stubs: shellStubs(), chequebookSummary: syntheticSummary }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The connected fixture server reported no port');
  // Behind this port sit the real money routes and a published fixture password.
  if (address.address !== LOOPBACK) throw new Error(`The connected fixture server must bind ${LOOPBACK} and bound ${address.address}`);
  backend.service.start();

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await backend.close();
    process.exit(0);
  };
  process.on('disconnect', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
  process.on('message', (message: ConnectedServerCommand) => {
    if (message.kind === 'receipt') backend.chain.answers(message.answer);
    if (message.kind === 'drop-next-response') backend.dropNextResponse();
    const reply: ConnectedServerReply = { id: message.id, beePosts: backend.beePosts(), receiptReads: backend.chain.receiptReads() };
    process.send?.(reply);
  });
  const ready: ConnectedServerReady = { ready: true, port: address.port, profileName: CONNECTED_PROFILE,
    profileInstanceId: instanceForProfile(CONNECTED_PROFILE), username: CONNECTED_OPERATOR, password: CONNECTED_OPERATOR_PASSWORD };
  process.send?.(ready);
}

main().catch(error => {
  process.send?.({ ready: false, message: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
