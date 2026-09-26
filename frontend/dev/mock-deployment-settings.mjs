/**
 * A deployment's own settings, for the mock manager: the list, a save and
 * Apply, in the shapes `manager/src/api/routes/deploymentSettings.ts`
 * answers.
 *
 * The rules are the manager's own where they can be: the body is checked by
 * its save schema, a save is refused by its `settingEditProblems` and by the
 * web2 admin rule a save and a create are both held to, and which control
 * decides a key is its `settingOwnerOf`. The keys are a shortened copy
 * of the stack's samples, with the stack's sections, kinds of key and
 * readers. What each deployment's containers were started with is recorded
 * whenever a deploy lands, which is what the list compares to say which
 * settings they are behind on.
 *
 * Seeded so every state can be seen offline: main-stage is behind on one
 * saved key, old-demo is stopped with one waiting for its Start, and
 * field-unit's containers were started before anything was recorded.
 *
 * It also answers the list a deployment not created yet starts with, which
 * the new-deployment wizard edits, and stores what a create sends, checked
 * against that list by the manager's own `settingEditProblems`.
 *
 * A deployment's engine settings are in its list as its own, as on the
 * manager: the fields, the host defaults and what its config reads come from
 * the Engine card's own reading in `mock-engine.mjs`, a save puts an engine key
 * in the deployment's engine settings and judges them by the engine's shared
 * rules, and the engine settings route scripts use moves the same revision.
 *
 * A secret's value is never kept here. The mock records that one was stored,
 * and at which revision, which is all the list and the comparison need.
 */
import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  adminLinkEditProblem,
  defaultServicesFor,
  editsEngineSettings,
  engineOfServices,
  engineSettingFieldOf,
  engineSettingsAfterEdits,
  engineSettingsSaveProblem,
  isNotReadOwner,
  isSecretSettingKey,
  stackSettingFieldOf,
} from '@streaming-infra-manager/common';

import { SERVICE_ENV_KEYS } from '../../manager/src/domain/containerKeysSpec.ts';
import { adminLinkBeforeOf } from '../../manager/src/domain/settings/adminLinkBefore.ts';
import { settingEditProblems } from '../../manager/src/domain/settings/settingEditProblems.ts';
import { settingOwnerOf } from '../../manager/src/domain/settings/settingOwners.ts';
import {
  applyDeploymentSettingsSchema,
  newDeploymentSettingsField,
  saveDeploymentSettingsSchema,
} from '../../manager/src/schemas/deploymentSettings.ts';
import { newDeploymentShapeQuerySchema, servicesOfList } from '../../manager/src/schemas/profile.ts';
import { managerAdminLink, mockTestOutcome } from './mock-admin-link.mjs';
import { engineSettingsFacts } from './mock-engine.mjs';
import { send } from './mock-http.mjs';
import { PORT_BASES, state } from './mock-seed.mjs';

const UPLOADER = ['stream-uploader'];

const ADMIN_URL_DESCRIPTION =
  'Where the admin service lives. Setting ADMIN_API_URL by itself turns admin mode ON. Leaving it empty keeps this deployment exactly as it has always been, and the uploader mints each stream\'s feed topic itself. With it set, a stream has to be DECLARED in the admin before anything may publish to it. The admin mints the feed topic and the publish key, each engine refuses any publish that is unannounced or presents the wrong key, and the uploader publishes on the declared topic and reports live and vod back instead of writing the catalog.';

const START_GATES_DESCRIPTION =
  'What the two startup gates below do about a node they cannot clear. chequebook-warn, the default, warns about the chequebook and starts, and refuses a postage batch the node answered about. warn warns about both and starts. refuse refuses both, which is what every boot did before 2026-09-17. A refusal stops the service and docker restarts it into the same refusal until someone reads the log.';

/**
 * The root sample's keys in its order. `version` is what the version's own
 * `.env` sets, and a key without one is left to the stack's default.
 */
const ROOT_SAMPLE = [
  { key: 'STAMP', section: 'Required, and the stamp purchase defaults', description: 'The postage batch every upload pays with. Required only when BEE_PUBLISHERS below is empty.', version: '', services: UPLOADER },
  { key: 'STAMP_IMMUTABLE', section: 'Required, and the stamp purchase defaults', description: 'Whether a batch bought with pnpm stamp:setup is immutable. An immutable batch refuses uploads once full, a mutable one overwrites its oldest chunks.', version: 'false', services: null },
  { key: 'API_AUTH_TOKEN', section: 'Required, and the stamp purchase defaults', description: 'Bearer token for every gated route of the uploader. Required, because every accepted segment spends postage stamp money. Generate one with openssl rand -hex 32.', version: '', services: ['srs', 'stream-uploader'] },
  { key: 'ADMIN_API_URL', section: 'Admin mode', description: ADMIN_URL_DESCRIPTION, version: '', services: ['srs', 'stream-uploader'] },
  { key: 'ADMIN_API_TOKEN', section: 'Admin mode', description: "Bearer token for the admin's internal routes, required whenever ADMIN_API_URL is set. Minimum 32 characters.", version: '', services: ['srs', 'stream-uploader'] },
  { key: 'BEE_URL', section: 'Stream Uploader', description: 'Where the uploader reaches Bee when the deployment runs no node of its own.', version: 'http://localhost:1633', services: UPLOADER },
  { key: 'BEE_PUBLISHERS', section: 'Stream Uploader', description: 'One Bee node per ABR rung, as rung@url<batch>, space separated. Empty means one node for everything.', version: '', services: UPLOADER },
  { key: 'BEE_REQUEST_TIMEOUT_MS', section: 'Stream Uploader', description: 'How long one Bee call may take before the uploader gives up on it and retries.', version: '4000', services: UPLOADER },
  { key: 'MAX_QUEUE_SIZE', section: 'Stream Uploader', description: 'How many segments may wait for an upload before the oldest is dropped.', version: '100', services: UPLOADER },
  { key: 'UPLOADER_START_GATES', section: 'Stream Uploader', description: START_GATES_DESCRIPTION, version: 'chequebook-warn', services: UPLOADER },
  { key: 'START_GATE_TIMEOUT_MS', section: 'Stream Uploader', description: 'How long each read of a startup gate may take.', version: '20000', services: UPLOADER },
  { key: 'CHEQUEBOOK_MIN_BZZ', section: 'Stream Uploader', description: 'The chequebook floor, in BZZ, that every Bee node must hold available for the uploader to call it funded.', version: '0.5', services: UPLOADER },
  { key: 'CHEQUEBOOK_RECHECK_MS', section: 'Stream Uploader', description: 'How often a chequebook the uploader warned about is read again, so /health clears once it is funded.', version: '60000', services: UPLOADER },
  { key: 'STAMP_MIN_TTL_HOURS', section: 'Stream Uploader', description: 'How much time a postage batch must have left for the uploader to call it usable.', version: '12', services: UPLOADER },
  { key: 'STAMP_MAX_UTILIZATION', section: 'Stream Uploader', description: 'How full an immutable postage batch may be for the uploader to call it usable.', version: '0.9', services: UPLOADER },
  { key: 'CLIENT_PORT', section: 'Client', description: 'The port the viewer is served on.', version: '5173', services: ['client'] },
  { key: 'VITE_APP_OWNER', section: 'Client', description: 'The feed owner the viewer reads the stream catalog of.', version: '', services: ['client'] },
  { key: 'BEE_UPLOADER_FULL_NODE', section: 'Bee Nodes (Docker deployment)', description: 'Whether the uploader node runs as a full node. Read by the deploy scripts, so a change redeploys everything.', version: 'false', services: null },
  { key: 'BEE_GATEWAY_CACHE_RETRIEVAL', section: 'Bee Nodes (Docker deployment)', description: 'Whether the gateway node keeps what it retrieves in its cache.', version: 'true', services: ['bee-gateway'] },
  { key: 'LOG_LEVEL', section: 'Logging', description: 'How much the uploader logs. An unrecognized value is reported once and then ignored.', version: 'info', services: UPLOADER },
  { key: 'LOG_FORMAT', section: 'Logging', description: 'Empty for plain lines, json for one JSON object per line.', version: '', services: UPLOADER },
];

/**
 * The engine samples, whose keys the root sample does not declare. An engine
 * setting among them is read by the services the manager's own list names,
 * which `listedOf` gives it.
 */
const ENGINE_SAMPLES = {
  srs: [
    { key: 'HLS_FRAGMENT', section: 'SRS Media Server', description: 'Segment length in seconds.' },
    { key: 'HLS_WINDOW', section: 'SRS Media Server', description: 'The playlist window in seconds.' },
    { key: 'SRS_WEBHOOK_TOKEN', section: 'SRS Media Server', description: 'The token SRS sends with every webhook, which the uploader checks.', version: '', services: ['srs', 'stream-uploader'] },
  ],
  ome: [
    { key: 'HLS_SEGMENT_DURATION', section: 'OvenMediaEngine', description: 'Segment length in seconds.' },
    { key: 'OME_ADMISSION_SECRET', section: 'OvenMediaEngine', description: 'The secret OvenMediaEngine signs its admission requests with.', version: '', services: ['ome', 'stream-uploader'] },
  ],
};

/** What the seeded deployments store, and what their containers were last started with. */
const SEEDS = {
  'main-stage': {
    plain: { LOG_LEVEL: 'debug', OLD_UPLOAD_RETRIES: '5' },
    secrets: ['ADMIN_API_TOKEN'],
    // Started before LOG_LEVEL was saved, so the page opens behind on it.
    startedWith: { LOG_LEVEL: 'info' },
  },
  'old-demo': {
    plain: { CHEQUEBOOK_MIN_BZZ: '1' },
    secrets: [],
    startedWith: { CHEQUEBOOK_MIN_BZZ: '0.5' },
  },
  // Deployed before the manager recorded what each container got.
  'field-unit': { plain: {}, secrets: [], unrecorded: true },
};

/** The services whose containers read each key, from the manager's own list, as a version without a contract has them. */
const READERS = new Map();
for (const [service, keys] of Object.entries(SERVICE_ENV_KEYS)) {
  for (const key of keys) READERS.set(key, [...(READERS.get(key) ?? []), service]);
}

const RUNNING_STATUSES = ['RUNNING', 'ERROR'];
const BUSY_STATUSES = ['DEPLOYING', 'STOPPING', 'REMOVING'];

/** By instance, so a deployment removed and created again under its name starts empty. */
const stores = new Map();
const seededNames = new Set();

function storeOf(profile) {
  let store = stores.get(profile.instance_id);
  if (store) return store;
  const seed = seededNames.has(profile.name) ? undefined : SEEDS[profile.name];
  seededNames.add(profile.name);
  store = {
    revision: 0,
    plain: { ...(seed?.plain ?? {}) },
    /** Secret key to the revision it was stored at, which stands in for its value. */
    secrets: new Map((seed?.secrets ?? []).map((key) => [key, 0])),
    record: null,
  };
  stores.set(profile.instance_id, store);
  if (!seed?.unrecorded) {
    const values = { ...nextValuesOf(profile, store), ...(seed?.startedWith ?? {}) };
    store.record = { values, services: servicesOf(profile) };
  }
  return store;
}

function servicesOf(profile) {
  return profile.containers.length > 0
    ? profile.containers.map((container) => container.service)
    : defaultServicesFor(profile);
}

function versionOf(profile) {
  return state.versions.find((version) => version.id === profile.stack_version_id) ?? null;
}

/** A sample key with the services that read it, which for an engine setting are the manager's own list's. */
function withReaders(sample) {
  return engineSettingFieldOf(sample.key) ? { ...sample, services: READERS.get(sample.key) ?? null } : sample;
}

/** The root sample's keys, then those of the engine a deployment of this shape runs, if it runs one. */
function samplesFor(shape) {
  const engine = engineOfServices(defaultServicesFor(shape));
  return [...ROOT_SAMPLE, ...(engine ? ENGINE_SAMPLES[engine] ?? [] : [])].map(withReaders);
}

/** Who sets a key of the deployment's own list, where the deployment sets the engine settings it reads. */
function ownerOf(key, profile, facts) {
  const contract = versionOf(profile)?.contract;
  const engineReader = { engine: facts?.engine ?? null, abr: facts?.abr ?? false };
  return settingOwnerOf(key, { ports: contract?.ports ?? [], isLocalTarget: false, engineReader });
}

/** Whether the key is an engine setting the deployment reads, which its own list lets the operator set. */
function isOwnEngineSetting(key, facts) {
  return Boolean(facts?.fields.some((field) => field.key === key));
}

/** What a control of the deployment decides for its key. */
function ownedValue(key, owner, profile) {
  switch (owner) {
    case 'stamp':
      return profile.stamp_id ?? '';
    case 'node-pool':
      return profile.bee_publishers ?? '';
    case 'bee-url':
      return profile.bee_url ?? (servicesOf(profile).includes('bee-uploader') ? 'http://bee-uploader:1633' : '');
    case 'feed-owner':
      return profile.feed_owner ?? '';
    case 'port-slot':
      return String((PORT_BASES[key] ?? PORT_BASES.API_PORT) + profile.port_slot * 10);
    default:
      return '';
  }
}

function isGenerated(key, profile) {
  return (versionOf(profile)?.contract?.requiredSecrets ?? []).includes(key);
}

/**
 * What the next deploy gives each key, as a value to compare. A secret
 * stands as where it comes from rather than as its value, which the mock
 * never holds. An engine setting the deployment does not read is not written
 * for it, whatever is stored, so it is what the version sets.
 */
function nextValueOf(sample, profile, store, facts) {
  if (isOwnEngineSetting(sample.key, facts)) return engineNextValue(sample.key, profile, facts);
  const owner = ownerOf(sample.key, profile, facts);
  if (owner && isNotReadOwner(owner)) return sample.version;
  if (owner) return ownedValue(sample.key, owner, profile);
  if (store.secrets.has(sample.key)) return `stored at revision ${store.secrets.get(sample.key)}`;
  if (sample.key in store.plain) return store.plain[sample.key];
  if (isSecretSettingKey(sample.key) && isGenerated(sample.key, profile)) return 'generated';
  return sample.version;
}

/**
 * What the next deploy writes for an engine setting: the stored value, or the
 * manager's own default, which it writes where the host sets none. Any other
 * default is left unset, as the manager leaves it.
 */
function engineNextValue(key, profile, facts) {
  const stored = profile.engine_settings[key];
  if (stored !== undefined) return stored;
  return facts.defaults.sources[key] === 'manager' ? facts.defaults.values[key] : undefined;
}

function nextValuesOf(profile, store) {
  const facts = engineSettingsFacts(profile);
  const values = {};
  for (const sample of listedOf(profile, store, facts)) values[sample.key] = nextValueOf(sample, profile, store, facts);
  return values;
}

/**
 * The samples' keys, then the engine settings the deployment reads that no
 * sample declares, then the stored keys none of those name any more. An
 * engine setting is read by the services the manager's own list names.
 */
function listedOf(profile, store, facts) {
  const declared = samplesFor(profile);
  const known = new Set(declared.map(({ key }) => key));
  const engine = (facts?.fields ?? [])
    .filter(({ key }) => !known.has(key))
    .map(({ key }) => ({ key, section: '', description: '', services: READERS.get(key) ?? null }));
  for (const { key } of engine) known.add(key);
  const dropped = [...Object.keys(store.plain), ...store.secrets.keys(), ...Object.keys(profile.engine_settings)]
    .filter((key) => !known.has(key))
    .map((key) => withReaders({ key, section: '', description: '', services: null, undeclared: true }));
  return [...declared, ...engine, ...dropped];
}

/** The services whose containers were started with another value for the key, or 'unknown'. */
function differingServices(sample, next, store) {
  if (!store.record) return 'unknown';
  const readers = sample.services === null
    ? store.record.services
    : store.record.services.filter((service) => sample.services.includes(service));
  if (readers.length === 0) return 'unknown';
  return store.record.values[sample.key] === next ? [] : readers;
}

/** What the deployment stores for a key: in its engine settings for an engine setting, in the store for any other. */
function isStored(key, profile, store) {
  if (engineSettingFieldOf(key)) return key in profile.engine_settings;
  return key in store.plain || store.secrets.has(key);
}

function storedValueOf(key, profile, store) {
  if (engineSettingFieldOf(key)) return profile.engine_settings[key] ?? null;
  return isSecretSettingKey(key) ? null : (store.plain[key] ?? null);
}

function sourceOf(sample, owner, profile, store) {
  if (owner && !isNotReadOwner(owner)) return 'manager';
  if (isStored(sample.key, profile, store)) return 'deployment';
  if (isSecretSettingKey(sample.key) && isGenerated(sample.key, profile)) return 'generated';
  return sample.version === undefined ? 'unset' : 'version';
}

function runningStateOf(running, differing) {
  if (!running) return 'not-running';
  if (differing === 'unknown') return 'unknown';
  return differing.length > 0 ? 'differs' : 'same';
}

/**
 * An engine setting the deployment reads, which its list lets the operator
 * set, with the default an unset one falls back to on this host.
 */
function engineEntryOf(sample, profile, store, running, facts) {
  const { key } = sample;
  const next = engineNextValue(key, profile, facts);
  const stored = profile.engine_settings[key];
  const defaultSource = facts.defaults.sources[key] ?? 'stack';
  const differing = differingServices(sample, next, store);
  return {
    entry: {
      key,
      section: sample.section,
      description: sample.description,
      declared: true,
      secret: false,
      sampleValue: sample.version ?? null,
      versionSet: true,
      versionValue: facts.defaults.values[key] ?? null,
      stored: stored !== undefined,
      storedValue: stored ?? null,
      value: next ?? null,
      source: stored !== undefined ? 'deployment' : defaultSource === 'manager' ? 'manager-default' : 'version',
      owner: null,
      field: null,
      services: sample.services,
      running: runningStateOf(running, differing),
      engineSetting: { defaultSource, notInConfig: facts.notInConfig.includes(key) },
    },
    differing: differing === 'unknown' ? [] : differing,
  };
}

function entryOf(sample, profile, store, running, facts) {
  if (isOwnEngineSetting(sample.key, facts)) return engineEntryOf(sample, profile, store, running, facts);
  const { key } = sample;
  const secret = isSecretSettingKey(key);
  const owner = ownerOf(key, profile, facts);
  const next = nextValueOf(sample, profile, store, facts);
  const versionSet = sample.version !== undefined;
  const differing = differingServices(sample, next, store);
  return {
    entry: {
      key,
      section: sample.section,
      description: sample.description,
      declared: !sample.undeclared,
      secret,
      sampleValue: sample.version ?? null,
      versionSet,
      versionValue: secret || !versionSet ? null : sample.version,
      stored: isStored(key, profile, store),
      storedValue: storedValueOf(key, profile, store),
      value: secret || next === undefined ? null : next,
      source: sourceOf(sample, owner, profile, store),
      owner,
      field: stackSettingFieldOf(key),
      services: sample.services,
      running: runningStateOf(running, differing),
      engineSetting: null,
    },
    differing: differing === 'unknown' ? [] : differing,
  };
}

/**
 * The list a deployment not created yet starts with on a version, as
 * `GET /versions/:id/settings-catalog` answers it: nothing stored, nothing
 * running, the version's values, and no value yet for a key a control
 * decides, since the manager works that out at the first deploy.
 */
function newDeploymentCatalogOf(version, shape) {
  const isLocalTarget = !shape.host || shape.host === 'localhost';
  const required = version.contract?.requiredSecrets ?? [];
  const entries = samplesFor(shape).map((sample) => {
    const { key } = sample;
    const secret = isSecretSettingKey(key);
    const owner = settingOwnerOf(key, { ports: version.contract?.ports ?? [], isLocalTarget });
    const versionSet = sample.version !== undefined;
    const generated = secret && required.includes(key);
    return {
      key,
      section: sample.section,
      description: sample.description,
      declared: true,
      secret,
      sampleValue: sample.version ?? null,
      versionSet,
      versionValue: secret || !versionSet ? null : sample.version,
      stored: false,
      storedValue: null,
      value: secret || owner || !versionSet ? null : sample.version,
      source: owner ? 'manager' : generated ? 'generated' : versionSet ? 'version' : 'unset',
      owner,
      field: stackSettingFieldOf(key),
      services: sample.services,
      running: 'not-running',
      engineSetting: null,
    };
  });
  return { versionId: version.id, buildId: version.buildId ?? null, entries };
}

function catalogOf(profile) {
  const store = storeOf(profile);
  const facts = engineSettingsFacts(profile);
  const running = RUNNING_STATUSES.includes(profile.status);
  const rows = listedOf(profile, store, facts).map((sample) => entryOf(sample, profile, store, running, facts));
  const behind = rows.filter(({ differing }) => differing.length > 0);
  return {
    instanceId: profile.instance_id,
    revision: store.revision,
    buildId: versionOf(profile)?.buildId ?? null,
    entries: rows.map(({ entry }) => entry),
    drift: {
      keys: behind.map(({ entry }) => entry.key),
      services: [...new Set(behind.flatMap(({ differing }) => differing))].sort(),
      fullRedeploy: behind.some(({ entry }) => entry.services === null),
    },
    running,
    engine: facts?.engine ?? null,
    abr: facts?.abr ?? false,
    engineSettingsProblem: facts ? storedEngineProblem(profile, facts) : null,
  };
}

/**
 * Why the manager's deploy would refuse the engine settings the deployment
 * stores, by the shared rules and this host's defaults, or null. Turning the
 * ladder on under a segment length the keyframe rule then refuses is how a
 * deployment of the mock gets there.
 */
function storedEngineProblem(profile, facts) {
  return engineSettingsSaveProblem(facts.engine, profile.engine_settings, { abr: facts.abr, defaults: facts.defaults.values });
}

/**
 * Moves the revision of a deployment whose engine settings the engine
 * settings route saved, as the manager's does, so a page that read before it
 * is refused rather than writing over it.
 */
export function engineSettingsSaved(profile) {
  storeOf(profile).revision += 1;
}

/**
 * Records what a deploy that just landed gave the deployment's containers.
 * The mock manager calls this whenever a deployment turns RUNNING, as the
 * manager records it at the end of every successful deploy.
 */
export function recordDeployedSettings(profile) {
  const store = storeOf(profile);
  store.record = { values: nextValuesOf(profile, store), services: servicesOf(profile) };
}

function withBody(schema, handler) {
  return async (req, res, profile, readBody) => {
    let body;
    try {
      body = await schema.validate(await readBody(req), { abortEarly: false, stripUnknown: true });
    } catch (error) {
      return send(res, 400, { error: 'validation_error', errors: error.errors ?? ['The request body is not valid.'] });
    }
    if (body.expectedInstanceId !== profile.instance_id) {
      return send(res, 409, {
        error: 'profile_instance_changed',
        name: profile.name,
        message: 'This deployment instance changed. Refresh before changing it.',
      });
    }
    return handler(res, profile, body);
  };
}

function notReadyAnswer(version) {
  return {
    error: 'settings_not_ready',
    name: version?.name ?? 'this version',
    message: `${version?.name ?? 'This version'} has no settings yet. It has no build to read them from.`,
  };
}

function notReady(res, profile) {
  return send(res, 409, notReadyAnswer(versionOf(profile)));
}

/**
 * Why a create's stack settings are refused, as a status and the body the
 * manager answers, or null. Checked against the list the version gives a
 * deployment of the shape the body describes, a group's per member. A create
 * that asks for the manager's stored web2 admin token is refused as the
 * manager refuses it: beside a typed token, for a version that takes none,
 * and when the manager stores none.
 */
export async function createdSettingsRefusal(stackSettings, version, shape, name, useManagerToken = false) {
  let settings;
  try {
    settings = await newDeploymentSettingsField().validate(stackSettings, { abortEarly: false });
  } catch (error) {
    return { status: 400, body: { error: 'validation_error', errors: error.errors ?? ['The stack settings are not valid.'] } };
  }
  const refused = (errors) => ({ status: 400, body: { error: 'validation_error', errors: [errors], name } });
  if ((!settings || settings.length === 0) && !useManagerToken) return null;
  if (!version?.buildId) return { status: 409, body: notReadyAnswer(version) };
  const entries = newDeploymentCatalogOf(version, shape).entries;
  const problems = settingEditProblems(settings ?? [], entries);
  if (useManagerToken) problems.push(...managerTokenProblems(settings ?? [], entries));
  if (problems.length > 0) return refused(problems.join(' '));
  const before = newAdminLinkBefore(version, shape);
  const adminProblem = adminLinkEditProblem(settings ?? [], useManagerToken ? { ...before, token: { current: true, afterReset: true } } : before);
  if (adminProblem) return refused(adminProblem);
  if (useManagerToken && !managerAdminLink.tokenStored) {
    return {
      status: 409,
      body: {
        error: 'admin_token_missing',
        message: 'The manager stores no web2 admin token to copy into this deployment. Type a token for it, or save one on Manager settings.',
      },
    };
  }
  return null;
}

/** Why the manager's stored token cannot go into a deployment created with these settings, in the manager's words. */
function managerTokenProblems(settings, entries) {
  if (settings.some(({ key }) => key === ADMIN_API_TOKEN_KEY)) {
    return [`${ADMIN_API_TOKEN_KEY} is typed for this deployment and also asked for from the manager's stored token. Send one of the two.`];
  }
  const entry = entries.find(({ key }) => key === ADMIN_API_TOKEN_KEY);
  if (!entry?.declared || entry.owner !== null) {
    return [`${ADMIN_API_TOKEN_KEY} is not a setting this deployment's version declares, so the manager's stored token has nowhere to go.`];
  }
  return [];
}

/** What the version's samples set, which a deployment not created yet starts with. */
function versionValuesFor(shape) {
  return Object.fromEntries(samplesFor(shape).filter((sample) => sample.version !== undefined).map((sample) => [sample.key, sample.version]));
}

/** The two web2 admin keys of a deployment not created yet, as the manager's create judges them. */
function newAdminLinkBefore(version, shape) {
  const values = versionValuesFor(shape);
  return adminLinkBeforeOf({ current: values, version: values, requiredSecrets: version.contract?.requiredSecrets ?? [] });
}

/**
 * A deployment's two web2 admin keys as its save judges them. A stored secret
 * counts as a token: the mock keeps no value, and the page cannot store an
 * empty one.
 */
function adminLinkBefore(profile, store) {
  return adminLinkBeforeOf({
    current: nextValuesOf(profile, store),
    version: versionValuesFor(profile),
    requiredSecrets: versionOf(profile)?.contract?.requiredSecrets ?? [],
  });
}

/**
 * Stores what a create sent for a deployment the mock has just made, as the
 * manager stores it at the insert, the manager's own web2 admin token among
 * it when the create asked for that. A secret's value is not kept, only that
 * one was stored. The deploy that lands records what the containers got.
 */
export function storeCreatedSettings(profile, stackSettings = [], useManagerToken = false) {
  const store = storeOf(profile);
  for (const { key, value } of stackSettings) {
    if (isSecretSettingKey(key)) store.secrets.set(key, store.revision);
    else store.plain[key] = value;
  }
  if (useManagerToken) store.secrets.set(ADMIN_API_TOKEN_KEY, store.revision);
}

/** Gives a member appended to a group the settings its sibling stores, as the manager copies them. */
export function copyStoredSettings(from, to) {
  const source = storeOf(from);
  const target = storeOf(to);
  Object.assign(target.plain, source.plain);
  for (const key of source.secrets.keys()) target.secrets.set(key, target.revision);
}

/** Why the engine would refuse what a save leaves in the engine settings, by the shared rules and this host's defaults. */
function engineSaveProblem(profile, entries) {
  const facts = engineSettingsFacts(profile);
  if (!facts || !editsEngineSettings(entries)) return null;
  return engineSettingsSaveProblem(facts.engine, engineSettingsAfterEdits(profile.engine_settings, entries), {
    abr: facts.abr,
    defaults: facts.defaults.values,
  });
}

function save(res, profile, body) {
  if (profile.status === 'REMOVING') {
    return send(res, 409, { error: 'profile_busy', name: profile.name, status: profile.status });
  }
  const problems = settingEditProblems(body.entries, catalogOf(profile).entries);
  if (problems.length > 0) {
    return send(res, 400, { error: 'validation_error', errors: [problems.join(' ')], name: profile.name });
  }
  const store = storeOf(profile);
  if (body.expectedRevision !== store.revision) {
    return send(res, 409, {
      error: 'deployment_settings_changed',
      name: profile.name,
      message: "This deployment's settings changed after the page read them. Reload them and make the change again.",
    });
  }
  const engineProblem = engineSaveProblem(profile, body.entries);
  if (engineProblem) {
    return send(res, 400, { error: 'validation_error', errors: [engineProblem], name: profile.name });
  }
  const adminProblem = adminLinkEditProblem(body.entries, adminLinkBefore(profile, store));
  if (adminProblem) {
    return send(res, 400, { error: 'validation_error', errors: [adminProblem], name: profile.name });
  }
  store.revision += 1;
  for (const { key, value } of body.entries) {
    if (engineSettingFieldOf(key)) continue;
    delete store.plain[key];
    store.secrets.delete(key);
    if (value === null) continue;
    if (isSecretSettingKey(key)) store.secrets.set(key, store.revision);
    else store.plain[key] = value;
  }
  profile.engine_settings = engineSettingsAfterEdits(profile.engine_settings, body.entries);
  return send(res, 200, { revision: store.revision });
}

function apply(res, profile, deploy) {
  if (BUSY_STATUSES.includes(profile.status)) {
    return send(res, 409, { error: 'profile_busy', name: profile.name, status: profile.status });
  }
  const { drift, running, engineSettingsProblem } = catalogOf(profile);
  if (!running) {
    return send(res, 409, {
      error: 'profile_stopped',
      name: profile.name,
      message: 'This deployment is stopped, so there is nothing to apply the settings to. Start deploys it with them.',
    });
  }
  if (drift.keys.length === 0) return send(res, 200, { recreated: [] });
  if (engineSettingsProblem) {
    return send(res, 400, { error: 'validation_error', errors: [engineSettingsProblem], name: profile.name });
  }
  deploy(profile);
  return send(res, 202, { recreated: drift.fullRedeploy ? 'all' : drift.services });
}

async function newDeploymentList(req, res, id) {
  const version = state.versions.find((candidate) => candidate.id === id);
  if (!version) return send(res, 404, { error: 'stack_version_not_found', id });
  if (!version.buildId) return send(res, 409, notReadyAnswer(version));
  let shape;
  try {
    const query = Object.fromEntries(new URL(req.url, 'http://mock').searchParams);
    shape = await newDeploymentShapeQuerySchema.validate(query, { abortEarly: false, stripUnknown: true });
  } catch (error) {
    return send(res, 400, { error: 'validation_error', errors: error.errors ?? ['The query does not describe a deployment.'] });
  }
  const components = servicesOfList(shape.components);
  const catalog = newDeploymentCatalogOf(version, {
    kind: shape.kind,
    components: components.length > 0 ? components : null,
    host: shape.host ?? null,
  });
  return send(res, 200, catalog, { 'cache-control': 'no-store' });
}

/**
 * @param deps.readBody    reads a JSON request body
 * @param deps.withProfile wraps a handler so the 404 is written once
 * @param deps.deploy      the mock's own DEPLOYING then RUNNING transition
 */
export function deploymentSettingsRoutes({ readBody, withProfile, deploy }) {
  const withVersionBuilt = (handler) =>
    withProfile((req, res, profile) => (versionOf(profile)?.buildId ? handler(req, res, profile) : notReady(res, profile)));
  const saveRoute = withBody(saveDeploymentSettingsSchema, save);
  const applyRoute = withBody(applyDeploymentSettingsSchema, (res, profile) => apply(res, profile, deploy));
  return [
    ['GET', /^\/versions\/(\d+)\/settings-catalog$/, (req, res, [id]) => newDeploymentList(req, res, Number(id))],
    [
      'GET',
      /^\/profiles\/([^/]+)\/settings$/,
      withVersionBuilt((_req, res, profile) => send(res, 200, catalogOf(profile), { 'cache-control': 'no-store' })),
    ],
    ['PUT', /^\/profiles\/([^/]+)\/settings$/, withVersionBuilt((req, res, profile) => saveRoute(req, res, profile, readBody))],
    ['POST', /^\/profiles\/([^/]+)\/settings\/apply$/, withVersionBuilt((req, res, profile) => applyRoute(req, res, profile, readBody))],
    [
      'POST',
      /^\/profiles\/([^/]+)\/settings\/admin-link\/test$/,
      withVersionBuilt((_req, res, profile) => send(res, 200, { outcome: deploymentTestOutcome(profile) }, { 'cache-control': 'no-store' })),
    ],
  ];
}

/**
 * What Test connection answers for what the deployment's next deploy would
 * give its uploader: the address it stores or its version sets, whether a
 * token is stored or generated, and its stream address, as the manager reads
 * them. The outcome itself is the mock's, off the address.
 */
function deploymentTestOutcome(profile) {
  const store = storeOf(profile);
  const url = nextValuesOf(profile, store)[ADMIN_API_URL_KEY] ?? '';
  const hasToken = store.secrets.has(ADMIN_API_TOKEN_KEY) || isGenerated(ADMIN_API_TOKEN_KEY, profile);
  return mockTestOutcome({ url, hasToken, feedOwner: profile.public_key ?? null });
}
