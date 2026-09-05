/**
 * A stand-in for the manager API, for developing and reviewing the frontend
 * without Postgres, Docker or a Bee node.
 *
 * It answers every endpoint the frontend calls, in the shapes `frontend/src/types`
 * and the `common` package describe, and it moves state the way the real manager
 * does: a deploy takes a moment and lands RUNNING, a bought batch is unusable
 * for a few seconds and is then set on the profile by itself.
 *
 * The dataset it starts from is in `mock-seed.mjs` and the metrics generator is
 * in `mock-metrics.mjs`. This file is the transitions and the routes.
 *
 *   node frontend/dev/mock-manager.mjs        (or: pnpm -C frontend dev:mock)
 */
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';

import { metricsClients, metricsSnapshot } from './mock-metrics.mjs';
import {
  containersFor,
  DAY,
  GB,
  hex,
  HOST_PASSPHRASE,
  makeProfile,
  makeStamp,
  needsStamp,
  node,
  PORT_BASES,
  PUBLIC_HOST,
  refreshDerived,
  RUNGS,
  seed,
  state,
  takeGroupId,
} from './mock-seed.mjs';

const PORT = Number(process.env.PORT ?? 9876);

const DEPLOY_MS = 1_500;
const STOP_MS = 1_200;
const REMOVE_MS = 1_200;
const STAMP_SETTLE_MS = 4_000;

// ----------------------------------------------------------- transitions

const eventClients = new Set();

function publish(event) {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) client.write(frame);
}

function changed(profile) {
  refreshDerived(profile);
  publish({ type: 'profile.changed', profile });
}

function findProfile(name) {
  return state.profiles.find((profile) => profile.name === name) ?? null;
}

function membersOf(groupId) {
  return state.profiles.filter((profile) => profile.group_id === groupId);
}

function deploy(profile, { withUploader } = {}) {
  profile.status = 'DEPLOYING';
  profile.last_error = null;
  profile.last_error_at = null;
  changed(profile);
  setTimeout(() => {
    profile.status = 'RUNNING';
    profile.containers = containersFor(profile, {
      withUploader:
        withUploader ??
        (!needsStamp(profile) ||
          Boolean(profile.stamp_id) ||
          Boolean(profile.bee_publishers)),
    });
    changed(profile);
  }, DEPLOY_MS);
}

function stop(profile) {
  profile.status = 'STOPPING';
  changed(profile);
  setTimeout(() => {
    profile.status = 'STOPPED';
    profile.containers = [];
    changed(profile);
  }, STOP_MS);
}

function remove(profile) {
  profile.status = 'REMOVING';
  changed(profile);
  setTimeout(() => {
    state.profiles = state.profiles.filter((entry) => entry.name !== profile.name);
    state.nodes.delete(profile.name);
    publish({ type: 'profile.deleted', name: profile.name });
    if (profile.group_id != null && membersOf(profile.group_id).length === 0) {
      state.groups = state.groups.filter((group) => group.id !== profile.group_id);
    }
  }, REMOVE_MS);
}

function buyStamp(profile, { amount, depth }) {
  const stamp = makeStamp({
    depth,
    ttl: Math.max(DAY, Math.round((Number(amount) / 1_200_000) * DAY)),
    usable: false,
    amount: String(amount),
  });
  node(profile.name).stamps.push(stamp);
  setTimeout(() => {
    stamp.usable = true;
    if (!profile.stamp_id) {
      profile.stamp_id = stamp.batchID;
      changed(profile);
    }
  }, STAMP_SETTLE_MS);
  return stamp;
}

// ------------------------------------------------------- bee-publishers

function stampStateOf(profile) {
  if (!profile.stamp_id) return 'none';
  const stamp = node(profile.name).stamps.find(
    (entry) => entry.batchID === profile.stamp_id.replace(/^0x/, ''),
  );
  if (!stamp || stamp.exists === false) return 'gone';
  if (stamp.batchTTL === 0) return 'expired';
  if (!stamp.usable) return 'pending';
  return 'active';
}

function stampTtlOf(profile) {
  if (!profile.stamp_id) return null;
  const stamp = node(profile.name).stamps.find(
    (entry) => entry.batchID === profile.stamp_id.replace(/^0x/, ''),
  );
  return stamp ? stamp.batchTTL : null;
}

const STAMP_REASONS = {
  none: 'no postage batch set on this rung yet',
  expired: 'the postage batch on this rung has expired, buy a new one',
  gone: 'this rung no longer holds the batch recorded for it, buy a new one',
  pending: 'the postage batch on this rung is not usable yet',
};

function beePublishersFor(group) {
  const members = membersOf(group.id);
  const rungs = [];
  const missing = [];

  for (const rung of RUNGS) {
    const profile = members.find(
      (entry) => entry.name === `${group.name}-${rung.name}`,
    );
    if (!profile) {
      missing.push({ rung: rung.name, reason: 'no member deployed for this rung' });
      continue;
    }

    const url = `http://${PUBLIC_HOST}:${PORT_BASES.BEE_UPLOADER_API_PORT + profile.port_slot * 10}`;
    const stampState = stampStateOf(profile);
    rungs.push({
      rung: rung.name,
      name: profile.name,
      status: profile.status,
      url,
      stampId: profile.stamp_id,
      stampState,
      stampTtl: stampTtlOf(profile),
      urlState: 'ok',
    });

    if (profile.status !== 'RUNNING') {
      missing.push({
        rung: rung.name,
        reason: `this rung is ${profile.status.toLowerCase()}, not running`,
      });
    } else if (stampState !== 'active') {
      missing.push({ rung: rung.name, reason: STAMP_REASONS[stampState] });
    }
  }

  const ready = missing.length === 0;
  return {
    ready,
    value: ready
      ? rungs.map((entry) => `${entry.rung}@${entry.url}<${entry.stampId}>`).join(' ')
      : null,
    rungs,
    missing,
    warnings: [],
  };
}

// --------------------------------------------------------------- server

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function openStream(res, clients) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Wraps a handler that needs a profile, so the 404 is written once. */
function withProfile(handler) {
  return (req, res, params) => {
    const profile = findProfile(params[0]);
    if (!profile) {
      return send(res, 404, { error: `profile ${params[0]} not found` });
    }
    return handler(req, res, profile);
  };
}

const EDITABLE_FIELDS = [
  'notes',
  'feed_owner',
  'feed_topic',
  'private_key',
  'public_key',
  'stamp_id',
  'bee_publishers',
  'bee_url',
  'srt_passphrase',
];

function applyEdits(profile, body) {
  for (const field of EDITABLE_FIELDS) {
    if (field in body) profile[field] = body[field] ?? null;
  }
}

function createFromBody(body, extra = {}) {
  const profile = makeProfile({
    ...body,
    ...extra,
    status: 'DEPLOYING',
    created_at: new Date().toISOString(),
  });
  state.profiles.push(profile);
  refreshDerived(profile);
  node(profile.name);
  setTimeout(() => deploy(profile), 0);
  return profile;
}

const ROUTES = [
  ['GET', /^\/health$/, (_req, res) => send(res, 200, { status: 'ok' })],
  [
    'GET',
    /^\/config$/,
    (_req, res) =>
      send(res, 200, { host: PUBLIC_HOST, srtPassphrase: HOST_PASSPHRASE }),
  ],
  ['GET', /^\/profiles$/, (_req, res) => send(res, 200, { profiles: state.profiles })],
  [
    'POST',
    /^\/profiles$/,
    async (req, res) => {
      const body = await readBody(req);
      if (findProfile(body.name)) {
        return send(res, 409, { error: `profile ${body.name} already exists` });
      }
      send(res, 202, createFromBody(body));
    },
  ],
  ['GET', /^\/profiles\/([^/]+)$/, withProfile((_req, res, p) => send(res, 200, p))],
  [
    'PUT',
    /^\/profiles\/([^/]+)$/,
    withProfile(async (req, res, profile) => {
      applyEdits(profile, await readBody(req));
      deploy(profile);
      send(res, 202, profile);
    }),
  ],
  [
    'DELETE',
    /^\/profiles\/([^/]+)$/,
    withProfile((_req, res, profile) => {
      remove(profile);
      send(res, 202, profile);
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/deploy$/,
    withProfile((_req, res, profile) => {
      deploy(profile);
      send(res, 202, { status: 'accepted' });
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/stop$/,
    withProfile((_req, res, profile) => {
      stop(profile);
      send(res, 202, { status: 'accepted' });
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/deploy-uploader$/,
    withProfile((_req, res, profile) => {
      deploy(profile, { withUploader: true });
      send(res, 202, { status: 'accepted' });
    }),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/stamp\/address$/,
    (_req, res, [name]) =>
      send(res, 200, { ethereum: node(name).ethereum, overlay: hex(32) }),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/stamp\/wallet$/,
    (_req, res, [name]) =>
      send(res, 200, {
        bzzBalance: node(name).bzz,
        nativeTokenBalance: node(name).xdai,
      }),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/stamp\/stamps$/,
    (_req, res, [name]) => send(res, 200, { stamps: node(name).stamps }),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/stamp\/chainstate$/,
    (_req, res) =>
      send(res, 200, {
        chainTip: 39_100_000,
        block: 39_099_980,
        totalAmount: '92000000000',
        currentPrice: '24000',
      }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/stamp\/buy$/,
    withProfile(async (req, res, profile) => {
      const body = await readBody(req);
      const depth = Number(body.depth);
      if (!/^[1-9][0-9]*$/.test(String(body.amount)) || !(depth >= 17 && depth <= 40)) {
        return send(res, 400, {
          error: 'validation_error',
          errors: ['amount must be a positive integer and depth must be 17 to 40'],
        });
      }
      send(res, 202, {
        batchID: buyStamp(profile, { amount: body.amount, depth }).batchID,
      });
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/stamp\/set$/,
    withProfile(async (req, res, profile) => {
      const body = await readBody(req);
      profile.stamp_id = String(body.stamp_id).replace(/^0x/, '');
      changed(profile);
      send(res, 200, profile);
    }),
  ],
  ['GET', /^\/groups$/, (_req, res) => send(res, 200, { groups: state.groups })],
  [
    'POST',
    /^\/groups$/,
    async (req, res) => {
      const body = await readBody(req);
      const isPool = Boolean(body.abr_ladder);
      const group = {
        id: takeGroupId(),
        name: body.group_name,
        size: isPool ? RUNGS.length : Number(body.size),
        kind: isPool ? 'abr-node-pool' : 'standard',
        created_at: new Date().toISOString(),
      };
      state.groups.push(group);

      const profiles = isPool
        ? RUNGS.map((rung) =>
            createFromBody(
              { ...body, name: `${group.name}-${rung.name}`, kind: 'custom' },
              { components: ['bee-uploader'], group_id: group.id },
            ),
          )
        : Array.from({ length: group.size }, (_value, index) =>
            createFromBody(
              { ...body, name: `${group.name}-profile-${index + 1}` },
              { group_id: group.id },
            ),
          );

      send(res, 202, { group, profiles });
    },
  ],
  [
    'GET',
    /^\/groups\/(\d+)\/bee-publishers$/,
    (_req, res, [id]) => {
      const group = state.groups.find((entry) => entry.id === Number(id));
      if (!group) return send(res, 404, { error: `group ${id} not found` });
      if (group.kind !== 'abr-node-pool') {
        return send(res, 409, {
          error: 'this group is not an ABR node pool, so it has no BEE_PUBLISHERS',
        });
      }
      send(res, 200, beePublishersFor(group));
    },
  ],
  [
    'PATCH',
    /^\/groups\/(\d+)\/config$/,
    async (req, res, [id]) => {
      const group = state.groups.find((entry) => entry.id === Number(id));
      if (!group) return send(res, 404, { error: `group ${id} not found` });
      const body = await readBody(req);
      const profiles = membersOf(group.id);
      for (const profile of profiles) {
        applyEdits(profile, body);
        deploy(profile);
      }
      send(res, 202, { group, profiles });
    },
  ],
  [
    'POST',
    /^\/groups\/(\d+)\/members$/,
    async (req, res, [id]) => {
      const group = state.groups.find((entry) => entry.id === Number(id));
      if (!group) return send(res, 404, { error: `group ${id} not found` });
      const body = await readBody(req);
      const existing = membersOf(group.id);
      const template = existing[0] ?? {};
      const profiles = Array.from({ length: Number(body.count) || 1 }, (_v, index) =>
        createFromBody(
          {
            name: `${group.name}-profile-${existing.length + index + 1}`,
            kind: template.kind ?? 'viewer',
            components: template.components ?? null,
            feed_owner: template.feed_owner ?? null,
            notes: template.notes ?? null,
            srt_passphrase: template.srt_passphrase ?? null,
          },
          { group_id: group.id },
        ),
      );
      group.size += profiles.length;
      send(res, 202, { group, profiles });
    },
  ],
  ['GET', /^\/events$/, (_req, res) => openStream(res, eventClients)],
  ['GET', /^\/metrics$/, (_req, res) => send(res, 200, metricsSnapshot())],
  [
    'GET',
    /^\/metrics\/stream$/,
    (_req, res) => {
      openStream(res, metricsClients);
      res.write(`event: snapshot\ndata: ${JSON.stringify(metricsSnapshot())}\n\n`);
    },
  ],
  [
    'GET',
    /^\/metrics\/disk\/([^/]+)$/,
    (_req, res, [project]) =>
      send(res, 200, {
        project,
        sizeBytes: findProfile(project) ? randomInt(1, 9) * GB : null,
      }),
  ],
];

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  const path = decodeURI(new URL(req.url, `http://${PUBLIC_HOST}`).pathname);
  for (const [method, pattern, handler] of ROUTES) {
    const match = pattern.exec(path);
    if (match && method === req.method) {
      return Promise.resolve(handler(req, res, match.slice(1))).catch((error) =>
        send(res, 500, { error: String(error) }),
      );
    }
  }

  send(res, 404, { error: `no mock route for ${req.method} ${path}` });
});

seed();
server.listen(PORT, () => {
  process.stdout.write(
    `mock manager on http://localhost:${PORT} with ${state.profiles.length} profiles and ${state.groups.length} groups\n`,
  );
});
