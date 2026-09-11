import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Duplex, PassThrough, getDefaultHighWaterMark, setDefaultHighWaterMark } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { createBeeBridgeQualifier, DOCKER_BEE_STREAM_BOUNDS, type BeeBridgeExecution } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Long enough for a repeat to have happened, short enough to stay a unit test. */
const REPEAT_WINDOW_MS = 25;
/** Only so a request that never arrives says so instead of hanging until the suite timeout. */
const ARRIVAL_BUDGET_MS = 2_000;
async function until(reached: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + ARRIVAL_BUDGET_MS;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(`waited ${ARRIVAL_BUDGET_MS} ms for ${description} and it never happened`);
    await pause(1);
  }
}
const containerId = 'a'.repeat(64);
const replacementId = 'b'.repeat(64);
const execId = 'c'.repeat(64);
const imageId = `sha256:${'d'.repeat(64)}`;
const expected: FrozenChequebookTarget = {
  version: 1, alias: 'synthetic-host', daemonId: 'synthetic-daemon', verifiedAt: '2026-09-09T00:00:00.000001Z',
  profile: { name: 'synthetic-project', instanceId: '6a715c7e-a4ae-4e86-a18e-8ae5ff193487', intentRevision: 1,
    engineConfigRevision: 1, kind: 'bee', components: null, host: 'synthetic-host', portSlot: 1, stackVersionId: 1, status: 'RUNNING' },
  reservation: { id: 1, protocol: 'tcp', port: 11633, service: 'bee-uploader', portVar: 'BEE_UPLOADER_API_PORT' },
};
const labels = { 'com.docker.compose.project': expected.profile.name, 'com.docker.compose.service': 'bee-uploader' };
const inspection = () => ({ Id: containerId, Image: imageId, Config: { Labels: { ...labels }, Env: ['SYNTHETIC_PRIVATE=do-not-surface'] },
  State: { Running: true, Paused: false, Restarting: false, Dead: false }, HostConfig: { NetworkMode: 'synthetic-project_default' },
  NetworkSettings: { Ports: { '1633/tcp': [{ HostIp: '0.0.0.0', HostPort: '11633' }, { HostIp: '::', HostPort: '11633' }] } } });
const qualified = (execution: BeeBridgeExecution) => execution.imageId === imageId;
function frame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
type DockerRequest = { method: string; url: string; body: unknown; headers: http.IncomingHttpHeaders };
type Stage = 'info' | 'list' | 'inspect' | 'image' | 'create' | 'start';
type FixtureOptions = {
  daemonId?: string; info?: unknown; image?: unknown; candidates?: unknown; inspect?: unknown; execId?: string; initial?: Buffer;
  stopAt?: Stage; holdAt?: Stage; responseAt?: Stage; status?: number; rawJson?: string; declaredLength?: number;
  upgradeStatus?: number; upgradeHeader?: string; afterUpgrade?: () => void; information?: boolean; largeHeader?: boolean;
};
function syntheticDocker(t: TestContext, options: FixtureOptions = {}) {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const transport = Duplex.from({ readable: inbound, writable: outbound });
  const peer = Duplex.from({ readable: outbound, writable: inbound });
  const requests: DockerRequest[] = [];
  const input: Buffer[] = [];
  const held: { response: http.ServerResponse; stage: Stage }[] = [];
  let connects = 0;
  let closes = 0;
  let upgraded = false;
  const forbidden = () => { connects++; throw new Error('Network acquisition forbidden by synthetic fixture'); };
  t.mock.method(net, 'createConnection', forbidden); t.mock.method(net, 'connect', forbidden); syncBuiltinESMExports();
  transport.on('close', () => { closes++; });
  peer.on('error', () => {});
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method!, url: request.url!, body: text ? JSON.parse(text) : null, headers: request.headers });
      const path = new URL(request.url!, 'http://docker.invalid').pathname;
      const stage: Stage = path === '/info' ? 'info' : path === '/containers/json' ? 'list' : path.startsWith('/images/') ? 'image' : path.endsWith('/json') ? 'inspect' : 'create';
      if (options.information) response.writeProcessing();
      if (options.largeHeader) response.setHeader('X-Oversized', 'x'.repeat(20_000));
      if (options.stopAt === stage) { peer.destroy(); return; }
      if (options.holdAt === stage) { held.push({ response, stage }); return; }
      if (options.responseAt === stage) {
        response.statusCode = options.status ?? 200;
        if (options.declaredLength !== undefined) response.setHeader('Content-Length', options.declaredLength);
        response.end(options.rawJson ?? 'synthetic private diagnostic'); return;
      }
      response.statusCode = stage === 'create' ? 201 : 200;
      response.end(JSON.stringify(stage === 'info' ? options.info ?? { ID: options.daemonId ?? expected.daemonId, ServerVersion: '29.1.3' } : stage === 'list'
        ? options.candidates ?? [{ Id: containerId, Labels: labels }] : stage === 'inspect' ? options.inspect ?? inspection() : stage === 'image'
          ? options.image ?? { Id: imageId, Os: 'linux', Architecture: 'amd64' } : { Id: options.execId ?? execId }));
    });
  });
  server.keepAliveTimeout = 0; server.headersTimeout = 0; server.requestTimeout = 0;
  server.on('upgrade', (request, socket, head) => {
    const length = Number(request.headers['content-length']);
    let body = head;
    const receive = (chunk?: Buffer) => {
      if (chunk) body = Buffer.concat([body, chunk]);
      if (body.length < length) return;
      socket.removeListener('data', receive);
      requests.push({ method: request.method!, url: request.url!, body: JSON.parse(body.subarray(0, length).toString('utf8')), headers: request.headers });
      if (options.stopAt === 'start') { peer.destroy(); return; }
      if (options.holdAt === 'start') return;
      if (options.responseAt === 'start') { socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'); return; }
      upgraded = true;
      socket.on('data', chunk => input.push(Buffer.from(chunk)));
      const status = options.upgradeStatus ?? 101;
      const header = `HTTP/1.1 ${status} Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${options.upgradeHeader ?? 'tcp'}\r\n\r\n`;
      socket.write(Buffer.concat([Buffer.from(header), frame(options.initial ?? Buffer.from([0, 255, 128]))]));
      options.afterUpgrade?.();
    };
    socket.on('data', receive); receive();
  });
  server.emit('connection', peer);
  t.after(() => { transport.destroy(); peer.destroy(); server.close(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { transport, peer, requests, input, held, counts: () => ({ connects, closes, upgraded }),
    creates: () => requests.filter(request => request.url.endsWith('/exec')).length,
    starts: () => requests.filter(request => request.url.endsWith('/start')).length };
}
const safeFailure = (error: unknown) => error instanceof Error && error.name === 'DockerBeeAcquisitionError' && error.cause === undefined &&
  !/synthetic|do-not-surface|private diagnostic/.test(error.message);

describe('Docker Bee acquisition over one owned synthetic connection', { timeout: 5000 }, () => {
  for (const info of [{ ID: expected.daemonId }, { ID: expected.daemonId, ServerVersion: '' }, { ID: expected.daemonId, ServerVersion: '29.1.3\nsecret' }]) {
    it(`requires an explicit valid Engine version from the owned info response ${JSON.stringify(info)}`, async t => {
      const docker = syntheticDocker(t, { info });
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, () => true), safeFailure);
      assert.equal(docker.creates(), 0); assert.equal(docker.transport.destroyed, true);
    });
  }
  for (const image of [{ Id: imageId, Os: 'linux' }, { Id: imageId, Architecture: 'amd64' }, { Id: `sha256:${'f'.repeat(64)}`, Os: 'linux', Architecture: 'amd64' },
    { Id: imageId, Os: 'linux', Architecture: 'amd64', Variant: null }]) {
    it(`requires the exact immutable image and its own platform ${JSON.stringify(image)}`, async t => {
      const docker = syntheticDocker(t, { image });
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, () => true), safeFailure);
      assert.equal(docker.creates(), 0); assert.equal(docker.transport.destroyed, true);
    });
  }

  for (const changed of ['none', 'engine', 'platform', 'bridge', 'bounds'] as const) {
    it(`gates real same-connection execution with the selected complete qualification record, changed ${changed}`, async t => {
      const docker = syntheticDocker(t, changed === 'engine' ? { info: { ID: expected.daemonId, ServerVersion: '29.1.4' } } :
        changed === 'platform' ? { image: { Id: imageId, Os: 'linux', Architecture: 'arm64', Variant: 'v8' } } : {});
      const record = { id: 'fixture', imageId, engineVersion: '29.1.3', platform: { os: 'linux', architecture: 'amd64', variant: '' },
        bridgeRevision: changed === 'bridge' ? `sha256:${'e'.repeat(64)}` : DOCKER_BEE_BRIDGE_REVISION, harnessRevision: 'a'.repeat(40), evidenceDigest: `sha256:${'b'.repeat(64)}`,
        bridgeLifetimeSeconds: { min: 1, max: changed === 'bounds' ? 1 : 270 }, cleanupGraceMs: { min: 1, max: 10_000 }, streamBounds: DOCKER_BEE_STREAM_BOUNDS };
      const qualify = createBeeBridgeQualifier([record], ['fixture']); let observed: BeeBridgeExecution | undefined;
      const pending = acquireDockerBeeStream(docker.transport, expected, {}, execution => { observed = execution; return qualify(execution); });
      if (changed === 'none') { const result = await pending; result.stream.destroy(); assert.equal(docker.creates(), 1); }
      else { await assert.rejects(pending, safeFailure); assert.equal(docker.creates(), 0); assert.equal(docker.starts(), 0); }
      assert.ok(observed); assert.equal(observed.engineVersion, changed === 'engine' ? '29.1.4' : '29.1.3');
      assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed.platform)); assert.ok(Object.isFrozen(observed.streamBounds));
      assert.ok(docker.requests.some(request => request.url === `/images/${imageId}/json`)); assert.equal(docker.counts().connects, 0);
      assert.equal(JSON.stringify(observed).includes('SYNTHETIC_PRIVATE'), false);
    });
  }

  it('checks daemon, full container and exact reservation before one qualified exec and preserves upgrade head bytes', async t => {
    const docker = syntheticDocker(t);
    const result = await acquireDockerBeeStream(docker.transport, expected, {}, qualified);
    result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    assert.deepEqual((await once(result.stream, 'data'))[0], Buffer.from([0, 255, 128]));
    result.stream.write(Buffer.from([1, 0, 254])); await pause(0);
    assert.deepEqual(Buffer.concat(docker.input), Buffer.from([1, 0, 254]));
    assert.deepEqual(docker.requests.map(request => new URL(request.url, 'http://docker.invalid').pathname),
      ['/info', '/containers/json', `/containers/${containerId}/json`, `/images/${imageId}/json`, `/containers/${containerId}/exec`, `/exec/${execId}/start`]);
    const listUrl = new URL(docker.requests[1]!.url, 'http://docker.invalid');
    assert.equal(listUrl.searchParams.get('all'), '0');
    assert.deepEqual(JSON.parse(listUrl.searchParams.get('filters')!), { label: [`com.docker.compose.project=${expected.profile.name}`, 'com.docker.compose.service=bee-uploader'] });
    assert.ok(docker.requests.every(request => request.headers.host === 'docker.invalid'));
    assert.deepEqual(result.binding, { daemonId: expected.daemonId, containerId, imageId, project: expected.profile.name, service: 'bee-uploader',
      networkMode: 'synthetic-project_default', internalPort: 1633, publishedBindings: [{ hostIp: '0.0.0.0', hostPort: 11633 }, { hostIp: '::', hostPort: 11633 }] });
    assert.ok(Object.isFrozen(result.binding) && Object.isFrozen(result.binding.publishedBindings) && Object.isFrozen(result.binding.publishedBindings[0]));
    assert.equal(docker.counts().connects, 0);
    result.stream.destroy(); result.stream.destroy(); await pause(0);
    assert.equal(docker.counts().closes, 1);
    docker.transport.emit('error', new Error('sensitive late transport error'));
  });

  it('preserves a combined upgrade head larger than the decoder chunk without losing or duplicating bytes', async t => {
    const bytes = Buffer.alloc(200_000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const docker = syntheticDocker(t, { initial: bytes });
    const original = http.request; const heads: number[] = [];
    t.mock.method(http, 'request', (...args: unknown[]) => {
      const request: http.ClientRequest = Reflect.apply(original, http, args);
      request.prependListener('upgrade', (_response, _socket, head: Buffer) => heads.push(head.length));
      return request;
    });
    const defaultSize = getDefaultHighWaterMark(false);
    t.after(() => setDefaultHighWaterMark(false, defaultSize));
    const result = await acquireDockerBeeStream(docker.transport, expected, {}, image => {
      setDefaultHighWaterMark(false, 4096);
      return qualified(image);
    });
    setDefaultHighWaterMark(false, defaultSize);
    result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    assert.ok(heads[0]! > result.stream.readableHighWaterMark);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of result.stream) { chunks.push(chunk); size += chunk.length; if (size === bytes.length) break; }
    assert.deepEqual(Buffer.concat(chunks), bytes);
  });

  it('accepts two recorded aliases of the same daemon without resolving either alias', async t => {
    const docker = syntheticDocker(t);
    const target = structuredClone(expected);
    Object.assign(target, { alias: 'another-recorded-alias' });
    Object.assign(target.profile, { host: 'another-recorded-alias' });
    const result = await acquireDockerBeeStream(docker.transport, target, {}, qualified);
    result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    assert.equal(result.binding.daemonId, expected.daemonId);
    assert.equal(docker.counts().connects, 0);
  });

  it('clones expected ownership and numeric options before the first awaited response', async t => {
    const docker = syntheticDocker(t, { holdAt: 'info' });
    const target = structuredClone(expected); const options = { acquisitionTimeoutMs: 300, preflightTimeoutMs: 500, postTimeoutMs: 1000, cleanupGraceMs: 10 };
    const acquiring = acquireDockerBeeStream(docker.transport, target, options, qualified);
    Object.assign(target.profile, { name: 'changed-profile' }); Object.assign(target.reservation, { port: 9999 }); Object.assign(target, { daemonId: 'changed-daemon' });
    Object.assign(options, { acquisitionTimeoutMs: 1, preflightTimeoutMs: 60_000, postTimeoutMs: 180_000 });
    while (!docker.held.length) await pause(0);
    await pause(5); docker.held[0]!.response.end(JSON.stringify({ ID: expected.daemonId, ServerVersion: '29.1.3' }));
    const result = await acquiring; result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    assert.equal(result.binding.project, expected.profile.name);
    assert.equal(result.binding.publishedBindings[0]!.hostPort, 11633);
    const creation = docker.requests[4]!.body as { Cmd: string[] };
    assert.ok(!creation.Cmd.join(' ').includes('changed'));
    assert.ok(creation.Cmd.includes('2s'));
  });

  it('uses only fixed bridge argv and numeric internal port with explicit bounded timeout', async t => {
    const docker = syntheticDocker(t);
    const result = await acquireDockerBeeStream(docker.transport, expected,
      { acquisitionTimeoutMs: 30_000, preflightTimeoutMs: 60_000, postTimeoutMs: 180_000, cleanupGraceMs: 5000 }, qualified);
    result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    const body = docker.requests[4]!.body as { Cmd: string[]; [key: string]: unknown };
    assert.equal(body.AttachStdin, true); assert.equal(body.AttachStdout, true); assert.equal(body.AttachStderr, true); assert.equal(body.Tty, false);
    assert.equal(body.Privileged, false);
    assert.deepEqual(body.Cmd.slice(0, 10), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '270s', '/bin/bash', '--noprofile', '--norc']);
    assert.deepEqual(body.Cmd.slice(-2), ['bee-byte-bridge', '1633']);
    assert.ok(!JSON.stringify(body).includes(expected.alias)); assert.ok(!JSON.stringify(body).includes(expected.profile.name));
    assert.deepEqual(docker.requests[5]!.body, { Detach: false, Tty: false });
    assert.equal(docker.requests[5]!.headers.upgrade, 'tcp');
  });

  for (const mode of ['missing', 'refused', 'throws', 'async'] as const) {
    it(`refuses ${mode} trusted image qualification before exec`, async t => {
      const docker = syntheticDocker(t);
      const qualifier = mode === 'missing' ? undefined : mode === 'refused' ? () => false : mode === 'throws' ? () => { throw new Error('private diagnostic'); } : (() => Promise.resolve(true));
      // @ts-expect-error The async variant exercises a malformed runtime qualification callback.
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, qualifier), safeFailure);
      assert.equal(docker.creates(), 0); assert.equal(docker.transport.destroyed, true);
    });
  }

  const invalid: { name: string; options: FixtureOptions }[] = [
    { name: 'another daemon', options: { daemonId: 'other-daemon' } },
    { name: 'missing running container', options: { candidates: [] } },
    { name: 'multiple running containers', options: { candidates: [{ Id: containerId, Labels: labels }, { Id: replacementId, Labels: labels }] } },
    { name: 'short container id', options: { candidates: [{ Id: 'aaaa', Labels: labels }] } },
    { name: 'wrong listed labels', options: { candidates: [{ Id: containerId, Labels: { ...labels, 'com.docker.compose.service': 'other' } }] } },
    { name: 'replacement at inspect', options: { inspect: { ...inspection(), Id: replacementId } } },
    { name: 'wrong inspected labels', options: { inspect: { ...inspection(), Config: { Labels: {} } } } },
    { name: 'stopped container', options: { inspect: { ...inspection(), State: { ...inspection().State, Running: false } } } },
    { name: 'paused container', options: { inspect: { ...inspection(), State: { ...inspection().State, Paused: true } } } },
    { name: 'restarting container', options: { inspect: { ...inspection(), State: { ...inspection().State, Restarting: true } } } },
    { name: 'dead container', options: { inspect: { ...inspection(), State: { ...inspection().State, Dead: true } } } },
    { name: 'nonimmutable image', options: { inspect: { ...inspection(), Image: 'bee:latest' } } },
    { name: 'host network', options: { inspect: { ...inspection(), HostConfig: { NetworkMode: 'host' } } } },
    { name: 'shared container network', options: { inspect: { ...inspection(), HostConfig: { NetworkMode: `container:${replacementId}` } } } },
    { name: 'missing port', options: { inspect: { ...inspection(), NetworkSettings: { Ports: {} } } } },
    { name: 'another host port', options: { inspect: { ...inspection(), NetworkSettings: { Ports: { '1633/tcp': [{ HostIp: '0.0.0.0', HostPort: '11634' }] } } } } },
    { name: 'UDP only', options: { inspect: { ...inspection(), NetworkSettings: { Ports: { '1633/udp': [{ HostIp: '0.0.0.0', HostPort: '11633' }] } } } } },
    { name: 'ambiguous internal ports', options: { inspect: { ...inspection(), NetworkSettings: { Ports: { '1633/tcp': [{ HostIp: '0.0.0.0', HostPort: '11633' }], '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '11633' }] } } } } },
    { name: 'nonnumeric host binding', options: { inspect: { ...inspection(), NetworkSettings: { Ports: { '1633/tcp': [{ HostIp: 'host.invalid', HostPort: '11633' }] } } } } },
    { name: 'invalid internal port', options: { inspect: { ...inspection(), NetworkSettings: { Ports: { '0/tcp': [{ HostIp: '0.0.0.0', HostPort: '11633' }] } } } } },
  ];
  for (const variant of invalid) {
    it(`refuses ${variant.name} before creating an exec`, async t => {
      const docker = syntheticDocker(t, variant.options);
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, qualified), safeFailure);
      assert.equal(docker.creates(), 0); assert.equal(docker.transport.destroyed, true); assert.equal(docker.counts().connects, 0);
    });
  }

  for (const stage of ['info', 'list', 'inspect', 'image', 'create', 'start'] as const) {
    it(`never reconnects or repeats an exec POST after response loss at ${stage}`, async t => {
      const docker = syntheticDocker(t, { stopAt: stage });
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, qualified), safeFailure);
      assert.equal(docker.creates(), ['create', 'start'].includes(stage) ? 1 : 0);
      assert.equal(docker.starts(), stage === 'start' ? 1 : 0);
      assert.equal(docker.counts().connects, 0); assert.equal(docker.transport.destroyed, true);
      await pause(0); assert.equal(docker.counts().closes, 1);
      docker.transport.emit('error', new Error('private diagnostic after failure'));
    });
  }

  for (const variant of [
    { name: 'ordinary start response', options: { responseAt: 'start' as const } },
    { name: 'wrong upgrade protocol', options: { upgradeHeader: 'websocket' } },
    { name: 'wrong upgrade status', options: { upgradeStatus: 200 } },
    { name: 'invalid exec id', options: { execId: 'unsafe/id' } },
    { name: 'redirect', options: { responseAt: 'info' as const, status: 302 } },
    { name: 'invalid JSON', options: { responseAt: 'info' as const } },
    { name: 'oversized declared JSON', options: { responseAt: 'info' as const, declaredLength: 2_000_000 } },
    { name: 'oversized streamed JSON', options: { responseAt: 'info' as const, rawJson: 'x'.repeat(2_000_000) } },
    { name: 'oversized headers', options: { largeHeader: true } },
    { name: 'unexpected informational responses', options: { information: true } },
  ]) {
    it(`contains ${variant.name} with a fixed error and exact cleanup`, async t => {
      const docker = syntheticDocker(t, variant.options);
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, {}, qualified), safeFailure);
      assert.equal(docker.transport.destroyed, true); assert.equal(docker.counts().connects, 0);
    });
  }

  it('bounds a stalled acquisition and cannot revive it with a late response', async t => {
    const docker = syntheticDocker(t, { holdAt: 'info' });
    await assert.rejects(acquireDockerBeeStream(docker.transport, expected, { acquisitionTimeoutMs: 20 }, qualified), safeFailure);
    docker.held[0]!.response.end(JSON.stringify({ ID: expected.daemonId })); await pause(0);
    assert.equal(docker.requests.length, 1); assert.equal(docker.transport.destroyed, true);
  });

  for (const stage of ['create', 'start'] as const) {
    // What this is about is that neither POST is ever sent twice, and both are
    // non-idempotent: a repeated exec creates a second one on the container.
    // It used to wait 30 ms for a deadline to end the attempt, which meant the
    // POST had to reach the fixture through five earlier round trips inside
    // those 30 ms, and on a loaded machine it did not: the case failed once in
    // four full runs on a count of 0 against 1, with nothing wrong. So the
    // POST arriving is now waited for rather than assumed, and the attempt is
    // ended by an abort, which the handshake answers with the same call the
    // deadline answers with. The deadline arithmetic itself is pinned by the
    // stalled acquisition and the monotonic expiry cases either side of this.
    it(`never repeats either Docker POST when the ${stage} response is lost`, async t => {
      const docker = syntheticDocker(t, { holdAt: stage });
      const controller = new AbortController();
      const acquiring = acquireDockerBeeStream(docker.transport, expected, {}, qualified, controller.signal);
      const posted = stage === 'start' ? docker.starts : docker.creates;
      await until(() => posted() === 1, `the ${stage} POST to reach the daemon`);

      await pause(REPEAT_WINDOW_MS);
      assert.equal(docker.creates(), 1); assert.equal(docker.starts(), stage === 'start' ? 1 : 0);

      controller.abort();
      await assert.rejects(acquiring, safeFailure);
      assert.equal(docker.creates(), 1); assert.equal(docker.starts(), stage === 'start' ? 1 : 0);
      assert.equal(docker.transport.destroyed, true); assert.equal(docker.counts().connects, 0);
      const command = (docker.requests.find(request => request.url.endsWith('/exec'))!.body as { Cmd: string[] }).Cmd;
      assert.ok(command.includes('/usr/bin/timeout'));
      assert.ok(command.some(argument => argument.startsWith('--kill-after=')));
    });
  }

  it('rejects a monotonic acquisition expiry even when a trusted qualifier delays the timer', async t => {
    const docker = syntheticDocker(t);
    await assert.rejects(acquireDockerBeeStream(docker.transport, expected, { acquisitionTimeoutMs: 30 }, () => {
      const until = performance.now() + 40; while (performance.now() < until) {} return true;
    }), safeFailure);
    assert.equal(docker.creates(), 0);
  });

  it('clears the acquisition timer on handoff but keeps a total lifetime on the returned stream', async t => {
    const docker = syntheticDocker(t);
    const result = await acquireDockerBeeStream(docker.transport, expected,
      { acquisitionTimeoutMs: 200, preflightTimeoutMs: 200, postTimeoutMs: 200, cleanupGraceMs: 50 }, qualified);
    result.stream.on('error', () => {}); t.after(() => result.stream.destroy());
    await pause(250); assert.equal(result.stream.destroyed, false); assert.equal(docker.transport.destroyed, false);
    await pause(500); assert.equal(result.stream.destroyed, true); assert.equal(docker.transport.destroyed, true);
  });

  for (const stage of ['before', 'held', 'upgrade', 'native-upgrade', 'after'] as const) {
    it(`contains cancellation ${stage} handoff and disposes exactly once`, async t => {
      const controller = new AbortController();
      if (stage === 'before') controller.abort();
      const docker = syntheticDocker(t, { holdAt: stage === 'held' ? 'info' : undefined,
        afterUpgrade: stage === 'upgrade' ? () => controller.abort() : undefined });
      if (stage === 'native-upgrade') {
        const original = http.request;
        t.mock.method(http, 'request', (...args: unknown[]) => {
          const request: http.ClientRequest = Reflect.apply(original, http, args);
          request.prependListener('upgrade', () => queueMicrotask(() => controller.abort()));
          return request;
        });
      }
      const acquiring = acquireDockerBeeStream(docker.transport, expected, {}, qualified, controller.signal);
      if (stage === 'held') { while (!docker.held.length) await pause(0); controller.abort(); }
      if (stage === 'after') {
        const result = await acquiring; result.stream.on('error', () => {}); controller.abort();
        await pause(0); assert.equal(result.stream.destroyed, true);
      } else await assert.rejects(acquiring, safeFailure);
      await pause(0); assert.equal(docker.transport.destroyed, true); assert.equal(docker.counts().closes, 1);
      assert.equal(docker.counts().connects, 0);
      docker.transport.emit('error', new Error('private diagnostic after abort'));
    });
  }

  for (const options of [{ acquisitionTimeoutMs: 0 }, { preflightTimeoutMs: 60_001 }, { postTimeoutMs: Infinity }, { cleanupGraceMs: -1 }]) {
    it(`owns the supplied stream even when ${Object.keys(options)[0]} is invalid`, async t => {
      const docker = syntheticDocker(t);
      await assert.rejects(acquireDockerBeeStream(docker.transport, expected, options, qualified), safeFailure);
      assert.equal(docker.transport.destroyed, true); assert.equal(docker.requests.length, 0);
      docker.transport.emit('error', new Error('private diagnostic after invalid options'));
    });
  }

  it('disposes its stream when cloning expected ownership fails', async t => {
    const docker = syntheticDocker(t);
    const target = { ...expected, uncloneable: () => {} };
    await assert.rejects(acquireDockerBeeStream(docker.transport, target, {}, qualified), safeFailure);
    assert.equal(docker.transport.destroyed, true); assert.equal(docker.requests.length, 0);
  });

  it('disposes its stream for null options from an untyped caller', async t => {
    const docker = syntheticDocker(t);
    // @ts-expect-error Exercise the runtime construction boundary.
    await assert.rejects(acquireDockerBeeStream(docker.transport, expected, null, qualified), safeFailure);
    assert.equal(docker.transport.destroyed, true); assert.equal(docker.requests.length, 0);
  });
});
