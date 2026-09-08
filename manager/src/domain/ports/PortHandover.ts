import type { Profile } from '../../types/index.js';
import type { DaemonObserver } from '../DeployAttemptRepository.js';
import type { DeployAttempt } from '../deployAttempts.js';
import { TargetNotVerifiedError } from '../errors/index.js';
import type { BuildDescriptor } from '../versions/buildLedger.js';
import { targetAlias } from './DeployTargets.js';
import type { PortReservationRepository } from './PortReservationRepository.js';
import type { PublishedPortsProbe } from './PublishedPortsProbe.js';
import { portKeyOf, portPlanFor } from './portReservations.js';

/** Only replacement evidence can retire an old service's port plan. A script's exit code cannot. */
export class PortHandover {
  constructor(
    private readonly ports: PortReservationRepository,
    private readonly observer: PublishedPortsProbe,
    private readonly daemon: DaemonObserver,
  ) {}

  async reconcile(profile: Profile, build: BuildDescriptor, attempt: DeployAttempt): Promise<void> {
    if (profile.status !== 'DEPLOYING') return;
    const contract = build.version?.contract;
    if (!contract?.ports.length || contract.allocationProblem) return;
    const target = targetAlias(attempt.target ?? profile.host);
    const containers = await this.daemon.snapshot(profile.name, target);
    const published = await this.observer.publishedPorts(target);
    if (containers.daemonId !== attempt.daemonId || published.daemonId !== attempt.daemonId) {
      throw new TargetNotVerifiedError(target, 'Port handover observations came from a different Docker daemon. Reservations were retained.');
    }
    if (published.unverifiedProjects?.length) return;
    const planned = portPlanFor(contract.ports, profile.port_slot);
    const before = new Set(attempt.preJobContainerIds);
    const services = attempt.services.filter(service => {
      const ids = containers.containers.get(service) ?? [];
      if (!ids.length || ids.some(id => before.has(id))) return false;
      return planned.filter(port => port.service === service).every(port => published.bindings.some(binding =>
        binding.project === profile.name && binding.service === service && portKeyOf(binding) === portKeyOf(port),
      ));
    });
    await this.ports.reconcile({
      profileName: profile.name, daemonId: attempt.daemonId, services, planned, bound: published.bindings,
    });
  }
}
