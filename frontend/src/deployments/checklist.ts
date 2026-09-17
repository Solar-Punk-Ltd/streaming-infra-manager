import {
  beePublishersProblem,
  type ChequebookHealth,
  chequebookStateReason,
  isStampExpiringSoon,
  parseBeePublishers,
  plurToBzz,
  type ReadFailure,
  type ReadFailureReason,
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
  /**
   * What this deployment's own Bee node holds.
   *
   * `undefined` where the view never asked, which is every list and the
   * overview, because a row would have to ask each node in turn. `null` where
   * a page did ask and the node has not answered yet. Those are two different
   * things to tell an operator, and calling the first one unchecked says
   * nobody looked when nobody was ever going to.
   */
  wallet: BeeWallet | null | undefined;
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
    action: observed.state === 'ready' ? undefined : RETRY_NODE_CHECKS };
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

const RETRY_NODE_CHECKS: StepAction = {
  label: 'Retry node checks',
  kind: 'refresh-node',
};

/**
 * What a reading that is missing says instead of "not checked".
 *
 * The four are the node's answer, not the page's guess, and they send an
 * operator to four different places: wait, go and look at the node, read its
 * logs, or report what it said back. "Not checked" sends them nowhere, which
 * is what a node answering in under a millisecond looked like on this page.
 */
const READ_FAILURE_PROBLEM: Record<ReadFailureReason, string> = {
  timeout: 'Node did not answer in time',
  unreachable: 'Node did not answer',
  refused: 'Node refused the check',
  malformed: 'Answer could not be read',
};

/** How long the node had, in a form a sentence can carry. */
function secondsOf(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)} seconds`;
}

function readFailureDetail(what: string, failure: ReadFailure): string {
  const took = secondsOf(failure.elapsedMs);
  switch (failure.reason) {
    case 'timeout':
      return `The node did not answer the ${what} within ${took}.`;
    case 'unreachable':
      return `Nothing answered at the node's API for the ${what}, after ${took}.`;
    case 'refused':
      return `The node refused the ${what} after ${took}.`;
    case 'malformed':
      return `The node answered the ${what} in ${took} with something this manager could not read.`;
  }
}

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

  if (wallet === undefined) return fundingFromChequebookAlone(chequebook, action);

  if (!wallet) {
    return {
      title: FUNDING_TITLE,
      problem: 'Funding not checked',
      state: isRunning(profile) ? 'warn' : 'off',
      detail: isRunning(profile)
        ? 'Waiting for the node to report its balances.'
        : 'Start the deployment to read its balances.',
      action: RETRY_NODE_CHECKS,
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

  const shortfall = chequebookShortfallStep(chequebook);
  if (shortfall) return shortfall;

  if (!chequebook || chequebook.state === 'unknown') {
    const failure = chequebook?.failure;
    if (failure) return chequebookFailureStep(failure);
    return {
      title: FUNDING_TITLE,
      problem: 'Funding not checked',
      state: 'warn',
      detail:
        'The node has not confirmed its chequebook balance. Retry the node checks before starting an uploader.',
      action: RETRY_NODE_CHECKS,
    };
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

const WAITING_FOR_CHEQUEBOOK =
  'Waiting for this node to answer with its chequebook balance. The wallet balances are read on the deployment page.';

/**
 * Funding as a view that never asked for the wallet can judge it.
 *
 * The chequebook is the one reading these views do take, so it answers on its
 * own: what it reports short is the node's own report, a read that failed is
 * the failure's own words, and no reading yet is this view still waiting
 * rather than anything an operator can act on.
 */
function fundingFromChequebookAlone(
  chequebook: ChequebookHealth | null,
  action: StepAction | undefined,
): ChecklistStep {
  const shortfall = chequebookShortfallStep(chequebook);
  if (shortfall) return shortfall;

  const failure = chequebook?.failure;
  if (failure) return chequebookFailureStep(failure);

  const note = chequebookNote(chequebook);
  if (!note) {
    return {
      title: FUNDING_TITLE,
      problem: 'Reading balances',
      state: 'busy',
      detail: WAITING_FOR_CHEQUEBOOK,
    };
  }

  return { title: FUNDING_TITLE, state: 'ok', detail: note, action };
}

/** What the node itself reported short, whoever took the reading. */
function chequebookShortfallStep(
  chequebook: ChequebookHealth | null,
): ChecklistStep | null {
  const shortfall = chequebook ? chequebookStateReason(chequebook) : null;
  if (!chequebook || !shortfall) return null;
  return {
    title: FUNDING_TITLE,
    problem: chequebook.state === 'empty' ? 'Chequebook empty' : 'Chequebook low',
    state: chequebook.state === 'empty' ? 'err' : 'warn',
    detail: shortfall,
    action: FILL_CHEQUEBOOK,
  };
}

function chequebookFailureStep(failure: ReadFailure): ChecklistStep {
  return {
    title: FUNDING_TITLE,
    problem: READ_FAILURE_PROBLEM[failure.reason],
    state: 'warn',
    detail: `${readFailureDetail('chequebook read', failure)} Retry the node checks before starting an uploader.`,
    action: RETRY_NODE_CHECKS,
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
  const affordable = stampAffordable(wallet);
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
        state: affordable && isRunning(profile) ? 'warn' : 'off',
        detail:
          'A stamp is prepaid Swarm storage. Buy one below once the node has BZZ.',
        action: buy('Buy stamp', affordable && isRunning(profile)),
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
    case 'unknown': {
      const failure = stampHealth.failure;
      const batch = shortHex(profile.stamp_id ?? '');
      return {
        title,
        problem: failure
          ? READ_FAILURE_PROBLEM[failure.reason]
          : 'Stamp not checked',
        action: RETRY_NODE_CHECKS,
        state: isRunning(profile) ? 'warn' : 'off',
        detail: failure
          ? `${readFailureDetail('stamp check', failure)} The batch recorded here (${batch}) is neither confirmed nor ruled out.`
          : `A batch is recorded (${batch}) but its node could not be asked whether it still pays.`,
      };
    }
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

/**
 * Whether buying a stamp is worth offering, as far as this view looked.
 *
 * A wallet nobody read says nothing about its BZZ, so it rules nothing out.
 * Reading that silence as an empty wallet leaves a list unable to say that a
 * running node has no stamp, which is a state the manager knows on its own.
 */
function stampAffordable(wallet: BeeWallet | null | undefined): boolean {
  if (wallet === undefined) return true;
  return wallet !== null && toBigInt(wallet.bzzBalance) > 0n;
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
