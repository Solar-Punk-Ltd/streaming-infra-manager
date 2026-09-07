/**
 * Stack versions, for the mock manager.
 *
 * Two are seeded, `bundled` and `main-v3`, with the contracts the real reader
 * pulls out of those two branches. Adding or updating one plays a build: a
 * dozen lines over a few seconds, streamed as Server-Sent Events exactly as the
 * manager streams them, then the row lands ready. Removing is refused for a
 * version any deployment runs, so that refusal can be seen without a database.
 */
import {
  stackRefProblem,
  stackVersionNameProblem,
} from '@streaming-infra-manager/common';

import { send, sendEmpty } from './mock-http.mjs';
import { containersFor, state } from './mock-seed.mjs';

const BUILD_STEP_MS = 400;

/**
 * The two port tables, kept the same as the fixtures the contract reader is
 * tested against in `manager/test/fixtures/stack/v2` and `.../v3`. Change one
 * and change the other, or the offline page shows a contract no branch has.
 */
const V2_PORTS = [
  'API_PORT:10000',
  'SRS_SRT_PORT:10001',
  'SRS_RTMP_PORT:10002',
  'SRS_HTTP_PORT:10003',
  'CLIENT_PORT:10004',
  'BEE_UPLOADER_API_PORT:10005',
  'BEE_UPLOADER_P2P_PORT:10006',
  'BEE_GATEWAY_API_PORT:10007',
  'BEE_GATEWAY_P2P_PORT:10008',
];

/** See the note on V2_PORTS: `manager/test/fixtures/stack/v3`. */
const V3_PORTS = [
  'API_PORT:3000:10000',
  'SRS_SRT_PORT:10080:10001',
  'SRS_RTMP_PORT:1935:10002',
  'SRS_HTTP_PORT:8080:10003',
  'CLIENT_PORT:5173:10004',
  'BEE_UPLOADER_API_PORT:1633:10005',
  'BEE_UPLOADER_P2P_PORT:1634:10006',
  'BEE_GATEWAY_API_PORT:1733:10007',
  'BEE_GATEWAY_P2P_PORT:1734:10008',
  'SRS_HTTP_API_PORT:1985:10009',
  'BEE_RUNG_480P_API_PORT:11001:11001',
  'BEE_RUNG_480P_P2P_PORT:11002:11002',
  'BEE_RUNG_720P_API_PORT:11003:11003',
  'BEE_RUNG_720P_P2P_PORT:11004:11004',
  'BEE_RUNG_1080P_API_PORT:11005:11005',
  'BEE_RUNG_1080P_P2P_PORT:11006:11006',
];

/** `NAME:default` or `NAME:default:slotbase`, the slot base being the last. */
function portsFrom(entries) {
  return entries.map((entry) => {
    const fields = entry.split(':');
    return {
      name: fields[0],
      defaultPort: Number(fields[1]),
      slotBase: Number(fields[fields.length - 1]),
    };
  });
}

const BUNDLED_CONTRACT = {
  ports: portsFrom(V2_PORTS),
  maxSlot: 999,
  requiredSecrets: [],
  engineDefaults: {
    HLS_FRAGMENT: '1.5',
    HLS_WINDOW: '22.5',
    HLS_SEGMENT_DURATION: '2',
    HLS_SEGMENT_COUNT: '5',
  },
  features: { srsApiPort: false, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: 'airensoft/ovenmediaengine:latest' },
  warnings: [],
};

const V3_CONTRACT = {
  ports: portsFrom(V3_PORTS),
  maxSlot: 99,
  requiredSecrets: ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'],
  engineDefaults: {
    HLS_FRAGMENT: '0.5',
    HLS_WINDOW: '15',
    SRT_LATENCY: '200',
    HLS_SEGMENT_DURATION: '2',
    HLS_SEGMENT_COUNT: '5',
  },
  features: { srsApiPort: true, chequebookGate: true, sharedImageTags: true },
  chequebookMinBzz: '0.5',
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: 'airensoft/ovenmediaengine:latest' },
  warnings: [],
};

const BUILD_LOG = [
  'Cloning into the versions root',
  'remote: Enumerating objects: 41822, done.',
  'remote: Counting objects: 100% (1204/1204), done.',
  'Resolving deltas: 100% (28911/28911), done.',
  'Installing and building the packages in node:22-alpine',
  'Lockfile is up to date, resolution step is skipped',
  'Packages: +612',
  'packages/stream-uploader build: tsc -p tsconfig.build.json',
  'packages/client build: vite build',
  'packages/cli build: tsc',
  'Created .env from .env.sample',
  'Created deploy/config.json from deploy/config.sample.json',
];

let nextId = 1;

function makeVersion(input) {
  return {
    id: nextId++,
    name: input.name,
    gitRef: input.gitRef,
    commitSha: input.commitSha ?? null,
    status: input.status ?? 'ready',
    isDefault: input.isDefault ?? false,
    tested: input.tested ?? false,
    builtAt: input.builtAt ?? null,
    lastError: null,
    contract: input.contract ?? null,
    deployments: 0,
    // Every row that existed before builds deploys from its flat root. An
    // added version deploys from one immutable build per commit.
    layout: input.layout ?? 'builds',
    buildId: input.buildId ?? null,
    previousBuildId: null,
  };
}

/** The commit of the version a deployment runs, which its containers are seen to run in this mock. */
export function commitOfVersion(id) {
  return findVersion(id)?.commitSha ?? null;
}

/** The deploy contract of the version a deployment runs, or null. */
export function contractOfVersion(id) {
  return findVersion(id)?.contract ?? null;
}

/** The version a new deployment gets, as the manager reads it at insert time. */
export function defaultVersionId() {
  return state.versions.find((version) => version.isDefault)?.id ?? null;
}

/**
 * Why a new deployment cannot run the version the body names, in the
 * manager's words, or null. Null for an absent id, which means the default.
 */
export function newDeploymentVersionProblem(id) {
  if (id == null) return null;
  const version = findVersion(id);
  if (!version) {
    return `Stack version ${id} does not exist. Pick one from the Versions page.`;
  }
  if (version.status !== 'ready') {
    return `${version.name} is ${version.status}. Only a version that finished building can run a deployment.`;
  }
  return null;
}

export function seedVersions() {
  nextId = 1;
  state.versions = [
    makeVersion({
      name: 'bundled',
      gitRef: 'main-v2',
      commitSha: 'ee99c368bd45c12defcb10ca726f0db0777defb0',
      isDefault: true,
      tested: true,
      builtAt: '2026-08-04T11:20:00Z',
      contract: BUNDLED_CONTRACT,
      layout: 'legacy',
    }),
    makeVersion({
      name: 'main-v3',
      gitRef: 'main-v3',
      commitSha: 'be440d65e0e82bcf9000a8a0dde905dc215255d6',
      builtAt: '2026-09-05T21:05:00Z',
      contract: V3_CONTRACT,
      buildId: 'be440d65e0e82bcf9000a8a0dde905dc215255d6',
    }),
  ];

  // Every seeded deployment runs the bundled version, which is what the
  // migration does to the rows that existed before the table did. One stream
  // is put on main-v3 so what only that version offers, the published SRS API
  // port and a config file of the deployment's own, can be seen offline.
  const v3 = state.versions.find((version) => version.name === 'main-v3');
  for (const profile of state.profiles) {
    profile.stack_version_id =
      profile.name === 'backup-stage' && v3 ? v3.id : defaultVersionId();
    // The containers were built before the version was known: what they
    // are seen to run is the version's commit, as this mock's deploys land.
    if (profile.containers.length > 0) {
      profile.containers = containersFor(profile, {
        withUploader: profile.containers.some((container) => container.service === 'stream-uploader'),
      });
    }
  }
}

function findVersion(id) {
  return state.versions.find((version) => version.id === Number(id)) ?? null;
}

/** Which deployments run a version, by name, the way the manager counts them. */
function deploymentsOn(versionId) {
  return state.profiles
    .filter((profile) => profile.stack_version_id === versionId)
    .map((profile) => profile.name);
}

function withCounts() {
  return state.versions.map((version) => ({
    ...version,
    deployments: deploymentsOn(version.id).length,
  }));
}

/**
 * The build stream, and what happens when the reader goes away.
 *
 * A frame written after the browser closed the response is dropped and the
 * build carries on, which is what the manager does: the script runs in the
 * manager process, not in the request, so leaving the page mid-build still
 * lands the row ready or failed.
 */
function openBuildStream(res, script, args) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  let open = true;
  res.on('close', () => {
    open = false;
  });

  return {
    frame: (event, data) => {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end: () => {
      if (open) res.end();
    },
  };
}

/**
 * Plays a build: the log a line at a time, then the row lands ready with a
 * fresh commit. A ref containing "fail" builds and then fails, so the failed
 * state and its message can be seen without breaking anything.
 */
function playBuild(res, version, publish) {
  const { frame, end } = openBuildStream(res, 'stack-version-build.sh', [
    version.name,
    version.gitRef,
  ]);
  const willFail = version.gitRef.includes('fail');
  // A ref that says `same` lands on the commit the version already has, so
  // the rebuild gets a distinct identity beside it, as the manager gives a
  // commit published again with other inputs.
  const sameCommit = version.gitRef.includes('same') && version.commitSha;
  const commit = sameCommit ? version.commitSha : randomCommit();

  version.status = 'building';
  version.lastError = null;
  publish({ type: 'version.changed' });

  let step = 0;
  const timer = setInterval(() => {
    if (step < BUILD_LOG.length) {
      frame('stdout', { chunk: `${BUILD_LOG[step]}\n` });
      if (step === 3) frame('stdout', { chunk: `STACK_COMMIT=${commit}\n` });
      step += 1;
      return;
    }

    clearInterval(timer);
    if (willFail) {
      frame('stderr', {
        chunk: `fatal: couldn't find remote ref ${version.gitRef}\n`,
      });
      const reason = `fatal: couldn't find remote ref ${version.gitRef}`;
      // A version with a usable build keeps it, ready, with the reason. Only
      // one with nothing to deploy from is failed, as the manager does.
      version.status = version.buildId ? 'ready' : 'failed';
      version.lastError = version.buildId ? `${reason}. Still on build ${version.buildId}.` : reason;
    } else {
      // The approval belongs to the build that was tested, as in the manager,
      // and the build the new one replaces is kept as the previous one. The
      // same commit published again gets <commit>-r<n>.
      const rebuilds = (version.buildId ?? '').startsWith(commit) ? (Number(/-r(\d+)$/.exec(version.buildId)?.[1] ?? 0) + 1) : 0;
      const buildId = rebuilds > 0 ? `${commit}-r${rebuilds}` : commit;
      version.tested = version.tested && version.buildId === buildId;
      if (version.buildId && version.buildId !== buildId) version.previousBuildId = version.buildId;
      version.layout = 'builds';
      version.buildId = buildId;
      version.status = 'ready';
      version.commitSha = commit;
      version.builtAt = new Date().toISOString();
      version.contract = version.contract ?? V3_CONTRACT;
    }
    frame('done', { code: willFail ? 1 : 0 });
    end();
    publish({ type: 'version.changed' });
  }, BUILD_STEP_MS);
}

function randomCommit() {
  const digits = '0123456789abcdef';
  let sha = '';
  for (let index = 0; index < 40; index += 1) {
    sha += digits[Math.floor(Math.random() * digits.length)];
  }
  return sha;
}

export function versionRoutes(readBody, publish) {
  return [
    ['GET', /^\/versions$/, (_req, res) => send(res, 200, withCounts())],
    [
      'POST',
      /^\/versions$/,
      async (req, res) => {
        const body = await readBody(req);
        const name = String(body.name ?? '');
        const ref = String(body.ref ?? '');

        // The same two rules the manager applies, from the same module, so a
        // refusal seen offline is the refusal the host gives.
        const problem = stackVersionNameProblem(name) ?? stackRefProblem(ref);
        if (problem) {
          return send(res, 400, {
            error: 'validation_error',
            errors: [problem],
          });
        }
        if (state.versions.some((version) => version.name === name)) {
          return send(res, 409, { error: 'stack_version_exists', name });
        }
        if (state.versions.some((version) => version.status === 'building')) {
          return send(res, 409, {
            error: 'stack_build_busy',
            message: 'Another version is building. Wait for it to finish, then try again.',
          });
        }

        const version = makeVersion({ name, gitRef: ref, status: 'building' });
        state.versions.push(version);
        playBuild(res, version, publish);
      },
    ],
    [
      'POST',
      /^\/versions\/(\d+)\/update$/,
      (_req, res, [id]) => {
        const version = findVersion(id);
        if (!version) {
          return send(res, 404, { error: 'stack_version_not_found', id });
        }
        if (version.name === 'bundled') {
          return send(res, 409, {
            error: 'bundled_version',
            message:
              'The bundled version comes with the manager. Deploy the manager to move it, or add another version to follow a branch.',
          });
        }
        playBuild(res, version, publish);
      },
    ],
    [
      'POST',
      /^\/versions\/(\d+)\/default$/,
      (_req, res, [id]) => {
        const version = findVersion(id);
        if (!version) {
          return send(res, 404, { error: 'stack_version_not_found', id });
        }
        if (version.status !== 'ready') {
          return send(res, 400, {
            error: 'validation_error',
            errors: [
              `${version.name} is ${version.status}. Only a version that finished building can be the default.`,
            ],
          });
        }

        for (const entry of state.versions) {
          entry.isDefault = entry.id === version.id;
        }
        publish({ type: 'version.changed' });
        sendEmpty(res, 204);
      },
    ],
    [
      'PATCH',
      /^\/versions\/(\d+)$/,
      async (req, res, [id]) => {
        const version = findVersion(id);
        if (!version) {
          return send(res, 404, { error: 'stack_version_not_found', id });
        }
        const body = await readBody(req);
        if (body.tested && version.status !== 'ready') {
          return send(res, 400, {
            error: 'validation_error',
            message: `${version.name} is ${version.status}. Only a version that finished building can be marked as tested.`,
          });
        }
        version.tested = Boolean(body.tested);
        publish({ type: 'version.changed' });
        send(res, 200, {
          ...version,
          deployments: deploymentsOn(version.id).length,
        });
      },
    ],
    [
      'DELETE',
      /^\/versions\/(\d+)$/,
      (_req, res, [id]) => {
        const version = findVersion(id);
        if (!version) {
          return send(res, 404, { error: 'stack_version_not_found', id });
        }
        if (version.name === 'bundled') {
          return send(res, 409, {
            error: 'bundled_version',
            message:
              'The bundled version comes with the manager and cannot be removed. Set another version as the default instead.',
          });
        }

        const deployments = deploymentsOn(version.id);
        if (deployments.length > 0) {
          return send(res, 409, {
            error: 'stack_version_in_use',
            name: version.name,
            deployments,
            message: `${version.name} still runs ${deployments.length} deployment${deployments.length === 1 ? '' : 's'}: ${deployments.join(', ')}. Move or remove them first.`,
          });
        }

        state.versions = state.versions.filter(
          (entry) => entry.id !== version.id,
        );
        publish({ type: 'version.changed' });
        sendEmpty(res, 204);
      },
    ],
  ];
}
