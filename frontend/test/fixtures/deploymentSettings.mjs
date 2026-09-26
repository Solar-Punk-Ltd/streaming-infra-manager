/**
 * A deployment's own settings as the manager answers them, for the offline
 * page, and the few rules of the manager's save and Apply the page leans on.
 *
 * The values are obviously fake on sight. Nothing here is a credential, and
 * nothing here came off a host. The descriptions are shortened from the
 * stack's own `.env.sample`, one of them kept long on purpose so the page
 * has one to fold.
 */

const ADMIN_URL_DESCRIPTION = [
  'Where the admin service lives. Setting ADMIN_API_URL by itself turns admin mode ON. Leaving it empty keeps this',
  'deployment exactly as it has always been. The uploader mints each stream\'s feed topic and the stream catalog on',
  'Swarm is its own to write. With it set, a stream has to be DECLARED in the admin before anything may publish to',
  'it, and the admin mints the feed topic and the publish key.',
].join(' ');

function entry(overrides) {
  return {
    section: 'Stream Uploader',
    description: '',
    declared: true,
    secret: false,
    sampleValue: null,
    versionSet: true,
    versionValue: null,
    stored: false,
    storedValue: null,
    value: null,
    source: 'version',
    owner: null,
    field: null,
    services: ['stream-uploader'],
    running: 'same',
    ...overrides,
  };
}

/** The keys of one deployment on a version with an SRS engine, in the sample's order. */
function entries() {
  return [
    entry({
      key: 'API_AUTH_TOKEN',
      section: 'Required, and the stamp purchase defaults',
      description: 'Bearer token for every gated route of the uploader.',
      secret: true,
      versionSet: false,
      source: 'generated',
    }),
    entry({
      key: 'ADMIN_API_URL',
      section: 'Admin mode',
      description: ADMIN_URL_DESCRIPTION,
      versionValue: '',
      value: '',
      services: ['srs', 'stream-uploader'],
    }),
    entry({
      key: 'ADMIN_API_TOKEN',
      section: 'Admin mode',
      description: "Bearer token for the admin's internal routes, required whenever ADMIN_API_URL is set.",
      secret: true,
      stored: true,
      source: 'deployment',
    }),
    entry({
      key: 'BEE_URL',
      description: 'Where the uploader reaches its Bee node.',
      owner: 'bee-url',
      source: 'manager',
      value: 'http://bee-uploader:1633',
    }),
    entry({
      key: 'MAX_QUEUE_SIZE',
      description: 'How many segments may wait for an upload.',
      field: { kind: 'integer', min: 1 },
      versionValue: '100',
      stored: true,
      storedValue: '250',
      value: '250',
      source: 'deployment',
    }),
    entry({
      key: 'UPLOADER_START_GATES',
      description: 'What the two startup checks do about a node they cannot clear.',
      field: { kind: 'choice', choices: ['chequebook-warn', 'warn', 'refuse'] },
      versionValue: 'chequebook-warn',
      value: 'chequebook-warn',
    }),
    entry({
      key: 'CHEQUEBOOK_MIN_BZZ',
      description: 'The chequebook floor, in BZZ, that every Bee node must hold available.',
      field: { kind: 'number', min: 0, max: 1000 },
      versionValue: '0.5',
      value: '0.5',
    }),
    entry({
      key: 'BEE_UPLOADER_FULL_NODE',
      section: 'Bee Nodes (Docker deployment)',
      description: 'Whether the uploader node runs as a full node.',
      field: { kind: 'boolean' },
      versionValue: 'false',
      value: 'false',
      services: null,
    }),
    entry({
      key: 'LOG_LEVEL',
      section: 'Logging',
      description: 'How much the uploader logs.',
      field: { kind: 'choice', choices: ['debug', 'log', 'info', 'warn', 'error', 'silent'] },
      versionValue: 'info',
      stored: true,
      storedValue: 'debug',
      value: 'debug',
      source: 'deployment',
      running: 'differs',
    }),
    entry({
      key: 'HLS_FRAGMENT',
      section: 'SRS Media Server',
      description: 'Segment length in seconds.',
      owner: 'engine-settings',
      source: 'manager',
      value: '0.5',
      services: ['srs'],
    }),
    entry({
      key: 'OLD_UPLOAD_RETRIES',
      section: '',
      declared: false,
      versionSet: false,
      stored: true,
      storedValue: '5',
      value: '5',
      source: 'deployment',
      services: null,
      running: 'unknown',
    }),
  ];
}

export const RUNNING_INSTANCE = '44444444-4444-4444-8444-444444444444';
export const STOPPED_INSTANCE = '55555555-5555-4555-8555-555555555555';

/** A running deployment whose uploader is behind on the log level saved for it. */
export function runningCatalog() {
  return {
    instanceId: RUNNING_INSTANCE,
    revision: 7,
    buildId: 'be440d65e0e82bcf9000a8a0dde905dc215255d6',
    entries: entries(),
    drift: { keys: ['LOG_LEVEL'], services: ['stream-uploader'], fullRedeploy: false },
    running: true,
  };
}

/** A stopped deployment, whose Start will use the log level saved for it. */
export function stoppedCatalog() {
  const stopped = entries().map((row) => ({ ...row, running: 'not-running' }));
  return {
    ...runningCatalog(),
    instanceId: STOPPED_INSTANCE,
    entries: stopped,
    running: false,
  };
}

function afterEdit(row, value) {
  if (value !== null) {
    return {
      ...row,
      stored: true,
      storedValue: row.secret ? null : value,
      value: row.secret ? null : value,
      source: 'deployment',
    };
  }
  return {
    ...row,
    stored: false,
    storedValue: null,
    value: row.secret ? null : row.versionValue,
    source: row.versionSet ? 'version' : 'unset',
  };
}

/**
 * The list after a save the manager took: the values stored or reset, the
 * revision moved, and, on a running deployment, the changed keys behind the
 * containers until an Apply.
 */
export function afterSave(catalog, edits) {
  const byKey = new Map(edits.map(({ key, value }) => [key, value]));
  const rows = catalog.entries.map((row) => (byKey.has(row.key) ? afterEdit(row, byKey.get(row.key)) : row));
  const changed = rows.filter((row) => byKey.has(row.key) && row.owner === null && row.declared);
  const keys = [...new Set([...catalog.drift.keys, ...changed.map((row) => row.key)])];
  const behind = rows.filter((row) => keys.includes(row.key));
  return {
    ...catalog,
    revision: catalog.revision + 1,
    entries: rows,
    drift: catalog.running
      ? {
          keys,
          services: [...new Set(behind.flatMap((row) => row.services ?? []))].sort(),
          fullRedeploy: behind.some((row) => row.services === null),
        }
      : catalog.drift,
  };
}

/** What Apply answers, and the list once the containers have every saved setting. */
export function afterApply(catalog) {
  const recreated = catalog.drift.fullRedeploy ? 'all' : catalog.drift.services;
  const rows = catalog.entries.map((row) => (row.running === 'differs' ? { ...row, running: 'same' } : row));
  return {
    recreated,
    catalog: { ...catalog, entries: rows, drift: { keys: [], services: [], fullRedeploy: false } },
  };
}
