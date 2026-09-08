import { createHash } from 'node:crypto';
import { BEE_UPLOADER_SERVICE, ownsBeeNode } from '@streaming-infra-manager/common';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { beeApiUrlFor } from '../StampService.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import type { ChequebookEndpointMode } from './ChequebookChainRegistry.js';
import type { ConfiguredBeeTarget } from './ChequebookTransferPreparation.js';

/** Uses a configured snapshot only. T06 must supply current reservation ownership at aggregate integration. */
export class ConfiguredBeeTargetResolver {
  constructor(private readonly profiles: Pick<ProfileRepository, 'findByName'>,
    private readonly containers: Pick<ContainerRepository, 'listApiContainers'>,
    private readonly mode: ChequebookEndpointMode = 'disabled') {}

  async resolve(profileName: string): Promise<ConfiguredBeeTarget> {
    try {
      if (this.mode !== 'direct') throw new ChequebookPreparationError();
      const profile = await this.profiles.findByName(profileName);
      if (!profile || !ownsBeeNode(profile) || ['DEPLOYING', 'STOPPING', 'REMOVING'].includes(profile.status)) throw new ChequebookPreparationError();
      const bees = (await this.containers.listApiContainers(profileName)).filter(container => container.service === BEE_UPLOADER_SERVICE);
      const port = bees[0]?.ports.BEE_UPLOADER_API_PORT;
      if (bees.length !== 1 || !Number.isInteger(port) || port! < 1 || port! > 65535) throw new ChequebookPreparationError();
      const url = new URL(beeApiUrlFor(profile));
      url.port = String(port);
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ChequebookPreparationError();
      const revision = createHash('sha256').update(JSON.stringify([profile.name, profile.created_at.toISOString(), profile.updated_at.toISOString(),
        profile.host, profile.port_slot, profile.kind, profile.components, profile.status, profile.stack_version_id, port, url.href])).digest('hex');
      return Object.freeze({ topology: 'operator_asserted_direct', url: url.href, revision });
    } catch { throw new ChequebookPreparationError(); }
  }
}
