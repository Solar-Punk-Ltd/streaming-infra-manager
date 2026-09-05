/**
 * The world the mock manager serves: the profiles, groups and Bee nodes it
 * starts with, and the shapes they are built from.
 *
 * Kept apart from the routes so the dataset can be read and changed on its own,
 * and so no file here outgrows what is comfortable to read. Every key, address
 * and batch id is generated at startup: nothing 64-hex is committed here.
 */
import { randomBytes, randomInt } from 'node:crypto';

/** The hostname this fake manager publishes its deployments on. */
export const PUBLIC_HOST = 'lab-host-1';

export const DAY = 86_400;
export const GB = 1024 ** 3;

export const RUNGS = [
  { name: '360p', kbps: 700, depth: 17 },
  { name: '480p', kbps: 1200, depth: 18 },
  { name: '720p', kbps: 2800, depth: 19 },
  { name: '1080p', kbps: 5000, depth: 20 },
];

export const hex = (bytes) => randomBytes(bytes).toString('hex');
/** A readable fake SRT passphrase, distinct per run like every other secret here. */
export const passphrase = (label) => `${label}-${hex(6)}`;
export const HOST_PASSPHRASE = passphrase('lab-host');
const key = () => `0x${hex(32)}`;
const address = () => `0x${hex(20)}`;
const batchId = () => hex(32);

export const PORT_BASES = {
  API_PORT: 10000,
  SRS_SRT_PORT: 10001,
  OME_SRT_PORT: 10001,
  OME_HLS_PORT: 10003,
  CLIENT_PORT: 10004,
  BEE_UPLOADER_API_PORT: 10005,
  BEE_UPLOADER_P2P_PORT: 10006,
  BEE_GATEWAY_API_PORT: 10007,
  BEE_GATEWAY_P2P_PORT: 10008,
};

const SERVICE_PORTS = {
  srs: ['SRS_SRT_PORT'],
  ome: ['OME_SRT_PORT', 'OME_HLS_PORT'],
  'stream-uploader': ['API_PORT'],
  'bee-uploader': ['BEE_UPLOADER_API_PORT', 'BEE_UPLOADER_P2P_PORT'],
  'bee-gateway': ['BEE_GATEWAY_API_PORT', 'BEE_GATEWAY_P2P_PORT'],
  client: ['CLIENT_PORT'],
};

const KIND_SERVICES = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  'abr-uploader': ['srs', 'stream-uploader'],
  viewer: ['client', 'bee-gateway'],
  custom: [],
};

export const MEM_BY_SERVICE = {
  srs: 190,
  ome: 220,
  'stream-uploader': 150,
  'bee-uploader': 840,
  client: 28,
  'bee-gateway': 320,
};

export const CPU_BY_SERVICE = {
  srs: 14,
  ome: 16,
  'stream-uploader': 9,
  'bee-uploader': 22,
  client: 1.2,
  'bee-gateway': 6,
};


// Slots and group ids are handed out here, because the seed takes the first of
// them and every later create has to continue the same sequence.
let nextSlot = 1;
let nextGroupId = 1;

export function takeGroupId() {
  return nextGroupId++;
}

export const state = {
  profiles: [],
  groups: [],
  /** Per profile: what its Bee node would answer. */
  nodes: new Map(),
};

export function servicesOf(profile) {
  return profile.components?.length
    ? profile.components
    : (KIND_SERVICES[profile.kind] ?? []);
}

function portsFor(service, slot) {
  const ports = {};
  for (const name of SERVICE_PORTS[service] ?? []) {
    ports[name] = PORT_BASES[name] + slot * 10;
  }
  return ports;
}

export function containersFor(profile, { withUploader = true } = {}) {
  return servicesOf(profile)
    .filter((service) => withUploader || service !== 'stream-uploader')
    .map((service) => ({ service, ports: portsFor(service, profile.port_slot) }));
}

export function makeProfile(input) {
  const now = new Date().toISOString();
  return {
    name: input.name,
    port_slot: input.port_slot ?? nextSlot++,
    kind: input.kind ?? 'custom',
    notes: input.notes ?? null,
    host: input.host ?? 'localhost',
    components: input.components ?? null,
    feed_owner: input.feed_owner ?? null,
    feed_topic: null,
    private_key: input.private_key ?? null,
    public_key: input.public_key ?? null,
    stamp_id: input.stamp_id ?? null,
    bee_publishers: input.bee_publishers ?? null,
    bee_url: input.bee_url ?? null,
    srt_passphrase: input.srt_passphrase ?? null,
    status: input.status ?? 'RUNNING',
    last_error: input.last_error ?? null,
    last_error_at: input.last_error_at ?? null,
    created_at: input.created_at ?? now,
    updated_at: now,
    containers: [],
    group_id: input.group_id ?? null,
    pendingStamp: false,
  };
}

export function needsStamp(profile) {
  return servicesOf(profile).includes('stream-uploader');
}

export function refreshDerived(profile) {
  profile.pendingStamp =
    needsStamp(profile) && !profile.stamp_id && !profile.bee_publishers;
  profile.updated_at = new Date().toISOString();
}

export function node(name) {
  let entry = state.nodes.get(name);
  if (!entry) {
    entry = { ethereum: address(), bzz: '0', xdai: '0', stamps: [] };
    state.nodes.set(name, entry);
  }
  return entry;
}

export function makeStamp({ depth, ttl, usable = true, amount = '48000000' }) {
  return {
    batchID: batchId(),
    utilization: randomInt(0, 40),
    usable,
    depth,
    amount,
    bucketDepth: 16,
    blockNumber: 39_000_000 + randomInt(0, 100_000),
    immutableFlag: false,
    exists: true,
    batchTTL: ttl,
  };
}

export function seed() {
  const mainKey = key();
  const mainAddress = address();

  const mainStage = makeProfile({
    name: 'main-stage',
    kind: 'streamer',
    notes: 'Primary stage. OBS at the venue publishes here.',
    private_key: mainKey,
    public_key: mainAddress,
    srt_passphrase: passphrase('main-stage'),
    created_at: '2026-08-30T09:00:00Z',
  });
  const mainNode = node(mainStage.name);
  mainNode.xdai = '421300000000000000';
  mainNode.bzz = '125000000000000000';
  const mainStamp = makeStamp({ depth: 20, ttl: 41 * DAY });
  mainNode.stamps = [mainStamp, makeStamp({ depth: 17, ttl: 12 * DAY, amount: '12000000' })];
  mainStage.stamp_id = mainStamp.batchID;

  const backupStage = makeProfile({
    name: 'backup-stage',
    kind: 'streamer',
    notes: 'Hot spare for the main stage.',
    private_key: key(),
    public_key: address(),
    created_at: '2026-09-04T12:40:00Z',
  });
  const backupNode = node(backupStage.name);
  backupNode.xdai = '200000000000000000';
  backupNode.bzz = '24000000000000000';

  const viewerEu = makeProfile({
    name: 'viewer-eu',
    kind: 'viewer',
    notes: 'Public player, EU audience.',
    feed_owner: mainAddress,
    created_at: '2026-08-30T09:30:00Z',
  });

  const abrGcp = makeProfile({
    name: 'abr-gcp',
    kind: 'abr-uploader',
    notes: 'Encodes the ladder and publishes to the bare-metal pool.',
    private_key: key(),
    public_key: address(),
    bee_publishers: RUNGS.map(
      (rung, index) => `${rung.name}@http://10.0.0.7:${10015 + index * 10}<${batchId()}>`,
    ).join(' '),
    created_at: '2026-09-01T17:05:00Z',
  });

  const edgeTest = makeProfile({
    name: 'edge-test',
    kind: 'custom',
    components: ['srs', 'client', 'bee-gateway'],
    notes: 'Experiment: player served from the same box as ingest.',
    feed_owner: mainAddress,
    status: 'ERROR',
    last_error:
      'deploy.sh exited 1: bind for 0.0.0.0:10052 failed, port is already allocated',
    last_error_at: '2026-09-05T07:58:00Z',
    created_at: '2026-09-05T07:55:00Z',
  });

  const oldDemo = makeProfile({
    name: 'old-demo',
    kind: 'streamer',
    status: 'STOPPED',
    private_key: key(),
    public_key: address(),
    created_at: '2026-07-12T10:00:00Z',
  });
  const oldNode = node(oldDemo.name);
  oldNode.xdai = '10000000000000000';
  oldNode.bzz = '3100000000000000';
  const deadStamp = makeStamp({ depth: 17, ttl: 0, amount: '1000000' });
  oldNode.stamps = [deadStamp];
  oldDemo.stamp_id = deadStamp.batchID;

  state.profiles.push(mainStage, backupStage, viewerEu, abrGcp, edgeTest, oldDemo);

  const loadtest = {
    id: nextGroupId++,
    name: 'loadtest',
    size: 3,
    kind: 'standard',
    created_at: '2026-09-04T08:00:00Z',
  };
  state.groups.push(loadtest);
  for (let index = 1; index <= 3; index += 1) {
    state.profiles.push(
      makeProfile({
        name: `${loadtest.name}-profile-${index}`,
        kind: 'viewer',
        group_id: loadtest.id,
        feed_owner: mainAddress,
        created_at: loadtest.created_at,
      }),
    );
  }

  const pool = {
    id: nextGroupId++,
    name: 'abr-pool-1',
    size: RUNGS.length,
    kind: 'abr-node-pool',
    created_at: '2026-09-02T15:30:00Z',
  };
  state.groups.push(pool);
  RUNGS.forEach((rung, index) => {
    const member = makeProfile({
      name: `${pool.name}-${rung.name}`,
      kind: 'custom',
      components: ['bee-uploader'],
      group_id: pool.id,
      created_at: pool.created_at,
    });
    const memberNode = node(member.name);
    memberNode.xdai = '150000000000000000';
    if (rung.name === '1080p') {
      memberNode.bzz = '0';
    } else {
      memberNode.bzz = String(BigInt(42 - index * 9) * 10n ** 15n);
      const stamp = makeStamp({
        depth: rung.depth,
        ttl: (60 - index * 15) * DAY,
      });
      memberNode.stamps = [stamp];
      member.stamp_id = stamp.batchID;
    }
    state.profiles.push(member);
  });

  for (const profile of state.profiles) {
    if (profile.status === 'RUNNING') {
      profile.containers = containersFor(profile, {
        withUploader: !needsStamp(profile) || Boolean(profile.stamp_id) || Boolean(profile.bee_publishers),
      });
    }
    refreshDerived(profile);
  }
}
