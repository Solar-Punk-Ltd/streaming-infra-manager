import {
  beePublishersProblem,
  type ChequebookHealth,
  chequebookStateReason,
  isStampExpiringSoon,
  parseBeePublishers,
  plurToBzz,
  type StampHealth,
  STREAM_UPLOADER_SERVICE,
  ownsBeeNode,
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
import type { BeeReadinessView } from '../uploaders/beeReadiness';
import type { BeeStamp, BeeWallet } from '../uploaders/stampApi';
import { isStreamLike, statusLabelOf } from './shape';
import { deploymentProgressText } from './deploymentPhase';
import { hasService, isRunning, isTransitional, shapeOf } from './shape';

export type StepState = 'ok' | 'warn' | 'err' | 'busy' | 'off';

export type StepActionKind =
  | 'start'
  | 'copy-address'
  | 'buy-stamp'
  | 'fill-chequebook'
  | 'deploy-uploader'
  | 'edit'
  | 'open-stream'
  | 'refresh-node';

export interface StepAction {
  label: string;
  kind: StepActionKind;
  /** The value a copy action puts on the clipboard, or the stream to open. */
  value?: string;
  primary?: boolean;
}

export interface ChecklistStep {
  title: string;
  problem?: string;
  state: StepState;
  detail: string;
  action?: StepAction;
}

export interface ChecklistInput {
  profile: Profile;
  nodeReadiness?: BeeReadinessView;
  /** What this deployment's own Bee node holds, when the page asked it. */
  wallet: BeeWallet | null;
  /** What the same node can still pay peers with, null when it did not say. */
  chequebook: ChequebookHealth | null;
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

  if (ownsBeeNode(profile)) {
    if (input.nodeReadiness) steps.push(nodeStep(input.nodeReadiness));
    steps.push(fundingStep(input));
    steps.push(stampStep(input));
  }
  if (isStreamLike(profile, shape)) steps.push(uploaderStep(input));
  if (shape === 'abr-uploader') steps.push(poolStep(profile));
  if (shape === 'viewer' || hasService(profile, 'client')) {
    steps.push(followingStep(input));
  }

  const first = firstBlocker(steps);
  return steps.map((step) => ({
    ...step,
    action: step.action ? { ...step.action, primary: step === first } : undefined,
  }));
}

export function firstBlocker(steps: readonly ChecklistStep[]): ChecklistStep | null {
  return steps.find((step) => step.state !== 'ok') ?? null;
}

function nodeStep(observed: BeeReadinessView): ChecklistStep {
  return { title: 'Bee API observation', problem: observed.label,
    state: observed.state === 'ready' ? 'ok' : observed.state === 'unhealthy' ? 'err' : observed.state === 'initializing' ? 'busy' : 'warn',
    detail: observed.detail,
    action: observed.state === 'ready' ? undefined : { label: 'Retry node checks', kind: 'refresh-node' } };
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
      : deploymentProgressText(profile);

  const canAct = !isRunning(profile) && !isTransitional(profile);
  return {
    title: 'Containers running',
    problem: profile.status === 'ERROR' ? 'Last deployment failed' : profile.status === 'DEPLOYING' ? statusLabelOf(profile).label : profile.status === 'STOPPING' ? 'Stopping' : profile.status === 'REMOVING' ? 'Removing' : 'Stopped',
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

const FUNDING_TITLE = 'Bee node funded';

const FILL_CHEQUEBOOK: StepAction = {
  label: 'Fill chequebook',
  kind: 'fill-chequebook',
  primary: true,
};

/**
 * Whether this node can pay for its uploads at all, which takes two pots: the
 * wallet, which buys stamps and refills the chequebook, and the chequebook,
 * which pays the peers that forward what is uploaded.
 *
 * The wallet comes first when both are short. Filling a chequebook spends
 * wallet BZZ, so "fill the chequebook" is not a thing an unfunded node can
 * act on.
 */
function fundingStep({
  profile,
  wallet,
  chequebook,
  nodeAddress,
}: ChecklistInput): ChecklistStep {
  const action: StepAction | undefined = nodeAddress
    ? { label: 'Copy node address', kind: 'copy-address', value: nodeAddress }
    : undefined;

  if (!wallet) {
    return {
      title: FUNDING_TITLE,
      problem: 'Funding not checked',
      state: isRunning(profile) ? 'warn' : 'off',
      detail: isRunning(profile)
        ? 'Waiting for the node to report its balances.'
        : 'Start the deployment to read its balances.',
      action: { label: 'Retry node checks', kind: 'refresh-node' },
    };
  }

  const xdai = toBigInt(wallet.nativeTokenBalance);
  const bzz = toBigInt(wallet.bzzBalance);
  const xdaiText = formatTokenBalance(wallet.nativeTokenBalance, XDAI_DECIMALS);
  const bzzText = formatTokenBalance(wallet.bzzBalance, BZZ_DECIMALS);
  const funded = xdai > 0n && bzz > 0n;

  if (!funded) {
    return {
      title: FUNDING_TITLE,
      problem: 'Node needs funding',
      state: isRunning(profile) ? 'warn' : 'off',
      detail:
        bzz <= 0n && xdai > 0n
          ? `Has xDAI ${xdaiText} but no BZZ. Send BZZ to the node address to be able to buy a stamp.`
          : xdai <= 0n && bzz > 0n
            ? `Has BZZ ${bzzText} but no xDAI. Send xDAI to the node address to pay for the purchase.`
            : 'Send xDAI and BZZ to the node address.',
      action,
    };
  }

  if (chequebook) {
    const shortfall = chequebookStateReason(chequebook);
    if (shortfall) {
      return {
        title: FUNDING_TITLE,
        problem: chequebook.state === 'empty' ? 'Chequebook empty' : 'Chequebook low',
        state: chequebook.state === 'empty' ? 'err' : 'warn',
        detail: shortfall,
        action: FILL_CHEQUEBOOK,
      };
    }
  }

  if (!chequebook || chequebook.state === 'unknown') {
    return { title: FUNDING_TITLE, problem: 'Funding not checked', state: 'warn',
      detail: 'The node has not confirmed its chequebook balance. Retry the node checks before starting an uploader.',
      action: { label: 'Retry node checks', kind: 'refresh-node' } };
  }

  return {
    title: FUNDING_TITLE,
    state: 'ok',
    detail: [
      `xDAI ${xdaiText} for gas`,
      `BZZ ${bzzText} for storage`,
      chequebookNote(chequebook),
    ]
      .filter((part) => part !== null)
      .join(' · '),
    action,
  };
}

/** Only a node that answered gets a line about its chequebook. */
function chequebookNote(chequebook: ChequebookHealth | null): string | null {
  if (chequebook?.availablePlur == null) return null;
  return `chequebook ${plurToBzz(chequebook.availablePlur)} BZZ available`;
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
        problem: 'Needs a stamp',
        state: funded && isRunning(profile) ? 'warn' : 'off',
        detail:
          'A stamp is prepaid Swarm storage. Buy one below once the node has BZZ.',
        action: buy('Buy stamp', funded && isRunning(profile)),
      };
    case 'expired':
    case 'gone':
      return {
        title,
        problem: stampHealth.state === 'expired' ? 'Stamp expired' : 'Stamp not on node',
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
        problem: 'Stamp settling',
        state: 'busy',
        detail:
          'Bought, waiting for the network to confirm it. It is set automatically.',
      };
    case 'unknown':
      return {
        title,
        problem: 'Stamp not checked',
        action: { label: 'Retry node checks', kind: 'refresh-node' },
        state: isRunning(profile) ? 'warn' : 'off',
        detail: `A batch is recorded (${shortHex(profile.stamp_id ?? '')}) but its node could not be asked whether it still pays.`,
      };
    case 'active':
      return {
        title,
        problem: 'Stamp ends soon',
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

function uploaderStep(input: ChecklistInput): ChecklistStep {
  const { profile, stampHealth } = input;
  const title = 'Uploader running';
  const deployed = profile.containers.some(
    (c) => c.service === STREAM_UPLOADER_SERVICE,
  );
  if (deployed) {
    return {
      title,
      state: 'ok',
      detail:
        'The uploader container is reported running. Receiving and uploading have not been verified.',
    };
  }

  const ready = isRunning(profile) && canDeployUploader(profile) && stampHealth.ok && fundingStep(input).state === 'ok' && (!input.nodeReadiness || input.nodeReadiness.state === 'ready');
  return {
    title,
    problem: 'Uploader not started',
    state: ready ? 'warn' : 'off',
    detail: ready
      ? 'Stamp is set. Start the uploader to complete the stack.'
      : 'Start is held until the earlier readiness checks pass. Existing containers are left running.',
    action: ready
      ? { label: 'Start uploader', kind: 'deploy-uploader', primary: true }
      : undefined,
  };
}

function poolStep(profile: Profile): ChecklistStep {
  const title = 'Node pool configured';
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
    detail: `${entries.length} rungs · ${host} and ${Math.max(0, entries.length - 1)} more. Reachability and publishing have not been verified.`,
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
