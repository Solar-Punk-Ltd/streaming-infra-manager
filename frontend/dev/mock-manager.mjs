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
 *   pnpm -C frontend dev:mock
 *
 * Signing in is real here too: every route but /health and the two sign-in
 * routes needs the session cookie, so the frontend's 401 handling can be
 * exercised offline. The login is in mock-auth.mjs and printed at startup.
 */
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';

import {
  bzzToPlur,
  chequebookHealthFrom,
  chequebookHealthPayload,
  configuredBeeRpcEndpoint,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  defaultServicesFor,
  effectiveNodeMode,
  impliedRpcEndpointSource,
  keptRpcEndpointSource,
  nodeModeProblem,
  plurToBzz,
  rpcEndpointChoiceProblem,
} from '@streaming-infra-manager/common';

import {
  authRoutes,
  DEV_PASSWORD,
  DEV_USERNAME,
  refuseRequest,
  seedAuth,
  userFor,
} from './mock-auth.mjs';
import {
  attemptRefusal,
  attemptRoutes,
  openAttempt,
  resolveAttempt,
  seedAttempts,
} from './mock-attempts.mjs';
import { engineRoutes } from './mock-engine.mjs';
import { createMockChequebookJournal } from './mock-chequebook.mjs';
import { createTargetRoutes } from './mock-targets.mjs';
import { closeRollout, engineConfigRoutes, forgetEngineConfig } from './mock-engine-config.mjs';
import { readBody, send as sendRaw, sendScriptRun } from './mock-http.mjs';
import { metricsClients, metricsSnapshot } from './mock-metrics.mjs';
import { MOCK_CURRENT_PRICE, stampChangeRoutes } from './mock-stamps.mjs';
import {
  defaultVersionId,
  newDeploymentVersionProblem,
  seedVersions,
  versionRoutes,
} from './mock-versions.mjs';
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
  nodeIfKnown,
  PORT_BASES,
  PUBLIC_HOST,
  refreshDerived,
  RUNGS,
  seed,
  setSrtPassphrase,
  srtPassphraseOf,
  state,
  takeGroupId,
} from './mock-seed.mjs';

const PORT = Number(process.env.PORT ?? 9876);

const DEPLOY_MS = 1_500;
const STOP_MS = 1_200;
const REMOVE_MS = 1_200;
const STAMP_SETTLE_MS = 4_000;

// The offline simulator records transaction evidence separately from its balances.
const CHEQUEBOOK_SETTLE_MS = 3_000;

const CHEQUEBOOK_FLOOR_PLUR = bzzToPlur(DEFAULT_CHEQUEBOOK_FLOOR_BZZ);

/**
 * The chain endpoint this offline manager is configured with, which is what it
 * offers every Bee node it creates. A real one reads BEE_RPC_ENDPOINT.
 */
const BEE_RPC_ENDPOINT = 'https://rpc.offline.example:8545/k/synthetic-not-a-key';

/**
 * Whether it is running as a manager that has one. `GET /config?state=none`
 * turns it off and `?state=configured` puts it back, so the wizard can be
 * reviewed both ways. It sticks, the way every other faked state here does:
 * the page reads /config once at boot, so a state that lasted one request
 * could never be seen.
 */
let beeRpcEndpointConfigured = true;

function managerEndpoint() {
  return beeRpcEndpointConfigured ? BEE_RPC_ENDPOINT : null;
}

// ----------------------------------------------------------- transitions

const eventClients = new Set();

function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== 'object') return value;
  const projected = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, publicValue(entry)]),
  );
  if ('rpc_endpoint_source' in projected && 'rpc_endpoint' in projected) {
    const endpoint = configuredBeeRpcEndpoint(projected.rpc_endpoint);
    delete projected.rpc_endpoint;
    projected.has_rpc_endpoint = endpoint.configured;
    projected.rpc_endpoint_host = endpoint.host;
  }
  return projected;
}

function send(res, status, body, headers) {
  sendRaw(res, status, publicValue(body), headers);
}

function publish(event) {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(publicValue(event))}\n\n`;
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

/** @param onRunning runs once the row is RUNNING again, before that change is published. */
function deploy(profile, { withUploader, onRunning } = {}) {
  profile.status = 'DEPLOYING';
  profile.last_error = null;
  profile.last_error_at = null;
  changed(profile);
  const containers = containersFor(profile, {
    withUploader:
      withUploader ??
      (!needsStamp(profile) ||
        Boolean(profile.stamp_id) ||
        Boolean(profile.bee_publishers)),
  });
  // The guard the manager takes before anything runs, resolved the way a
  // deploy that gave every service a new container resolves it.
  const attempt = openAttempt(
    profile,
    containers.map((container) => container.service),
    publish,
  );
  setTimeout(() => {
    profile.status = 'RUNNING';
    profile.containers = containers;
    resolveAttempt(attempt, publish);
    onRunning?.();
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
    forgetEngineConfig(profile);
    state.profiles = state.profiles.filter((entry) => entry.name !== profile.name);
    state.nodes.delete(profile.name);
    state.srtPassphrases.delete(profile.name);
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

// ----------------------------------------------------------- chequebook

/**
 * What a deployment's stream-uploader says about itself, as the manager's read
 * of it (see UploaderHealthService). `ok` unless this mock has been told
 * otherwise, and `?state=waiting_for_node`, `?state=warned` or `?state=ok` tells
 * it, sticking on the node entry the way every other faked node state does. It
 * has to stick: the deployment page re-reads this every ten seconds, so a state
 * that lasted one request would flash and be gone.
 */
function uploaderHealth(req, profile) {
  const entry = node(profile.name);
  const asked = new URL(req.url, 'http://mock').searchParams.get('state');
  if (asked === 'ok') entry.uploaderHealth = null;
  else if (asked === 'waiting_for_node' || asked === 'warned') {
    entry.uploaderHealth = { state: asked, since: new Date().toISOString() };
  }

  if (!profile.containers.some((container) => container.service === 'stream-uploader')) {
    return { state: 'not_deployed', reasons: [] };
  }

  const faked = entry.uploaderHealth;
  if (faked?.state === 'waiting_for_node') {
    const port = PORT_BASES.BEE_UPLOADER_API_PORT + profile.port_slot * 10;
    return {
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      waitingSince: faked.since,
      node: {
        url: `http://${PUBLIC_HOST}:${port}`,
        // Climbs with the wait, the way the uploader's own backoff does.
        attempts: attemptsSince(faked.since),
        lastError: 'timeout of 20000ms exceeded',
      },
    };
  }
  if (faked?.state === 'warned') {
    return {
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'ChequebookGate', rung: '360p' }],
    };
  }
  return { state: 'ok', reasons: [] };
}

/** One attempt a second at first, then one every thirty, which is the uploader's own backoff. */
function attemptsSince(since) {
  const seconds = Math.max(0, (Date.now() - Date.parse(since)) / 1_000);
  return seconds <= 31 ? Math.min(6, Math.floor(seconds) + 1) : 6 + Math.floor((seconds - 31) / 30);
}

function chequebookSummary(name) {
  const entry = nodeIfKnown(name);
  if (!entry) {
    return {
      address: null,
      totalBalance: null,
      availableBalance: null,
      totalSent: null,
      totalReceived: null,
      health: chequebookHealthPayload(
        chequebookHealthFrom(null, CHEQUEBOOK_FLOOR_PLUR),
      ),
    };
  }

  const { chequebook } = entry;
  return {
    address: chequebook.address,
    totalBalance: chequebook.total,
    availableBalance: chequebook.available,
    totalSent: chequebook.totalSent,
    totalReceived: chequebook.totalReceived,
    health: chequebookHealthPayload(
      chequebookHealthFrom(
        {
          totalBalance: chequebook.total,
          availableBalance: chequebook.available,
        },
        CHEQUEBOOK_FLOOR_PLUR,
      ),
    ),
  };
}

const chequebookJournal = createMockChequebookJournal({
  profileFor: findProfile,
  nodeFor: nodeIfKnown,
  userFor,
  onSubmitted(operation) {
    const entry = nodeIfKnown(operation.profileName);
    setTimeout(() => {
      chequebookJournal.observeReceipt(operation.id, { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${hex(32)}`,
        finalizedBlockNumber: '510', finalizedBlockHash: `0x${hex(32)}` });
      if (!entry || entry.ethereum.toLowerCase() !== operation.nodeAddress) return;
      const amount = BigInt(operation.amountPlur);
      const walletDelta = operation.direction === 'deposit' ? -amount : amount;
      entry.bzz = String(BigInt(entry.bzz) + walletDelta);
      entry.chequebook.total = String(BigInt(entry.chequebook.total) - walletDelta);
      entry.chequebook.available = String(BigInt(entry.chequebook.available) - walletDelta);
    }, CHEQUEBOOK_SETTLE_MS);
  },
});

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

function openStream(res, clients) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

/**
 * Wraps a handler that needs a profile, so the 404 is written once.
 *
 * The raw match groups follow the profile, for the routes that carry a second
 * one (the container name in the log and restart paths).
 */
function withProfile(handler) {
  return (req, res, params) => {
    const profile = findProfile(params[0]);
    if (!profile) {
      return send(res, 404, { error: `profile ${params[0]} not found` });
    }
    return handler(req, res, profile, params);
  };
}

const EDITABLE_FIELDS = [
  'notes',
  'feed_owner',
  'feed_topic',
  'public_key',
  'stamp_id',
  'bee_publishers',
  'bee_url',
];

/** The manager's rule: a note saved from a page that loaded before another save is refused. */
function notesMoved(profile, body) {
  return body.notes_revision !== undefined && body.notes_revision !== profile.notes_revision;
}

function notesConflict(profile) {
  return {
    error: 'notes_conflict',
    name: profile.name,
    message: `The notes of ${profile.name} changed since this page loaded. Reload to see them, then save again.`,
  };
}

/**
 * The two secrets, which are not editable fields like the others: the manager
 * answers neither on the row, so no page can send one back, and a body that
 * says nothing about them keeps what is stored. The passphrase differs in
 * being one an operator may also give up, by sending an explicit null for the
 * host-wide one.
 */
function applySecrets(profile, body) {
  if (body.private_key) profile.has_private_key = true;
  setSrtPassphrase(profile, body.srt_passphrase);
}

/**
 * Why this edit cannot be stored, or null.
 *
 * A node's mode is chosen when it is created: a body may repeat the mode the
 * deployment already runs in and may not name another. The endpoint moves, by
 * the same shared rule a create is held to.
 */
function nodeEditProblem(profile, body) {
  const mode = body.node_mode ?? undefined;
  if (mode && mode !== effectiveNodeMode(profile)) {
    return 'a node’s mode is chosen when it is created';
  }
  return rpcEndpointChoiceProblem({
    source: editedSource(profile, body),
    url: editedEndpoint(profile, body),
    managerHasEndpoint: beeRpcEndpointConfigured,
    nodeMode: mode ?? profile.node_mode,
    services: defaultServicesFor(profile),
  });
}

/** The custom address after this edit, preserving it unless the body changes it or its source. */
function editedEndpoint(profile, body) {
  if ('rpc_endpoint' in body) return body.rpc_endpoint ?? null;
  if (
    body.rpc_endpoint_source !== undefined &&
    body.rpc_endpoint_source !== CUSTOM_RPC_ENDPOINT_SOURCE
  ) {
    return null;
  }
  return profile.rpc_endpoint;
}

/** Where an edit leaves this node's endpoint, named or kept. */
function editedSource(profile, body) {
  return (
    body.rpc_endpoint_source ??
    keptRpcEndpointSource({
      url: editedEndpoint(profile, body),
      stored: profile.rpc_endpoint_source,
      managerHasEndpoint: beeRpcEndpointConfigured,
      nodeMode: body.node_mode ?? profile.node_mode,
      services: defaultServicesFor(profile),
    })
  );
}

/** PUT semantics, like the manager: every editable field is replaced, an absent one becomes null. */
function replaceEditable(profile, body) {
  for (const field of EDITABLE_FIELDS) profile[field] = body[field] ?? null;
  profile.rpc_endpoint_source = editedSource(profile, body);
  profile.rpc_endpoint = editedEndpoint(profile, body);
  if (body.node_mode) profile.node_mode = body.node_mode;
  applySecrets(profile, body);
}

/** PATCH semantics: only the fields present in the body change. */
function applyEdits(profile, body) {
  for (const field of EDITABLE_FIELDS) {
    if (field in body) profile[field] = body[field] ?? null;
  }
  if ('rpc_endpoint' in body || 'rpc_endpoint_source' in body) {
    profile.rpc_endpoint_source = editedSource(profile, body);
    profile.rpc_endpoint = editedEndpoint(profile, body);
  }
  applySecrets(profile, body);
}

/**
 * The two things a create says about its Bee node, resolved the way the
 * manager resolves them, or why they cannot be stored.
 *
 * A body that names no source means one all the same: an address and nothing
 * else is a custom endpoint, and otherwise the manager's own is what it offers.
 * The refusals are the shared rules, so a form that passes here passes on a
 * host.
 */
function nodeChoicesFor(body, extra = {}) {
  const shape = {
    kind: extra.kind ?? body.kind ?? 'custom',
    components: extra.components ?? body.components,
    node_mode: body.node_mode ?? null,
  };
  const services = defaultServicesFor(shape);
  const source =
    body.rpc_endpoint_source ??
    impliedRpcEndpointSource({
      url: body.rpc_endpoint,
      managerHasEndpoint: beeRpcEndpointConfigured,
      nodeMode: shape.node_mode,
      services,
    });
  return {
    rpc_endpoint_source: source,
    node_mode: shape.node_mode,
    rpc_endpoint: source === CUSTOM_RPC_ENDPOINT_SOURCE ? (body.rpc_endpoint ?? null) : null,
    problem:
      rpcEndpointChoiceProblem({
        source,
        url: body.rpc_endpoint,
        managerHasEndpoint: beeRpcEndpointConfigured,
        nodeMode: shape.node_mode,
        services,
      }) ?? nodeModeProblem(shape),
  };
}

function refuse(res, problem) {
  send(res, 400, { error: 'validation_error', errors: [problem] });
}

function createFromBody(body, extra = {}) {
  const { problem, ...choices } = nodeChoicesFor(body, extra);
  const profile = makeProfile({
    ...body,
    ...choices,
    ...extra,
    status: 'DEPLOYING',
    created_at: new Date().toISOString(),
    stack_version_id: body.stack_version_id ?? defaultVersionId(),
  });
  state.profiles.push(profile);
  refreshDerived(profile);
  node(profile.name);
  setTimeout(() => deploy(profile), 0);
  return profile;
}

const ROUTES = [
  ['GET', /^\/health$/, (_req, res) => send(res, 200, { status: 'ok' })],
  ...authRoutes(readBody),
  [
    'GET',
    /^\/config$/,
    (req, res) => {
      const asked = new URL(req.url, 'http://mock').searchParams.get('state');
      if (asked === 'none' || asked === 'unconfigured') beeRpcEndpointConfigured = false;
      else if (asked === 'configured') beeRpcEndpointConfigured = true;
      send(res, 200, {
        host: PUBLIC_HOST,
        srtPassphrase: HOST_PASSPHRASE,
        chequebookFloorBzz: plurToBzz(CHEQUEBOOK_FLOOR_PLUR),
        // The host and never the URL: this one carries a path after it, which
        // is where a real endpoint's API key would sit.
        beeRpcEndpoint: configuredBeeRpcEndpoint(managerEndpoint()),
      });
    },
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
      const versionProblem = newDeploymentVersionProblem(body.stack_version_id);
      if (versionProblem) return refuse(res, versionProblem);
      const { problem } = nodeChoicesFor(body);
      if (problem) return refuse(res, problem);
      send(res, 202, createFromBody(body));
    },
  ],
  ['GET', /^\/profiles\/([^/]+)$/, withProfile((_req, res, p) => send(res, 200, p))],
  // One deployment's passphrase, on request, the way the manager answers it:
  // never on a list, never on an event, and never cached.
  [
    'GET',
    /^\/profiles\/([^/]+)\/srt-passphrase$/,
    withProfile((_req, res, p) =>
      send(res, 200, { srt_passphrase: srtPassphraseOf(p.name) }, {
        'cache-control': 'no-store',
      }),
    ),
  ],
  [
    'PUT',
    /^\/profiles\/([^/]+)$/,
    withProfile(async (req, res, profile) => {
      const refusal = attemptRefusal(profile);
      if (refusal) return send(res, 409, refusal);
      const body = await readBody(req);
      if ('notes' in body && notesMoved(profile, body)) {
        send(res, 409, notesConflict(profile));
        return;
      }
      const editProblem = nodeEditProblem(profile, body);
      if (editProblem) return refuse(res, editProblem);
      const notesBefore = profile.notes;
      replaceEditable(profile, body);
      if (profile.notes !== notesBefore) profile.notes_revision += 1;
      closeRollout(profile, 'Redeployed by the operator before the file was verified.');
      deploy(profile);
      send(res, 202, profile);
    }),
  ],
  [
    'PATCH',
    /^\/profiles\/([^/]+)\/notes$/,
    withProfile(async (req, res, profile) => {
      const body = await readBody(req);
      if (notesMoved(profile, body)) {
        send(res, 409, notesConflict(profile));
        return;
      }
      profile.notes = body.notes ?? null;
      profile.notes_revision += 1;
      profile.updated_at = new Date().toISOString();
      changed(profile);
      send(res, 200, profile);
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
      const refusal = attemptRefusal(profile);
      if (refusal) return send(res, 409, refusal);
      closeRollout(profile, 'Redeployed by the operator before the file was verified.');
      deploy(profile);
      sendScriptRun(res, 'deploy.sh', [`--profile=${profile.name}`]);
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/stop$/,
    withProfile((_req, res, profile) => {
      closeRollout(profile, 'Stopped by the operator before the file was verified.');
      stop(profile);
      sendScriptRun(res, 'stop.sh', [`--profile=${profile.name}`]);
    }),
  ],
  [
    'POST',
    /^\/profiles\/([^/]+)\/deploy-uploader$/,
    withProfile((_req, res, profile) => {
      // Nothing about funding refuses a start, on the owner's ruling of
      // 2026-09-17. What a dry chequebook costs shows up on the deployment
      // page, from the uploader's own health.
      deploy(profile, { withUploader: true });
      sendScriptRun(res, 'deploy.sh', [`--profile=${profile.name}`, 'stream-uploader']);
    }),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/uploader-health$/,
    withProfile((req, res, profile) => send(res, 200, uploaderHealth(req, profile))),
  ],
  [
    'GET',
    /^\/profiles\/([^/]+)\/chequebook$/,
    (_req, res, [name]) => send(res, 200, chequebookSummary(name)),
  ],
  ...chequebookJournal.routes,
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
        currentPrice: MOCK_CURRENT_PRICE,
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
  ...stampChangeRoutes({ readBody, withProfile }),
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
      const versionProblem = newDeploymentVersionProblem(body.stack_version_id);
      if (versionProblem) return refuse(res, versionProblem);
      const isPool = Boolean(body.abr_ladder);
      // Judged on what a member will be rather than on the group body, because
      // a pool's members are four bee-uploaders whatever the body's kind says.
      const memberShape = isPool ? { kind: 'custom', components: ['bee-uploader'] } : {};
      const { problem } = nodeChoicesFor(body, memberShape);
      if (problem) return refuse(res, problem);
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
            node_mode: template.node_mode ?? null,
            rpc_endpoint_source: template.rpc_endpoint_source,
            rpc_endpoint: template.rpc_endpoint,
            srt_passphrase: srtPassphraseOf(template.name),
          },
          { group_id: group.id },
        ),
      );
      group.size += profiles.length;
      send(res, 202, { group, profiles });
    },
  ],
  ...attemptRoutes(readBody, publish),
  ...createTargetRoutes(readBody),
  ...engineRoutes({ readBody, withProfile, findProfile, deploy, publish }),
  ...engineConfigRoutes({ readBody, withProfile, deploy, publish }),
  ...versionRoutes(readBody, publish),
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
  const path = decodeURI(new URL(req.url, `http://${PUBLIC_HOST}`).pathname);

  // The same gate the manager has: a write that did not come from our own
  // pages, or any request without a session, never reaches a route.
  if (refuseRequest(req, res, path)) return;

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
seedAuth();
seedVersions();
const held = seedAttempts();
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `mock manager on http://127.0.0.1:${PORT} (this machine only) with ${state.profiles.length} profiles, ${state.groups.length} groups and ${state.versions.length} stack versions\n` +
      `sign in as ${DEV_USERNAME} / ${DEV_PASSWORD}\n` +
      (held
        ? `${held.project} has a blocked deploy attempt, ${held.jobId}, holding every deploy of a version with shared image tags, as the manager would. Release it on the Versions page first.\n`
        : ''),
  );
});
