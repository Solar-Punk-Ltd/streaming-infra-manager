import { defaultServicesFor } from '@streaming-infra-manager/common';

import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import {
  DeploymentOrchestrator,
  UploaderGate,
} from '../../src/domain/DeploymentOrchestrator.js';
import { EventBus } from '../../src/domain/EventBus.js';
import type { DeployTargets } from '../../src/domain/ports/DeployTargets.js';
import { Profile } from '../../src/types/index.js';

import { FakeScriptRunner } from './FakeScriptRunner.js';
import { ALLOCATION_CONTRACT } from './allocationContract.js';
import { InMemoryBuildLedger } from './InMemoryBuildLedger.js';
import { FakeDaemon, InMemoryDeployAttempts } from './InMemoryDeployAttempts.js';
import { InMemoryStackVersionRepository } from './InMemoryStackVersionRepository.js';
import { FakeContainers, InMemoryProfiles } from './profileFixtures.js';

/**
 * Waits for a job's success hook to have run, which is what marks the row
 * RUNNING again. A fixed pause was long enough on an idle laptop and not on
 * one running the whole suite.
 */
export async function untilRunning(
  profiles: InMemoryProfiles,
  name: string,
): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (profiles.statusOf(name) === 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name} never came back to RUNNING`);
}

export interface OrchestratorHarness {
  orchestrator: DeploymentOrchestrator;
  profiles: InMemoryProfiles;
  runner: FakeScriptRunner;
  events: EventBus;
  /** Seeded with the bundled version as id 1. A test adds what else it needs. */
  versions: InMemoryStackVersionRepository;
  containers: FakeContainers;
  /** Which build each deployment runs on, and what its containers were seen to mount. */
  ledger: InMemoryBuildLedger;
  /** The project guard and the daemon lock, and what Docker says about the projects. */
  attempts: InMemoryDeployAttempts;
  daemon: FakeDaemon;
}

/**
 * An orchestrator over in-memory rows and a runner that spawns nothing.
 *
 * Import this module dynamically, after setting SHLS_ROOT: it reaches the
 * orchestrator, which reaches envUtils, which resolves the submodule path once
 * when it loads.
 */
export function orchestratorHarness(
  stored: readonly Profile[],
  uploaderGate?: UploaderGate,
  versionsRoot = '/srv/stack-versions',
  targets?: DeployTargets,
): OrchestratorHarness {
  const profiles = new InMemoryProfiles(stored);
  const runner = new FakeScriptRunner();
  const events = new EventBus();
  // Every row names the bundled version, the one the seed inserts as id 1.
  const versions = new InMemoryStackVersionRepository();
  versions.seedBundled().contract = structuredClone(ALLOCATION_CONTRACT);
  profiles.reservations.seededAt = new Date(0);
  const containers = new FakeContainers();
  const ledger = new InMemoryBuildLedger(profiles, versions, versionsRoot);
  const attempts = new InMemoryDeployAttempts();
  const daemon = new FakeDaemon();
  // Every stored deployment starts with a container per service, and a
  // finished deploy script leaves new ones, the way compose does.
  for (const profile of stored) {
    for (const service of defaultServicesFor(profile)) {
      daemon.set(profile.name, service, [`${profile.name}-${service}-0`]);
    }
  }
  runner.onFinish = (run) => {
    const project = run.args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length);
    if (!project || !daemon.autoRecreate) return;
    // Compose gives every service the attempt touched a new container, so
    // the attempt that opened for this run resolves as a real one would.
    const attempt = attempts.rows.find((row) => row.project === project && row.state === 'open');
    for (const service of attempt?.services ?? []) {
      daemon.set(project, service, [`${project}-${service}-${run.args.length}-${Date.now()}`]);
    }
  };

  const orchestrator = new DeploymentOrchestrator(
    profiles.asRepository(),
    containers.asRepository(),
    runner,
    events,
    {} as DeploymentGroupRepository,
    versions,
    ledger,
    attempts,
    daemon,
    uploaderGate,
    targets,
    profiles.reservations,
  );

  return { orchestrator, profiles, runner, events, versions, containers, ledger, attempts, daemon };
}
