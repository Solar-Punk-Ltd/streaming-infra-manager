
import {
  classifyPublishUrl,
  type BeeNodeObservation,
  getErrorMessage,
  type PublishUrlState,
  type StampHealth,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import { Profile, ProfileWithContainers } from '../types/index.js';
import { resolveNetworkHost } from '../utils/deployHost.js';

import {
  BeeAddresses,
  BeeChainState,
  BeeClient,
  BeeStamp,
  BeeWallet,
  BuyStampInput,
} from './BeeClient.js';
import { beeCallFailed } from './beeFailure.js';
import { ContainerRepository } from './ContainerRepository.js';
import {
  BeeHttpError,
  ProfileNotFoundError,
  StampNotUsableError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { NodeReadCache, nodeReadKey } from './nodeReadCache.js';
import {
  NodeReadLog,
  readLogKey,
  spellSuffix,
  spellText,
} from './nodeReadLog.js';
import { readFailureFrom } from './nodeReadFailure.js';
import { ProfileRepository } from './ProfileRepository.js';
import { LOCAL_DEPLOY_TARGETS, LOCAL_PUBLISHED_HOST } from './localHost.js';

const logger = Logger.getInstance();

const BEE_UPLOADER_API_BASE_PORT = 10005;

// Local profiles publish their bee API on a host port, reached the way every
// published port is.
const LOCAL_BEE_HOST = LOCAL_PUBLISHED_HOST;

const USABLE_POLL_MS = 3_000;
const USABLE_WAIT_MS = 15 * 60 * 1_000;

// Verifying a recorded batch happens per rung on a page load, so it gets a
// tighter budget than an operator-triggered call: four rungs answering in
// parallel, and a node that is down must not hold the page for ten seconds.
const PROBE_TIMEOUT_MS = 3_000;

/** Keyed on the address itself, since a probe of it belongs to no one profile. */
const PUBLISH_URL_PROBE_KEY = (url: string): string => `publish-url:${url}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bee's own spelling of a batch id, which is what a stamp path and a key want. */
const batchIdOf = (stampId: string): string => stampId.replace(/^0x/, '');

export type BeeClientFactory = (
  baseUrl: string,
  timeoutMs?: number,
) => BeeClient;

/**
 * The node's network address, taken out of a deploy target.
 *
 * `profiles.host` holds a *deploy* target: the schema validates it against
 * `/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/` and documents it as "localhost, an ssh
 * alias, or user@host". Neither of the two non-trivial forms is an address. The
 * user half addresses an ssh account and never the bee API, and left in place it
 * composes to `http://deploy@1.2.3.4:10055`, not a bee base URL, and a stray `@`
 * inside a BEE_PUBLISHERS entry format that already separates the rung from the
 * URL on `@`. An alias is a key into an ssh config and resolves nowhere else, so
 * `http://vultr-eu-1:10055` times out on every probe.
 *
 * resolveNetworkHost undoes both, reading the same ssh config deploy.sh reads.
 * See manager/src/utils/deployHost.ts.
 */
function networkHostOf(declaredHost: string): string {
  return resolveNetworkHost(declaredHost);
}

export function beeApiUrlFor(profile: Profile): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = networkHostOf((profile.host ?? '').trim());
  const host = LOCAL_DEPLOY_TARGETS.has(declared) ? LOCAL_BEE_HOST : declared;
  return `http://${host}:${port}`;
}

/**
 * The bee API URL an ABR ladder's BEE_PUBLISHERS carries, which is the address a
 * stream-uploader **container on this host** dials.
 *
 * Deliberately not the manager's public host. T06 binds every local Bee API to
 * the Docker bridge address and to nothing else, so the public address answers on
 * those ports from nowhere at all, and an uploader deployed by this manager runs
 * beside it rather than on another machine. `localPublisherHost` is what a
 * container here reaches such a node on, from resolveLocalPublisherHost in
 * localHost.ts.
 *
 * A member on a declared remote host keeps that host's own address, and that is
 * the T06 caveat: the remote node's API has to be bound somewhere this host can
 * reach, which its own operator decides.
 */
export function beePublisherUrlFor(
  profile: Profile,
  localPublisherHost: string,
): string {
  const port = BEE_UPLOADER_API_BASE_PORT + profile.port_slot * 10;
  const declared = networkHostOf((profile.host ?? '').trim());
  const host = LOCAL_DEPLOY_TARGETS.has(declared) ? localPublisherHost : declared;
  return `http://${host}:${port}`;
}

export class StampService {
  private readonly pendingUsableWaits = new Set<string>();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly events: EventBus,
    private readonly clientFactory: BeeClientFactory = (url, timeoutMs) =>
      new BeeClient(url, timeoutMs),
    private readonly reads: NodeReadCache = new NodeReadCache(),
    private readonly readLog: NodeReadLog = new NodeReadLog(),
  ) {}

  async getNodeObservation(name: string): Promise<BeeNodeObservation> {
    return this.shared(name, 'observation', (client) =>
      client.getNodeObservation(),
    );
  }

  async getAddress(name: string): Promise<BeeAddresses> {
    return this.shared(name, 'addresses', (client) => client.getAddresses());
  }

  async getWallet(name: string): Promise<BeeWallet> {
    return this.shared(name, 'wallet', (client) => client.getWallet());
  }

  async listStamps(name: string): Promise<BeeStamp[]> {
    return this.shared(name, 'stamps', (client) => client.listStamps());
  }

  async getChainState(name: string): Promise<BeeChainState> {
    return this.shared(name, 'chainstate', (client) => client.getChainState());
  }

  async buyStamp(
    name: string,
    input: BuyStampInput,
  ): Promise<{ batchID: string }> {
    const result = await this.call(name, (client) => client.buyStamp(input));
    this.reads.forget(name);
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
   * `'unknown'`, unverified, deliberately not `'expired'`, because a node being
   * down is no evidence about its batch, so a caller can degrade to a caution
   * rather than a false alarm.
   */
  async stampHealthFor(
    profile: Profile,
    stampId: string | null | undefined,
  ): Promise<StampHealth> {
    if (!stampId || !stampId.trim()) return stampHealthFrom(null, []);

    return this.reads.read(this.stampKey(profile.name, stampId), async () => {
      const client = this.clientFactory(beeApiUrlFor(profile), PROBE_TIMEOUT_MS);
      const started = Date.now();
      const logKey = readLogKey(profile.name, 'stamp');
      const answered = <T,>(health: T): T => {
        this.readLog.noteRecovery(
          logKey,
          (note) => `[StampService] ${profile.name}: the node answers about its stamps again, after ${spellText(note)}`,
        );
        return health;
      };
      try {
        const stamp = await client.getStamp(batchIdOf(stampId));
        return answered(stampHealthFrom(stampId, [stamp]));
      } catch (err) {
        // A 404 is bee saying it has no such batch, expired long enough ago that
        // it was dropped. That is an answer, not a failure to answer, so it maps to
        // an empty list (`gone`) rather than to no list at all (`unknown`).
        if (err instanceof BeeHttpError && err.status === 404) {
          return answered(stampHealthFrom(stampId, []));
        }
        const failure = readFailureFrom(err, Date.now() - started);
        this.readLog.noteFailure(
          logKey,
          (note) =>
            `[StampService] ${profile.name}: stamp ${stampId} not verified after ${failure.elapsedMs}ms (${failure.reason}): ${getErrorMessage(err)}${spellSuffix(note)}`,
        );
        return stampHealthFrom(stampId, null, failure);
      }
    });
  }

  /**
   * Whether a bee node actually answers at the address a ladder publishes.
   *
   * Probes the *published* URL, not `beeApiUrlFor`. That is the whole point.
   * The manager reaches a local node through `host.docker.internal` or
   * `127.0.0.1`, so verifying the batch proves nothing about the address an
   * uploader elsewhere is handed. Those two can disagree, and when they do the
   * ladder looks complete and no upload ever lands.
   *
   * Structural verdicts come back without a request, since no probe would change
   * them. Otherwise a failed probe is reported as `'unreachable'`: evidence, not
   * proof: a manager that cannot loop back through its own public address says
   * nothing about an uploader on another host, which is why this warns rather
   * than blocks.
   */
  async publishUrlStateFor(url: string): Promise<PublishUrlState> {
    const structural = classifyPublishUrl(url);
    if (structural !== 'ok') return structural;

    return this.reads.read(PUBLISH_URL_PROBE_KEY(url), async () => {
      const started = Date.now();
      const logKey = readLogKey(url, 'probe');
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Any HTTP answer means something is listening and routable, and bee's own
        // /health is the best signal, but a non-2xx from *something* still tells us
        // the address is not the problem.
        await res.text().catch(() => undefined);
        this.readLog.noteRecovery(
          logKey,
          (note) => `[StampService] ${url} answers again, after ${spellText(note)}`,
        );
        return 'ok' as PublishUrlState;
      } catch (err) {
        const failure = readFailureFrom(err, Date.now() - started);
        this.readLog.noteFailure(
          logKey,
          (note) =>
            `[StampService] nothing answered at ${url} after ${failure.elapsedMs}ms (${failure.reason}): ${getErrorMessage(err)}${spellSuffix(note)}`,
        );
        return 'unreachable' as PublishUrlState;
      }
    });
  }

  /**
   * A batch the node answered about and called unknown, expired or not usable
   * yet blocks the start: an uploader on such a batch reports RUNNING and
   * fails every upload, and the node itself has said so.
   *
   * A node that answers nothing no longer blocks it. Decision D16, the owner
   * on 2026-09-17: "we should be able to start the uploader but maybe say its
   * node not available, try to reconnect or something". The uploader waits for
   * its node instead of exiting, and reports that wait on its own health
   * route, which UploaderHealthService reads onto the deployment page. So the
   * silence becomes a state an operator can watch rather than a refusal they
   * can do nothing about.
   */
  async assertStampUsable(name: string, stampId: string): Promise<void> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const nodeUrl = beeApiUrlFor(profile);
    const client = this.clientFactory(nodeUrl);
    let stamp: BeeStamp;
    try {
      stamp = await this.reads.readFresh(this.stampKey(name, stampId), () =>
        client.getStamp(batchIdOf(stampId)),
      );
    } catch (err) {
      if (err instanceof BeeHttpError && err.status === 404) {
        throw new StampNotUsableError(
          name,
          'the configured stamp is unknown to this bee node',
        );
      }
      logger.warn(
        `[StampService] ${name}: the Bee node at ${nodeUrl} did not answer the stamp check (${getErrorMessage(err)}). ` +
          'The uploader is started anyway and waits for its node, on decision D16.',
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

  /** One batch on one profile, however the caller spelled the id. */
  private stampKey(name: string, stampId: string): string {
    return nodeReadKey(name, `stamp/${batchIdOf(stampId)}`);
  }

  private shared<T>(
    name: string,
    route: string,
    fn: (client: BeeClient) => Promise<T>,
  ): Promise<T> {
    return this.reads.read(nodeReadKey(name, route), () => this.call(name, fn));
  }

  private async call<T>(
    name: string,
    fn: (client: BeeClient) => Promise<T>,
  ): Promise<T> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const client = this.clientFactory(beeApiUrlFor(profile));
    try {
      return await fn(client);
    } catch (err) {
      throw beeCallFailed(name, err);
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
