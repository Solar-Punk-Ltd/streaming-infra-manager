import { existsSync } from 'node:fs';

import {
  classifyPublishUrl,
  getErrorMessage,
  type PublishUrlState,
  type StampHealth,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import { Profile, ProfileWithContainers } from '../types/index.js';
import { resolveServerHost } from '../utils/serverHost.js';

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

// Verifying a recorded batch happens per rung on a page load, so it gets a
// tighter budget than an operator-triggered call: four rungs answering in
// parallel, and a node that is down must not hold the page for ten seconds.
const PROBE_TIMEOUT_MS = 3_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type BeeClientFactory = (
  baseUrl: string,
  timeoutMs?: number,
) => BeeStampClient;

/**
 * The node's network address, taken out of a deploy target.
 *
 * `profiles.host` holds a *deploy* target: the schema validates it against
 * `/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/` and documents it as "localhost, an ssh
 * alias, or user@host". The user half addresses an ssh account and never the bee
 * API, and left in place it composes to `http://deploy@1.2.3.4:10055` — not a bee
 * base URL, and a stray `@` inside a BEE_PUBLISHERS entry format that already
 * separates the rung from the URL on `@`.
 *
 * Stripping it is safe in a way that guessing at the rest is not: the userinfo is
 * provably not part of the address, whereas an ssh *alias* may well resolve for
 * the uploader, so that is left alone and left to the reachability probe.
 */
function networkHostOf(declaredHost: string): string {
  const at = declaredHost.lastIndexOf('@');
  return at === -1 ? declaredHost : declaredHost.slice(at + 1);
}

export function beeApiUrlFor(profile: Profile): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = networkHostOf((profile.host ?? '').trim());
  const host = LOCAL_HOSTS.has(declared) ? LOCAL_BEE_HOST : declared;
  return `http://${host}:${port}`;
}

// resolveServerHost() logs which source it picked, so memoise it — this is read
// once per ladder rung per request and the value cannot change at runtime.
let cachedPublicHost: string | null = null;
function publicHost(): string {
  cachedPublicHost ??= resolveServerHost();
  return cachedPublicHost;
}

/**
 * The bee API URL **something off-host** uses — i.e. what an ABR ladder's
 * BEE_PUBLISHERS carries to a stream-uploader running elsewhere.
 *
 * Deliberately not beeApiUrlFor: that one resolves a local profile to
 * host.docker.internal or 127.0.0.1, neither of which means anything to a caller
 * on another machine.
 */
export function beePublicApiUrlFor(profile: Profile): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = networkHostOf((profile.host ?? '').trim());
  const host = LOCAL_HOSTS.has(declared) ? publicHost() : declared;
  return `http://${host}:${port}`;
}

export class StampService {
  private readonly pendingUsableWaits = new Set<string>();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly events: EventBus,
    private readonly clientFactory: BeeClientFactory = (url, timeoutMs) =>
      new BeeStampClient(url, timeoutMs),
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

  /**
   * What a profile's own bee node says, right now, about the batch recorded on it.
   *
   * `profiles.stamp_id` records which batch an uploader was pointed at, not that
   * the batch still works: batches are finite leases, they expire on their own,
   * and nothing writes that back to the column. Anything that reports a profile
   * as ready to upload has to ask the node.
   *
   * Never throws, and never waits long. A node that is unreachable answers
   * `'unknown'` — unverified, deliberately not `'expired'`, because a node being
   * down is no evidence about its batch — so a caller can degrade to a caution
   * rather than a false alarm.
   */
  async stampHealthFor(
    profile: Profile,
    stampId: string | null | undefined,
  ): Promise<StampHealth> {
    if (!stampId || !stampId.trim()) return stampHealthFrom(null, []);

    const client = this.clientFactory(beeApiUrlFor(profile), PROBE_TIMEOUT_MS);
    try {
      const stamp = await client.getStamp(stampId.replace(/^0x/, ''));
      return stampHealthFrom(stampId, [stamp]);
    } catch (err) {
      // A 404 is bee saying it has no such batch — expired long enough ago that
      // it was dropped. That is an answer, not a failure to answer, so it maps to
      // an empty list (`gone`) rather than to no list at all (`unknown`).
      if (err instanceof BeeHttpError && err.status === 404) {
        return stampHealthFrom(stampId, []);
      }
      logger.debug(
        `[StampService] ${profile.name}: could not verify stamp ${stampId}: ${getErrorMessage(err)}`,
      );
      return stampHealthFrom(stampId, null);
    }
  }

  /**
   * Whether a bee node actually answers at the address a ladder publishes.
   *
   * Probes the *published* URL, not `beeApiUrlFor` — that is the whole point.
   * The manager reaches a local node through `host.docker.internal` or
   * `127.0.0.1`, so verifying the batch proves nothing about the address an
   * uploader elsewhere is handed; those two can disagree, and when they do the
   * ladder looks complete and no upload ever lands.
   *
   * Structural verdicts come back without a request, since no probe would change
   * them. Otherwise a failed probe is reported as `'unreachable'` — evidence, not
   * proof: a manager that cannot loop back through its own public address says
   * nothing about an uploader on another host, which is why this warns rather
   * than blocks.
   */
  async publishUrlStateFor(url: string): Promise<PublishUrlState> {
    const structural = classifyPublishUrl(url);
    if (structural !== 'ok') return structural;

    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Any HTTP answer means something is listening and routable; bee's own
      // /health is the best signal, but a non-2xx from *something* still tells us
      // the address is not the problem.
      await res.text().catch(() => undefined);
      return 'ok';
    } catch (err) {
      logger.debug(
        `[StampService] nothing answered at ${url}: ${getErrorMessage(err)}`,
      );
      return 'unreachable';
    }
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
