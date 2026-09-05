import {
  beePublishersProblem,
  isStampExpiringSoon,
  parseBeePublishers,
  type StampHealth,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { canDeployUploader } from '../data';
import {
  BZZ_DECIMALS,
  formatTokenBalance,
  formatTtl,
  shortHex,
  XDAI_DECIMALS,
} from '../format';
import type { Profile } from '../types';
import type { BeeStamp, BeeWallet } from '../uploaders/stampApi';
import { isStreamLike } from './readiness';
import { hasService, isRunning, isTransitional, shapeOf } from './shape';

export type StepState = 'ok' | 'warn' | 'err' | 'busy' | 'off';

export type StepActionKind =
  | 'start'
  | 'copy-address'
  | 'buy-stamp'
  | 'deploy-uploader'
  | 'edit'
  | 'open-stream';

export interface StepAction {
  label: string;
  kind: StepActionKind;
  /** The value a copy action puts on the clipboard, or the stream to open. */
  value?: string;
  primary?: boolean;
}

export interface ChecklistStep {
  title: string;
  state: StepState;
  detail: string;
  action?: StepAction;
}

export interface ChecklistInput {
  profile: Profile;
  /** What this deployment's own Bee node holds, when the page asked it. */
  wallet: BeeWallet | null;
  nodeAddress: string | null;
  stampHealth: StampHealth;
  /** The recorded batch as the node reports it, for its depth. */
  currentStamp: BeeStamp | null;
  publishUrl: string | null;
  clientUrl: string | null;
  /** Every profile on this manager that signs a stream, to name a feed owner. */
  streamers: Profile[];
}

export function buildChecklist(input: ChecklistInput): ChecklistStep[] {
  const { profile } = input;
  const shape = shapeOf(profile);
  const steps: ChecklistStep[] = [containersStep(profile)];

  const ownsNode = isStreamLike(profile, shape) || shape === 'bee-node';
  if (ownsNode) {
    steps.push(fundingStep(input));
    steps.push(stampStep(input));
  }
  if (isStreamLike(profile, shape)) steps.push(uploaderStep(input));
  if (shape === 'abr-uploader') steps.push(poolStep(profile));
  if (shape === 'viewer' || hasService(profile, 'client')) {
    steps.push(followingStep(input));
  }

  return steps;
}

function containersStep(profile: Profile): ChecklistStep {
  const services = profile.containers.map((c) => c.service);
  const state: StepState = isRunning(profile)
    ? 'ok'
    : profile.status === 'DEPLOYING'
      ? 'busy'
      : profile.status === 'ERROR'
        ? 'err'
        : 'off';

  const detail = isRunning(profile)
    ? services.join(', ') || 'Running with no containers reported.'
    : profile.status === 'ERROR'
      ? 'Last deploy failed, see the error above.'
      : profile.status === 'DEPLOYING'
        ? 'Starting containers…'
        : 'Stopped.';

  const canAct = !isRunning(profile) && !isTransitional(profile);
  return {
    title: 'Containers running',
    state,
    detail,
    action: canAct
      ? {
          label: profile.status === 'ERROR' ? 'Retry' : 'Start',
          kind: 'start',
          primary: true,
        }
      : undefined,
  };
}

function fundingStep({
  profile,
  wallet,
  nodeAddress,
}: ChecklistInput): ChecklistStep {
  const action: StepAction | undefined = nodeAddress
    ? { label: 'Copy node address', kind: 'copy-address', value: nodeAddress }
    : undefined;

  if (!wallet) {
    return {
      title: 'Bee node funded',
      state: isRunning(profile) ? 'warn' : 'off',
      detail: isRunning(profile)
        ? 'Waiting for the node to report its balances.'
        : 'Start the deployment to read its balances.',
      action,
    };
  }

  const xdai = toBigInt(wallet.nativeTokenBalance);
  const bzz = toBigInt(wallet.bzzBalance);
  const xdaiText = formatTokenBalance(wallet.nativeTokenBalance, XDAI_DECIMALS);
  const bzzText = formatTokenBalance(wallet.bzzBalance, BZZ_DECIMALS);
  const funded = xdai > 0n && bzz > 0n;

  const detail = funded
    ? `xDAI ${xdaiText} for gas · BZZ ${bzzText} for storage`
    : bzz <= 0n && xdai > 0n
      ? `Has xDAI ${xdaiText} but no BZZ. Send BZZ to the node address to be able to buy a stamp.`
      : 'Send xDAI and BZZ to the node address.';

  return {
    title: 'Bee node funded',
    state: funded ? 'ok' : isRunning(profile) ? 'warn' : 'off',
    detail,
    action,
  };
}

function stampStep({
  profile,
  wallet,
  stampHealth,
  currentStamp,
}: ChecklistInput): ChecklistStep {
  const title = 'Postage stamp set';
  const funded = wallet != null && toBigInt(wallet.bzzBalance) > 0n;
  const buy = (label: string, primary = false): StepAction => ({
    label,
    kind: 'buy-stamp',
    primary,
  });

  switch (stampHealth.state) {
    case 'none':
      return {
        title,
        state: funded && isRunning(profile) ? 'warn' : 'off',
        detail:
          'A stamp is prepaid Swarm storage. Buy one below once the node has BZZ.',
        action: buy('Buy stamp', funded && isRunning(profile)),
      };
    case 'expired':
    case 'gone':
      return {
        title,
        state: 'err',
        detail:
          stampHealth.state === 'expired'
            ? 'Expired. Uploads fail until a new stamp is bought and set.'
            : 'This node no longer holds the batch recorded here. Buy a new one and set it.',
        action: buy('Buy stamp', true),
      };
    case 'pending':
      return {
        title,
        state: 'busy',
        detail:
          'Bought, waiting for the network to confirm it. It is set automatically.',
      };
    case 'unknown':
      return {
        title,
        state: isRunning(profile) ? 'warn' : 'off',
        detail: `A batch is recorded (${shortHex(profile.stamp_id ?? '')}) but its node could not be asked whether it still pays.`,
      };
    case 'active':
      return {
        title,
        state: isStampExpiringSoon(stampHealth.ttl) ? 'warn' : 'ok',
        detail: activeStampDetail(profile, stampHealth, currentStamp),
        action: isStampExpiringSoon(stampHealth.ttl)
          ? buy('Buy next stamp')
          : undefined,
      };
  }
}

function activeStampDetail(
  profile: Profile,
  health: StampHealth,
  stamp: BeeStamp | null,
): string {
  const parts = [`${formatTtl(health.ttl)} left`];
  if (profile.stamp_id) parts.push(`batch ${shortHex(profile.stamp_id)}`);
  if (stamp) parts.push(`depth ${stamp.depth}`);
  return parts.join(' · ');
}

function uploaderStep({ profile, stampHealth }: ChecklistInput): ChecklistStep {
  const title = 'Uploader running';
  const deployed = profile.containers.some(
    (c) => c.service === STREAM_UPLOADER_SERVICE,
  );
  if (deployed) {
    return {
      title,
      state: 'ok',
      detail: 'stream-uploader is publishing segments to Swarm.',
    };
  }

  const ready = canDeployUploader(profile) && stampHealth.ok;
  return {
    title,
    state: ready ? 'warn' : 'off',
    detail: ready
      ? 'Stamp is set. Start the uploader to complete the stack.'
      : 'Held back until a stamp is set. The rest of the stack runs meanwhile.',
    action: ready
      ? { label: 'Start uploader', kind: 'deploy-uploader', primary: true }
      : undefined,
  };
}

function poolStep(profile: Profile): ChecklistStep {
  const title = 'Node pool reachable';
  const problem = beePublishersProblem(profile.bee_publishers);
  if (problem) {
    return {
      title,
      state: 'err',
      detail: 'The pool string on this deployment is not usable. Fix it under Edit.',
      action: { label: 'Edit', kind: 'edit' },
    };
  }

  const entries = parseBeePublishers(profile.bee_publishers ?? '') ?? [];
  const first = entries[0];
  const host = first ? first.url.replace(/:\d+$/, '') : 'the pool';
  return {
    title,
    state: 'ok',
    detail: `${entries.length} rungs · ${host} and ${Math.max(0, entries.length - 1)} more`,
  };
}

function followingStep({ profile, streamers }: ChecklistInput): ChecklistStep {
  const title = 'Following a stream';
  const owner = profile.feed_owner?.trim();
  if (!owner) {
    return {
      title,
      state: 'warn',
      detail: 'No streamer address set. Add one under Edit to give it something to play.',
      action: { label: 'Edit', kind: 'edit' },
    };
  }

  const streamer = streamerFor(owner, streamers);
  return {
    title,
    state: 'ok',
    detail: streamer
      ? `${streamer.name} on this manager (${shortHex(owner)})`
      : `External streamer ${shortHex(owner)}`,
    action: streamer
      ? { label: 'Open stream', kind: 'open-stream', value: streamer.name }
      : undefined,
  };
}

/** The profile on this manager that signs the feed at `address`, if any. */
export function streamerFor(
  address: string | null | undefined,
  streamers: Profile[],
): Profile | null {
  if (!address) return null;
  const wanted = address.toLowerCase();
  return (
    streamers.find((p) => p.public_key?.toLowerCase() === wanted) ?? null
  );
}

function toBigInt(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
