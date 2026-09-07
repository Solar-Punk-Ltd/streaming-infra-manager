/**
 * Applying a config file of the deployment's own, and taking it back.
 *
 * Unit test, no database, no Docker and no deploy script. `pnpm test` in
 * manager/.
 *
 * The order is the point: nothing is stored until the engine's own parser has
 * accepted the file and the deployment has been claimed, the engine is
 * recreated on the file, and an engine that then will not stay up gets the
 * previous file back with the reason on the row. A stream deployment left
 * down over a typo would be the worst thing this feature could do.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import type { ContainerState } from '../../src/domain/ContainerControl.js';
import type { CommandResult } from '../../src/domain/engineConfig/engineConfigCheck.js';
import type { EngineWatcher } from '../../src/domain/engineConfig/EngineConfigService.js';
import type { ProfileServiceHarness } from '../support/profileServiceHarness.js';
import { fakeDocker, frame, RUNNING_AFTER_TWO_RESTARTS } from '../support/fakeDocker.js';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
} from '../../src/domain/composeLabels.js';

// The scratch checkout stands in for both the bundled root and the main-v3
// root: what differs between the two here is the contract, not the files.
// Both roots are read when their modules load, so they are set before the
// dynamic imports below and nothing above imports them statically.
const root = mkdtempSync(join(tmpdir(), 'engine-config-service-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(
  join(root, 'engines', 'srs', 'srs.conf.template'),
  'listen 1935;\nhls_fragment HLS_FRAGMENT_PLACEHOLDER;\nTRANSCODE_PLACEHOLDER\n',
);
writeFileSync(
  join(root, 'engines', 'srs', 'entrypoint.sh'),
  'sed -i "s/HLS_FRAGMENT_PLACEHOLDER/1/" $CONF\nsed -i "/TRANSCODE_PLACEHOLDER/d" $CONF\n',
);

const { EngineConfigChecker } = await import(
  '../../src/domain/engineConfig/engineConfigCheck.js'
);
const { EngineConfigService } = await import(
  '../../src/domain/engineConfig/EngineConfigService.js'
);
const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { EventBus } = await import('../../src/domain/EventBus.js');
const { ProfileBusyError, ProfileConfigError } = await import(
  '../../src/domain/errors/index.js'
);
const { profileRow, profileServiceHarness } = await import(
  '../support/profileServiceHarness.js'
);

const V3_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
};

const OK: CommandResult = { code: 0, stdout: 'test is successful', stderr: '' };
const REFUSED: CommandResult = {
  code: 255,
  stdout: 'invalid config : illegal vhost.hls.hls_fragmnt in /check/srs.conf',
  stderr: '',
};

const RUNNING: ContainerState = {
  id: 'c1',
  status: 'running',
  restartCount: 0,
  startedAt: null,
};

/** The watcher answers a scripted sequence of states, the last one repeating. */
class ScriptedWatcher implements EngineWatcher {
  readonly inspected: string[] = [];
  constructor(private readonly states: (ContainerState | null)[]) {}

  async inspect(profile: string, service: string): Promise<ContainerState | null> {
    this.inspected.push(`${profile}/${service}`);
    return this.states.length > 1 ? this.states.shift()! : (this.states[0] ?? null);
  }

  async logs(): Promise<string> {
    return [
      'XCORE-SRS/6.0.184(Hang)',
      'Authors: Winlin, ZhaoWenjie and others',
      'srs.conf generated from the custom config file',
      'thread [1][x]: acquire_pid_file() [errno=2](No such file or directory)',
      'invalid config, exiting',
    ].join('\n');
  }
}

interface Setup<W extends EngineWatcher> {
  harness: ProfileServiceHarness;
  service: InstanceType<typeof EngineConfigService>;
  watcher: W;
  checkerCalls: number;
}

async function setup<W extends EngineWatcher = ScriptedWatcher>(options: {
  supported?: boolean;
  check?: CommandResult;
  states?: (ContainerState | null)[];
  /** In place of the scripted one: the real adapter over a fake daemon. */
  watcher?: W;
} = {}): Promise<Setup<W>> {
  const harness = profileServiceHarness([profileRow()]);
  if (options.supported ?? true) {
    await harness.versions.setContract(1, V3_CONTRACT);
  }
  // The fake orchestrator finishes a run without marking the row RUNNING,
  // which the real one does in the job's success hook. The revert takes a
  // fresh claim, and a claim on a row still DEPLOYING is refused, so the
  // fake is given that hook here.
  const orchestrator = harness.orchestrator;
  const runReserved = orchestrator.runReserved.bind(orchestrator);
  orchestrator.runReserved = async (reservation, profile) => {
    const handle = await runReserved(reservation, profile);
    handle.emitter.once('done', () => {
      void harness.profiles.markTerminal(profile.name, 'RUNNING');
    });
    return handle;
  };
  const watcher = (options.watcher ?? new ScriptedWatcher(options.states ?? [RUNNING])) as W;
  const state = { checkerCalls: 0 };
  const checker = new EngineConfigChecker(async () => {
    state.checkerCalls += 1;
    return options.check ?? OK;
  });
  const service = new EngineConfigService(
    harness.profiles.asRepository(),
    harness.containers.asRepository(),
    harness.orchestrator.asOrchestrator(),
    harness.versions,
    watcher,
    checker,
    harness.events,
    { intervalMs: 5, durationMs: 20 },
  );
  return {
    harness,
    service,
    watcher,
    get checkerCalls() {
      return state.checkerCalls;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('what the editor opens on', () => {
  it("answers the version's template, its placeholders, and that it is supported", async () => {
    const { service } = await setup();

    const view = await service.view('stream1');

    assert.equal(view.engine, 'srs');
    assert.equal(view.supported, true);
    assert.equal(view.unsupportedReason, null);
    assert.equal(view.config, null);
    assert.match(view.template, /^listen 1935;/);
    assert.deepEqual(view.placeholders, ['HLS_FRAGMENT_PLACEHOLDER', 'TRANSCODE_PLACEHOLDER']);
    assert.ok(view.references[0]?.url.includes('full.conf'));
  });

  it('says a version without the hook renders the template, and names where to go', async () => {
    const { service } = await setup({ supported: false });

    const view = await service.view('stream1');

    assert.equal(view.supported, false);
    assert.match(view.unsupportedReason ?? '', /bundled renders the SRS config from its template/);
    assert.match(view.unsupportedReason ?? '', /main-v3/);
  });
});

describe('applying a file', () => {
  it('refuses on a version without the hook, and stores nothing', async () => {
    const { service, harness } = await setup({ supported: false });

    await assert.rejects(
      service.apply('stream1', 'listen 1935;\n'),
      (err: unknown) => err instanceof ProfileConfigError && /main-v3/.test(err.message),
    );

    assert.equal(harness.profiles.engineConfigs.has('stream1'), false);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('refuses a file the engine refuses, with its words, and stores nothing', async () => {
    const { service, harness } = await setup({ check: REFUSED });

    await assert.rejects(
      service.apply('stream1', 'hls_fragmnt 1.5;\n'),
      (err: unknown) =>
        err instanceof ProfileConfigError && /illegal vhost\.hls\.hls_fragmnt/.test(err.message),
    );

    assert.equal(harness.profiles.engineConfigs.has('stream1'), false);
    assert.deepEqual(harness.orchestrator.reserved, []);
  });

  it('refuses a placeholder the version does not fill without asking the engine', async () => {
    const setupState = await setup();

    await assert.rejects(
      setupState.service.apply('stream1', 'x NOPE_PLACEHOLDER;\n'),
      ProfileConfigError,
    );

    assert.equal(setupState.checkerCalls, 0);
  });

  it('refuses while the deployment is deploying, before any check', async () => {
    const setupState = await setup();
    harnessRowOf(setupState.harness, 'stream1').status = 'DEPLOYING';

    await assert.rejects(setupState.service.apply('stream1', 'listen 1935;\n'), ProfileBusyError);
    assert.equal(setupState.checkerCalls, 0);
  });

  it('claims, stores, recreates the engine, and leaves the file in place when it stays up', async () => {
    const { service, harness, watcher } = await setup();

    const profile = await service.apply('stream1', 'listen 1935;\nhls_fragment HLS_FRAGMENT_PLACEHOLDER;\n');
    harness.orchestrator; // the fake finishes its runs on its own
    await settle();

    assert.equal(profile.has_engine_config, true);
    assert.equal(profile.engine_config_error, null);
    assert.deepEqual(harness.orchestrator.reserved, ['stream1']);
    assert.deepEqual(harness.orchestrator.deploys, [
      { profileName: 'stream1', services: ['srs'] },
    ]);
    assert.equal(
      harness.profiles.engineConfigs.get('stream1'),
      'listen 1935;\nhls_fragment HLS_FRAGMENT_PLACEHOLDER;\n',
    );
    assert.ok(watcher.inspected.length >= 3, `watched ${watcher.inspected.length} times`);
    assert.equal(harness.profiles.rows.get('stream1')?.engine_config_error, null);
  });
});

describe('an engine that will not stay up on the new file', () => {
  it('gets the previous file back, is recreated again, and the row says why', async () => {
    const { service, harness } = await setup({
      states: [RUNNING, { ...RUNNING, status: 'restarting', restartCount: 2 }],
    });
    harness.profiles.engineConfigs.set('stream1', 'listen 1935; # the old one\n');

    await service.apply('stream1', 'listen 1935;\nhls_window 5;\n');
    await settle();

    const row = harness.profiles.rows.get('stream1');
    assert.equal(harness.profiles.engineConfigs.get('stream1'), 'listen 1935; # the old one\n');
    assert.match(row?.engine_config_error ?? '', /^SRS keeps restarting on the new config file, so the previous one is back\./);
    assert.match(row?.engine_config_error ?? '', /invalid config, exiting/);
    assert.match(row?.engine_config_error ?? '', /acquire_pid_file/);
    assert.equal(/Authors/.test(row?.engine_config_error ?? ''), false, 'the banner is not a reason');
    assert.deepEqual(
      harness.orchestrator.deploys.map((d) => d.services),
      [['srs'], ['srs']],
    );
  });

  it('goes back to the template when there was no previous file', async () => {
    const { service, harness } = await setup({ states: [null] });

    await service.apply('stream1', 'listen 1935;\n');
    await settle();

    const row = harness.profiles.rows.get('stream1');
    assert.equal(harness.profiles.engineConfigs.has('stream1'), false);
    assert.equal(row?.has_engine_config, false);
    assert.match(row?.engine_config_error ?? '', /SRS is not running on the new config file/);
  });
});

describe('the watch over the real Docker adapter', () => {
  it('sees a container that restarted on the new file and puts the previous one back', async () => {
    // The scripted watcher hands the watch a count already read out of the
    // daemon's answer, so it cannot catch the adapter reading that count from
    // the wrong place. This one runs the real adapter over an answer shaped
    // the way Docker shapes it: running again, restarted twice, which is the
    // engine dying on the file and Docker bringing it back between two polls.
    const docker = fakeDocker([
      { id: 'other-srs', labels: composeLabels('stream2', 'srs') },
      {
        id: 'own-srs',
        labels: composeLabels('stream1', 'srs'),
        inspectAnswer: RUNNING_AFTER_TWO_RESTARTS,
        logBytes: frame('invalid config, exiting\n'),
      },
    ]);
    const { service, harness } = await setup({
      watcher: new ContainerControl(new EventBus(), docker),
    });
    harness.profiles.engineConfigs.set('stream1', 'listen 1935; # the old one\n');

    await service.apply('stream1', 'listen 1935;\nhls_window 5;\n');
    await settle();

    const row = harness.profiles.rows.get('stream1');
    assert.equal(harness.profiles.engineConfigs.get('stream1'), 'listen 1935; # the old one\n');
    assert.match(
      row?.engine_config_error ?? '',
      /^SRS restarted 2 times on the new config file, so the previous one is back\./,
    );
    assert.match(row?.engine_config_error ?? '', /invalid config, exiting/);
    assert.deepEqual(
      harness.orchestrator.deploys.map((d) => d.services),
      [['srs'], ['srs']],
    );
  });
});

describe('back to the template', () => {
  it('clears the file and the error and recreates the engine', async () => {
    const { service, harness } = await setup();
    await harness.profiles.setEngineConfig('stream1', 'listen 1935;\n', 'an old error');

    const profile = await service.reset('stream1');

    assert.equal(profile.has_engine_config, false);
    assert.equal(profile.engine_config_error, null);
    assert.deepEqual(harness.orchestrator.deploys, [
      { profileName: 'stream1', services: ['srs'] },
    ]);
  });

  it('does nothing when the template already runs', async () => {
    const { service, harness } = await setup();

    await service.reset('stream1');

    assert.deepEqual(harness.orchestrator.deploys, []);
  });
});

function harnessRowOf(harness: ProfileServiceHarness, name: string) {
  const row = harness.profiles.rows.get(name);
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

function composeLabels(project: string, service: string): Record<string, string> {
  return {
    [COMPOSE_PROJECT_LABEL]: project,
    [COMPOSE_SERVICE_LABEL]: service,
  };
}
