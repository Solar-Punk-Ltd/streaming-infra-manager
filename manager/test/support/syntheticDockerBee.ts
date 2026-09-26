import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { Duplex, PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import { isDeepStrictEqual } from 'node:util';
import { beeBridgeCheckCommand } from '../../src/domain/chequebook/beeBridgeCheck.js';
import { syntheticBeeBridgeCheckAnswer } from './beeBridgeCheckAnswer.js';
import { profileInstanceId, transactionHash, transferContext } from './chequebookOperations.js';

export const syntheticImageId = `sha256:${'d'.repeat(64)}`;
export const syntheticTarget: FrozenChequebookTarget = {
  version: 1, alias: 'synthetic-host', daemonId: 'synthetic-daemon', verifiedAt: '2026-09-09T00:00:00.000001Z',
  profile: { name: 'test-deployment', instanceId: profileInstanceId, intentRevision: 1, engineConfigRevision: 1,
    kind: 'bee', components: null, host: 'synthetic-host', portSlot: 1, stackVersionId: 1, status: 'RUNNING' },
  reservation: { id: 1, protocol: 'tcp', port: 11633, service: 'bee-uploader', portVar: 'BEE_UPLOADER_API_PORT' },
};
export const syntheticContainerId = 'a'.repeat(64);
const containerId = syntheticContainerId;
const execId = 'c'.repeat(64);
const labels = { 'com.docker.compose.project': syntheticTarget.profile.name, 'com.docker.compose.service': 'bee-uploader' };
/** The chain endpoint the synthetic Bee container was started with, as the stack's compose file passes it. */
export const syntheticNodeChainEndpoint = 'https://node-rpc.example.invalid/synthetic-node-key';
/** What the fixture answers for the Bee container's inspect, for a test that changes one field of it. */
export const syntheticContainerInspect = () => ({ Id: containerId, Image: syntheticImageId,
  Config: { Labels: { ...labels }, Cmd: ['start', '--api-addr=:1633', '--p2p-addr=:1634', `--blockchain-rpc-endpoint=${syntheticNodeChainEndpoint}`,
    '--full-node=false', '--swap-enable=true'] },
  State: { Running: true, Paused: false, Restarting: false, Dead: false }, HostConfig: { NetworkMode: 'test-deployment_default' },
  NetworkSettings: { Ports: { '1633/tcp': [{ HostIp: '0.0.0.0', HostPort: '11633' }] } } });
export type SyntheticBeeHandler = (request: http.IncomingMessage, response: http.ServerResponse) => boolean;
/** Replaces one Docker answer by path. Undefined keeps the fixture's own. */
export type SyntheticDockerAnswer = (path: string) => { readonly status?: number; readonly body: unknown } | undefined;

/** What the synthetic Docker answers the bridge check's exec with, and where it writes what happened, in order, across fixtures. */
export interface SyntheticDockerExtras {
  readonly checkAnswer?: string;
  readonly log?: string[];
}
const checkExecId = 'e'.repeat(64);
const isCheckCommand = (cmd: unknown) => Array.isArray(cmd) && isDeepStrictEqual(cmd, [...beeBridgeCheckCommand()]);

/**
 * Docker upgrade and Bee HTTP share only in-memory duplexes. The bridge command
 * is never executed, and the bridge check's exec is answered with framed
 * output of the test's choosing.
 */
export function syntheticDockerBee(t: TestContext, intercept?: SyntheticBeeHandler, guardNetwork = true, answer?: SyntheticDockerAnswer,
  extras: SyntheticDockerExtras = {}) {
  const inbound = new PassThrough(); const outbound = new PassThrough();
  const transport = Duplex.from({ readable: inbound, writable: outbound });
  const peer = Duplex.from({ readable: outbound, writable: inbound });
  const log = extras.log ?? [];
  const dockerRequests: { method: string; url: string; exec?: 'check' | 'bridge' }[] = [];
  const beeRequests: { method: string; url: string }[] = [];
  let networkCalls = 0; let closes = 0;
  const forbidden = () => { networkCalls++; throw new Error('No network acquisition allowed in synthetic fixture'); };
  if (guardNetwork) {
    t.mock.method(net, 'createConnection', forbidden); t.mock.method(net, 'connect', forbidden); syncBuiltinESMExports();
  }
  transport.on('close', () => { closes++; }); transport.on('error', () => {}); peer.on('error', () => {});
  const bee = http.createServer((request, response) => {
    beeRequests.push({ method: request.method!, url: request.url! });
    log.push(`bee ${request.method} ${request.url}`);
    if (intercept?.(request, response)) return;
    const result = request.method === 'POST' ? { transactionHash } : request.url === '/addresses' ? { ethereum: transferContext.nodeAddress } :
      request.url === '/wallet' ? { chainID: 100, walletAddress: transferContext.nodeAddress,
        chequebookContractAddress: transferContext.chequebookAddress, bzzBalance: '10000000000000000', nativeTokenBalance: '1' } :
      request.url === '/chequebook/address' ? { chequebookAddress: transferContext.chequebookAddress } :
      { totalBalance: '10000000000000000', availableBalance: '10000000000000000' };
    response.end(JSON.stringify(result));
  });
  bee.keepAliveTimeout = 0; bee.headersTimeout = 0; bee.requestTimeout = 0;
  const docker = http.createServer((request, response) => {
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url!, 'http://docker.invalid').pathname;
      let exec: 'check' | 'bridge' | undefined;
      if (path.endsWith('/exec')) exec = isCheckCommand(JSON.parse(Buffer.concat(body).toString('utf8') || '{}').Cmd) ? 'check' : 'bridge';
      dockerRequests.push({ method: request.method!, url: request.url!, ...(exec ? { exec } : {}) });
      log.push(exec ? `docker exec ${exec}` : `docker ${request.method} ${path}`);
      const replaced = answer?.(path);
      if (replaced) { response.statusCode = replaced.status ?? 200; response.end(JSON.stringify(replaced.body)); return; }
      response.statusCode = path.endsWith('/exec') ? 201 : 200;
      response.end(JSON.stringify(path === '/info' ? { ID: syntheticTarget.daemonId, ServerVersion: '29.1.3' } : path === '/containers/json' ? [{ Id: containerId, Labels: labels }] :
        path.startsWith('/images/') ? { Id: syntheticImageId, Os: 'linux', Architecture: 'amd64' } :
        exec ? { Id: exec === 'check' ? checkExecId : execId } : syntheticContainerInspect()));
    });
  });
  docker.keepAliveTimeout = 0; docker.headersTimeout = 0; docker.requestTimeout = 0;
  docker.on('upgrade', (request, socket, head) => {
    let buffered = head;
    const start = (chunk?: Buffer) => {
      if (chunk) buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < Number(request.headers['content-length'])) return;
      socket.removeListener('data', start);
      dockerRequests.push({ method: request.method!, url: request.url! });
      if (request.url === `/exec/${checkExecId}/start`) {
        log.push('docker start check');
        const answered = Buffer.from(extras.checkAnswer ?? syntheticBeeBridgeCheckAnswer(), 'utf8');
        const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(answered.length, 4);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
        socket.end(answered.length ? Buffer.concat([header, answered]) : undefined);
        return;
      }
      log.push('docker start bridge');
      const beePeer = new Duplex({
        read() { socket.resume(); },
        write(chunk: Buffer, _encoding, callback) {
          const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(chunk.length, 4);
          socket.write(Buffer.concat([header, chunk]), callback);
        },
        destroy(error, callback) { socket.destroy(); callback(error); },
      });
      beePeer.on('error', () => {});
      socket.on('data', (bytes: Buffer) => { if (!beePeer.push(bytes)) socket.pause(); });
      socket.on('end', () => beePeer.push(null)); socket.on('close', () => beePeer.destroy());
      bee.emit('connection', beePeer);
      t.after(() => beePeer.destroy());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    };
    socket.on('data', start); start();
  });
  docker.emit('connection', peer);
  t.after(() => { transport.destroy(); peer.destroy(); docker.close(); bee.close(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { transport, peer, dockerRequests, beeRequests, counts: () => ({ networkCalls, closes, posts: beeRequests.filter(request => request.method === 'POST').length }) };
}

/** A Docker socket that answers any number of connections, each served by a fresh synthetic Docker and Bee. */
export function syntheticDockerHost(t: TestContext, intercept?: SyntheticBeeHandler, answer?: SyntheticDockerAnswer, extras: SyntheticDockerExtras = {}) {
  const fixtures: ReturnType<typeof syntheticDockerBee>[] = [];
  return {
    fixtures,
    connect: () => {
      const fixture = syntheticDockerBee(t, intercept, false, answer, extras);
      fixtures.push(fixture);
      return { stream: fixture.transport as Duplex, connected: Promise.resolve() };
    },
    posts: () => fixtures.reduce((total, fixture) => total + fixture.counts().posts, 0),
    dockerRequests: () => fixtures.flatMap(fixture => fixture.dockerRequests),
    beeRequests: () => fixtures.flatMap(fixture => fixture.beeRequests),
  };
}
