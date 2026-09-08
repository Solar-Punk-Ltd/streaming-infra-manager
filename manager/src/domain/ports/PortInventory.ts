import type { ProfileRepository } from '../ProfileRepository.js';
import { InvalidStackVersionError, TargetNotVerifiedError } from '../errors/index.js';
import type { StackVersionRepository } from '../versions/StackVersionRepository.js';
import { targetAlias, type DeployTargets } from './DeployTargets.js';
import type { PortReservationRepository } from './PortReservationRepository.js';
import type { PublishedPortBinding, PublishedPortsProbe } from './PublishedPortsProbe.js';
import { portKeyOf, portPlanFor } from './portReservations.js';

/** Adds evidence before opening allocation. A failed pass retains its rows and leaves the gate closed. */
export class PortInventory {
  constructor(
    private readonly profiles: Pick<ProfileRepository, 'list'>,
    private readonly versions: Pick<StackVersionRepository, 'findById'>,
    private readonly ports: PortReservationRepository,
    private readonly targets: DeployTargets,
    private readonly observer: PublishedPortsProbe,
  ) {}

  async seed(): Promise<void> {
    if (await this.ports.inventorySeededAt()) return;
    const profiles = await this.profiles.list();
    const targetByDaemon = new Map<string, string>();
    const daemonByProfile = new Map<string, string>();
    targetByDaemon.set(await this.targets.daemonIdFor('localhost'), 'localhost');

    for (const profile of profiles) {
      const alias = targetAlias(profile.host);
      const daemonId = await this.targets.daemonIdFor(alias);
      targetByDaemon.set(daemonId, alias);
      daemonByProfile.set(profile.name, daemonId);
      const version = await this.versions.findById(profile.stack_version_id);
      const contract = version?.contract;
      if (!contract?.ports.length || contract.allocationProblem) {
        throw new InvalidStackVersionError(`Cannot seed ${profile.name}: ${contract?.allocationProblem ?? 'its version has no readable port table'}`);
      }
      await this.ports.plan(daemonId, profile.name, portPlanFor(contract.ports, profile.port_slot), 'existing deployment inventory');
    }

    for (const [daemonId, alias] of targetByDaemon) {
      const snapshot = await this.observer.publishedPorts(alias);
      if (snapshot.daemonId !== daemonId) {
        throw new TargetNotVerifiedError(alias, 'The port observation came from a different Docker daemon');
      }
      for (const binding of snapshot.bindings) {
        const owner = binding.project && daemonByProfile.get(binding.project) === daemonId
          ? binding.project
          : externalOwner(binding);
        await this.ports.plan(daemonId, owner, [{
          protocol: binding.protocol,
          port: binding.port,
          service: binding.service,
          portVar: 'observed binding',
        }], 'observed published port');
      }
      const activeKeys = new Set(snapshot.bindings.map(portKeyOf));
      const rows = await this.ports.listByDaemon(daemonId);
      await this.ports.setState(rows.filter((row) => activeKeys.has(portKeyOf(row))).map((row) => row.id), 'active');
    }
    await this.ports.markInventorySeeded();
  }
}

function externalOwner(binding: PublishedPortBinding): string {
  return `external:${binding.containerId ?? binding.project ?? 'unlabelled'}`;
}
