import { createHash } from 'node:crypto';
import { PORT_POLICY_VERSION, portExposureProblem, publicPortRole } from '@streaming-infra-manager/common';
import { InvalidStackVersionError } from '../errors/index.js';
import type { TargetIdentityProbe } from './VerifiedDeployTargets.js';
import type { PublishedPortsProbe } from './PublishedPortsProbe.js';
import { portKeyOf, portPlanFor } from './portReservations.js';
import type { FirewallClaim, FirewallContractReader, FirewallInventory, FirewallState, FirewallStateSource } from './firewallInventoryTypes.js';

function refuse(reason: string): never { throw new InvalidStackVersionError(`Firewall inventory: ${reason}`); }
function fingerprint(state: FirewallState): string { return createHash('sha256').update(JSON.stringify(state)).digest('hex'); }

/** Captures evidence for a ruleset draft. It never changes a reservation, deployment or firewall. */
export class FirewallInventoryExporter {
  constructor(
    private readonly source: FirewallStateSource,
    private readonly observer: PublishedPortsProbe & TargetIdentityProbe,
    private readonly contracts: FirewallContractReader,
  ) {}

  async export(alias: string): Promise<FirewallInventory> {
    const before = await this.source.read();
    const target = before.targets.find(row => row.alias === alias && row.verified);
    if (!target?.daemonId) refuse(`${alias} is not a verified target.`);
    const daemonId = target.daemonId;
    if (!before.inventoryReady || !before.seededDaemons.includes(daemonId)) refuse('The reservation inventory is incomplete.');
    const daemonByAlias = new Map<string, string>();
    for (const name of new Set([alias, ...before.profiles.map(profile => profile.target)])) {
      const stored = before.targets.find(row => row.alias === name && row.verified);
      if (!stored?.daemonId) refuse(`${name} has no verified daemon identity.`);
      if (await this.observer.daemonId(name) !== stored.daemonId) refuse(`${name} reaches a different daemon. Verify it before exporting.`);
      daemonByAlias.set(name, stored.daemonId);
    }
    const profiles = before.profiles.filter(profile => daemonByAlias.get(profile.target) === daemonId);
    const names = new Set(profiles.map(profile => profile.name));
    const reservations = before.reservations.filter(row => row.daemonId === daemonId);
    if (profiles.some(profile => ['DEPLOYING', 'REMOVING', 'STOPPING'].includes(profile.status))) refuse('A deployment operation is in progress.');
    if (before.references.some(ref => ref.holderKind === 'operation' || (ref.holderKind === 'job' && names.has(ref.holderId)))
      || before.attempts.some(attempt => attempt.daemonId === daemonId || names.has(attempt.project))) {
      refuse('An unresolved job, creation attempt or rollback operation still holds these resources.');
    }

    const claims: FirewallClaim[] = [];
    for (const profile of profiles) {
      const current = before.versions.find(version => version.id === profile.versionId);
      if (!current?.buildId || current.layout !== 'builds' || !current.rootPath) refuse(`${profile.name} has mutable legacy or missing build history.`);
      const required = [
        { version: current, buildId: current.buildId, services: null as readonly string[] | null, mandatory: false },
        ...(current.previousBuildId ? [{ version: current, buildId: current.previousBuildId, services: null, mandatory: false }] : []),
      ];
      for (const ref of before.references.filter(ref => ref.holderKind === 'snapshot' && ref.holderId.startsWith(`${profile.name}/`))) {
        const version = before.versions.find(row => row.id === ref.versionId);
        if (!version || version.layout !== 'builds' || !version.rootPath) refuse(`${profile.name} has unprovable retained build history.`);
        required.push({ version, buildId: ref.buildId, services: ref.services, mandatory: true });
      }
      for (const { version, buildId, services, mandatory } of required) {
        const contract = await this.contracts.read(version, buildId);
        if (!contract.ports.length || contract.allocationProblem) refuse(`${profile.name} has no complete port contract for build ${buildId}.`);
        const plan = portPlanFor(contract.ports, profile.slot)
          .filter(entry => services === null || (entry.service !== null && services.includes(entry.service)))
          .filter(entry => mandatory || reservations.some(row => row.profileName === profile.name
            && row.heldServices.includes(entry.service) && portKeyOf(row) === portKeyOf(entry)));
        for (const entry of plan) {
          const problem = portExposureProblem(entry);
          if (problem) refuse(`${profile.name}: ${problem}`);
          claims.push({ ...entry, profileName: profile.name, versionId: version.id, buildId });
        }
      }
    }

    if (before.reservations.some(row => names.has(row.profileName) && row.daemonId !== daemonId)) refuse('A deployment retains reservations on another daemon.');
    for (const row of reservations) {
      if (!names.has(row.profileName)) {
        if (publicPortRole(row)) refuse(`${row.profileName} is an unknown owner of public ${portKeyOf(row)}.`);
        continue;
      }
      if (!row.heldServices.length || row.heldServices.some(service => service === null
        || !claims.some(claim => claim.profileName === row.profileName && claim.service === service && portKeyOf(claim) === portKeyOf(row)))) {
        refuse(`${row.profileName} has a reservation at ${portKeyOf(row)} without retained contract coverage.`);
      }
    }
    for (const claim of claims) {
      if (!reservations.some(row => row.profileName === claim.profileName && row.heldServices.includes(claim.service) && portKeyOf(row) === portKeyOf(claim))) {
        refuse(`${claim.profileName}/${claim.service} has a retained contract port ${portKeyOf(claim)} without a reservation.`);
      }
    }
    const observed = await this.observer.publishedPorts(alias);
    if (observed.daemonId !== daemonId) refuse('Port observations came from a different daemon.');
    if (observed.unverifiedProjects?.length) refuse('Host-network bindings are not fully known.');
    for (const binding of observed.bindings) {
      if ((publicPortRole(binding) || (binding.project && names.has(binding.project)))
        && !claims.some(claim => claim.profileName === binding.project && claim.service === binding.service && portKeyOf(claim) === portKeyOf(binding))) {
        refuse(`An observed binding at ${portKeyOf(binding)} has no known compatible contract.`);
      }
    }
    for (const [name, expected] of daemonByAlias) {
      if (await this.observer.daemonId(name) !== expected) refuse(`${name} changed daemon during capture.`);
    }
    if (fingerprint(before) !== fingerprint(await this.source.read())) refuse('Database evidence changed during capture. Retry when operations finish.');
    return { schemaVersion: 1, policyVersion: PORT_POLICY_VERSION, daemonId, capturedAt: new Date().toISOString(),
      fingerprint: fingerprint(before), profiles, claims, reservations, bindings: observed.bindings };
  }
}
