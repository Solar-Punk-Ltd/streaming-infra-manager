import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import {
  DeploymentOrchestrator,
  UploaderGate,
} from '../../src/domain/DeploymentOrchestrator.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { Profile } from '../../src/types/index.js';

import { FakeScriptRunner } from './FakeScriptRunner.js';
import { FakeContainers, InMemoryProfiles } from './profileFixtures.js';

export interface OrchestratorHarness {
  orchestrator: DeploymentOrchestrator;
  profiles: InMemoryProfiles;
  runner: FakeScriptRunner;
  events: EventBus;
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
): OrchestratorHarness {
  const profiles = new InMemoryProfiles(stored);
  const runner = new FakeScriptRunner();
  const events = new EventBus();

  const orchestrator = new DeploymentOrchestrator(
    profiles.asRepository(),
    new FakeContainers().asRepository(),
    runner,
    events,
    {} as DeploymentGroupRepository,
    uploaderGate,
  );

  return { orchestrator, profiles, runner, events };
}
