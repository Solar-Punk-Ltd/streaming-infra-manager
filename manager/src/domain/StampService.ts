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

// Mirror swarm-cli / bee-js `waitForUsablePostageStamp`: after a buy, poll the
// node until the batch reports `usable`. A fresh batch can take minutes to
// propagate, so this runs in the background — the HTTP buy returns the batchID
// immediately and the stamp is auto-set when it becomes usable.
const USABLE_POLL_MS = 3_000;
const USABLE_WAIT_MS = 15 * 60 * 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  /** batchIDs currently being awaited, to avoid duplicate poll loops. */
  private readonly awaitingUsable = new Set<string>();

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
    // Don't block the HTTP response — poll for usability in the background and
    // auto-set the stamp when it lands (mirrors swarm-cli's wait-usable).
    this.awaitUsableAndSet(name, result.batchID);
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

  private awaitUsableAndSet(name: string, batchID: string): void {
    const key = `${name}:${batchID}`;
    if (this.awaitingUsable.has(key)) return;
    this.awaitingUsable.add(key);
    void this.runUsableWait(name, batchID)
      .catch((err) =>
        logger.error(
          `[StampService] ${name}: usable-wait for ${batchID} failed: ${getErrorMessage(err)}`,
        ),
      )
      .finally(() => this.awaitingUsable.delete(key));
  }

  /**
   * Poll `GET /stamps/{batchID}` until it reports usable (bee-js parity), then
   * set it as the profile's active stamp — but only if none is set yet, so we
   * never silently swap a stamp already in use. Publishes profile.changed so
   * the UI flips to "Stamp set" and enables "Deploy uploader".
   */
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
        // Node may not have indexed the fresh batch yet — keep polling.
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
