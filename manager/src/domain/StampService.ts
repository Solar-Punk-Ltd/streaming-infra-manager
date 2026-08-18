import { existsSync } from 'node:fs';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Profile, ProfileWithContainers } from '../types/index.js';

import {
  BeeAddresses,
  BeeChainState,
  BeeStamp,
  BeeStampClient,
  BeeWallet,
  BuyStampInput,
} from './BeeStampClient.js';
import { ContainerRepository } from './ContainerRepository.js';
import {
  BeeHttpError,
  BeeNodeError,
  ProfileNotFoundError,
  StampNotUsableError,
} from './errors/index.js';
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

// Local profiles publish their bee API on a host port. The manager reaches it
// via host.docker.internal when it runs inside its own container (see
// manager/docker-compose.yml extra_hosts); running natively (dev/e2e) that name
// doesn't resolve, so fall back to 127.0.0.1. Override with BEE_LOCAL_HOST.
const LOCAL_BEE_HOST =
  process.env.BEE_LOCAL_HOST ??
  (existsSync('/.dockerenv') ? 'host.docker.internal' : '127.0.0.1');

const USABLE_POLL_MS = 3_000;
const USABLE_WAIT_MS = 15 * 60 * 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type BeeClientFactory = (baseUrl: string) => BeeStampClient;

export function beeApiUrlFor(profile: Profile): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = (profile.host ?? '').trim();
  const host = LOCAL_HOSTS.has(declared) ? LOCAL_BEE_HOST : declared;
  return `http://${host}:${port}`;
}

export class StampService {
  private readonly pendingUsableWaits = new Set<string>();

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

  async getChainState(name: string): Promise<BeeChainState> {
    return this.call(name, (client) => client.getChainState());
  }

  async buyStamp(
    name: string,
    input: BuyStampInput,
  ): Promise<{ batchID: string }> {
    const result = await this.call(name, (client) => client.buyStamp(input));
    logger.info(
      `[StampService] ${name}: bought stamp ${result.batchID} (amount=${input.amount}, depth=${input.depth})`,
    );
    this.awaitUsableAndSet(name, result.batchID);
    return result;
  }

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

  // Best-effort: only a definite unknown (404) or not-usable answer from bee blocks the deploy.
  async assertStampUsable(name: string, stampId: string): Promise<void> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const client = this.clientFactory(beeApiUrlFor(profile));
    let stamp: BeeStamp;
    try {
      stamp = await client.getStamp(stampId.replace(/^0x/, ''));
    } catch (err) {
      if (err instanceof BeeHttpError && err.status === 404) {
        throw new StampNotUsableError(
          name,
          'the configured stamp is unknown to this bee node',
        );
      }
      logger.warn(
        `[StampService] ${name}: could not verify stamp usability, proceeding: ${getErrorMessage(err)}`,
      );
      return;
    }
    if (!stamp.usable) {
      const reason =
        stamp.batchTTL === 0
          ? 'the configured stamp has expired'
          : 'the configured stamp is not usable yet';
      throw new StampNotUsableError(name, reason);
    }
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

  private awaitUsableAndSet(name: string, batchID: string): void {
    const key = `${name}:${batchID}`;
    if (this.pendingUsableWaits.has(key)) return;
    this.pendingUsableWaits.add(key);
    void this.runUsableWait(name, batchID)
      .catch((err) =>
        logger.error(
          `[StampService] ${name}: usable-wait for ${batchID} failed: ${getErrorMessage(err)}`,
        ),
      )
      .finally(() => this.pendingUsableWaits.delete(key));
  }

  private async runUsableWait(name: string, batchID: string): Promise<void> {
    const profile = await this.profiles.findByName(name);
    if (!profile) return;
    const client = this.clientFactory(beeApiUrlFor(profile));

    const start = Date.now();
    while (Date.now() - start < USABLE_WAIT_MS) {
      await sleep(USABLE_POLL_MS);
      let usable = false;
      try {
        const stamp = await client.getStamp(batchID);
        usable = stamp.usable;
      } catch {
        continue;
      }
      if (!usable) continue;

      const current = await this.profiles.findByName(name);
      if (!current) return;
      if (current.stamp_id) {
        logger.info(
          `[StampService] ${name}: stamp ${batchID} usable; profile already has a stamp, not overriding`,
        );
        return;
      }
      const updated = await this.profiles.updateStampId(name, batchID);
      if (updated) {
        const withContainers = await this.containers.withContainers(updated);
        this.events.publish({
          type: 'profile.changed',
          profile: withContainers,
        });
        logger.info(
          `[StampService] ${name}: stamp ${batchID} usable → set as active`,
        );
      }
      return;
    }
    logger.warn(
      `[StampService] ${name}: stamp ${batchID} not usable within ${USABLE_WAIT_MS}ms`,
    );
  }
}
