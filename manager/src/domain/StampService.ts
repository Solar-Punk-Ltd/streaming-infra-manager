import { getErrorMessage } from '@streaming-infra-manager/common';

import { Profile, ProfileWithContainers } from '../types/index.js';

import {
  BeeAddresses,
  BeeStamp,
  BeeStampClient,
  BeeWallet,
  BuyStampInput,
} from './BeeStampClient.js';
import { ContainerRepository } from './ContainerRepository.js';
import { BeeNodeError, ProfileNotFoundError } from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';

const logger = Logger.getInstance();

const BEE_UPLOADER_API_BASE_PORT = 10005;
const LOCAL_HOSTS = new Set([
  '',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'native',
]);

/** Factory so tests can inject a fake client. */
export type BeeClientFactory = (baseUrl: string) => BeeStampClient;

/**
 * Resolve the bee-uploader node's API base URL for a profile. Ports follow the
 * slot scheme (10005 + slot*10); the node is published on the host, reached
 * from the api container via host.docker.internal (see extra_hosts in
 * docker-compose.yml). Remote-host profiles use their host verbatim.
 */
export function beeApiUrlFor(profile: Profile): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = (profile.host ?? '').trim();
  const host = LOCAL_HOSTS.has(declared) ? 'host.docker.internal' : declared;
  return `http://${host}:${port}`;
}

export class StampService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly events: EventBus,
    private readonly clientFactory: BeeClientFactory = (url) =>
      new BeeStampClient(url),
  ) {}

  async getAddress(name: string): Promise<BeeAddresses> {
    return this.call(name, (client) => client.getAddresses());
  }

  async getWallet(name: string): Promise<BeeWallet> {
    return this.call(name, (client) => client.getWallet());
  }

  async listStamps(name: string): Promise<BeeStamp[]> {
    return this.call(name, (client) => client.listStamps());
  }

  async buyStamp(
    name: string,
    input: BuyStampInput,
  ): Promise<{ batchID: string }> {
    const result = await this.call(name, (client) => client.buyStamp(input));
    logger.info(
      `[StampService] ${name}: bought stamp ${result.batchID} (amount=${input.amount}, depth=${input.depth})`,
    );
    return result;
  }

  /**
   * Persist a stamp id on the profile WITHOUT redeploying. The caller then uses
   * the "deploy uploader" action to bring the held-back uploader up.
   */
  async setStamp(name: string, stampId: string): Promise<ProfileWithContainers> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const updated = await this.profiles.updateStampId(name, stampId);
    if (!updated) throw new ProfileNotFoundError(name);

    logger.info(`[StampService] ${name}: stamp_id set`);
    const withContainers = await this.containers.withContainers(updated);
    this.events.publish({ type: 'profile.changed', profile: withContainers });
    return withContainers;
  }

  private async call<T>(
    name: string,
    fn: (client: BeeStampClient) => Promise<T>,
  ): Promise<T> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const client = this.clientFactory(beeApiUrlFor(profile));
    try {
      return await fn(client);
    } catch (err) {
      throw new BeeNodeError(name, getErrorMessage(err));
    }
  }
}
