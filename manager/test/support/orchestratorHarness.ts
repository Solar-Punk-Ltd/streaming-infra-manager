import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import {
  DeploymentOrchestrator,
  UploaderGate,
} from '../../src/domain/DeploymentOrchestrator.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { Profile } from '../../src/types/index.js';

import { FakeScriptRunner } from './FakeScriptRunner.js';
import { InMemoryBuildLedger } from './InMemoryBuildLedger.js';
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
): OrchestratorHarness {
  const profiles = new InMemoryProfiles(stored);
  const runner = new FakeScriptRunner();
  const events = new EventBus();
  // Every row names the bundled version, the one the seed inserts as id 1.
  const versions = new InMemoryStackVersionRepository();
  versions.seedBundled();
  const containers = new FakeContainers();
  const ledger = new InMemoryBuildLedger(profiles, versionsRoot);

  const orchestrator = new DeploymentOrchestrator(
    profiles.asRepository(),
    containers.asRepository(),
    runner,
    events,
    {} as DeploymentGroupRepository,
    versions,
    ledger,
    uploaderGate,
  );

  return { orchestrator, profiles, runner, events, versions, containers, ledger };
}
