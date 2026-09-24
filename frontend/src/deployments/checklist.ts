import {
  beePublishersProblem,
  type ChequebookHealth,
  chequebookStateReason,
  effectiveNodeMode,
  formatFillPercent,
  isFullestBucketFull,
  isStampExpiringSoon,
  isStampNearlyFull,
  LIGHT_NODE_MODE,
  parseBeePublishers,
  plurToBzz,
  type ReadFailure,
  type ReadFailureReason,
  stampBucketCapacity,
  type StampHealth,
  STREAM_UPLOADER_SERVICE,
  type UploaderHealthReading,
  type UploaderHealthState,
  type UploaderStartGateWarning,
  ownsBeeNode,
  usesNodePool,
} from '@streaming-infra-manager/common';

import { canDeployUploader } from '../data';
import {
  BZZ_DECIMALS,
  formatDateTime,
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
  /**
   * What the deployment's own stream-uploader says about itself.
   *
   * `undefined` where the view never asked, which is every list and the
   * overview, because a row would have to ask each uploader in turn. The step
   * then reads exactly as it did before D16: the container is running and
   * nothing beyond that has been verified.
   */
  uploaderHealth?: UploaderHealthReading;
}

export function buildChecklist(input: ChecklistInput): ChecklistStep[] {
  const { profile } = input;
  const shape = shapeOf(profile);
  const steps: ChecklistStep[] = [containersStep(profile)];

  if (ownsBeeNode(profile)) {
    if (input.nodeReadiness) steps.push(nodeStep(input.nodeReadiness));
    // An ultra-light node has no chequebook and buys no postage, so these two
    // would chase it for what it cannot hold. Read through the shared
    // `effectiveNodeMode`, so a deployment that stores no mode reads exactly as
    // the stack starts it, which for a node that publishes is light.
    if (effectiveNodeMode(profile) === LIGHT_NODE_MODE) {
      steps.push(fundingStep(input));
      steps.push(stampStep(input));
    }
  }
  if (shape === 'abr-uploader') {
    steps.push(poolStep(profile));
    steps.push(uploaderStep(input));
  } else if (isStreamLike(profile, shape)) {
    steps.push(uploaderStep(input));
  }
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

  // The unsettled state is asked about here rather than inferred from a missing
  // balance, so this rule does not turn on an invariant kept in another package.
  const note =
    chequebook && chequebook.state !== 'unknown'
      ? chequebookNote(chequebook)
      : null;
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
      if (!failure && wallet === undefined) {
        return {
          title,
          problem: 'Stamp not checked',
          state: isRunning(profile) ? 'busy' : 'off',
          detail: `A batch is recorded (${batch}). This view has no reading of it, and the node is asked for one when the deployment is opened.`,
        };
      }
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
    case 'full':
      return {
        title,
        problem: STAMP_FULL,
        state: 'err',
        detail: fullStampDetail(stampHealth, currentStamp),
        action: buy('Buy stamp', true),
      };
    case 'active': {
      const nearlyFull = isStampNearlyFull(stampHealth.fillRatio, stampHealth.immutable);
      const endsSoon = isStampExpiringSoon(stampHealth.ttl);
      const detail = activeStampDetail(profile, stampHealth, currentStamp);
      return {
        title,
        problem: nearlyFull ? STAMP_NEARLY_FULL : 'Stamp ends soon',
        state: nearlyFull || endsSoon ? 'warn' : 'ok',
        detail: nearlyFull ? `${detail}. ${NEARLY_FULL_CONSEQUENCE}` : detail,
        action: nearlyFull || endsSoon ? buy('Buy next stamp') : undefined,
      };
    }
  }
}

/** The step's problem for an immutable batch whose fullest bucket is full. */
export const STAMP_FULL = 'Stamp full';
/** The step's problem for an immutable batch past the uploader's start ceiling. */
export const STAMP_NEARLY_FULL = 'Stamp nearly full';

const NEARLY_FULL_CONSEQUENCE =
  'Past 90% an uploader restarted on it refuses to start, and once it fills its node refuses uploads.';

/**
 * How full the fullest bucket is, in chunks where the page holds the batch
 * itself and as a share where it holds only the reading.
 */
function fullestBucketText(health: StampHealth, stamp: BeeStamp | null): string | null {
  const capacity = stamp ? stampBucketCapacity(stamp) : null;
  if (stamp && capacity !== null) {
    return `${stamp.utilization} of ${capacity} chunks in its fullest bucket`;
  }
  if (health.fillRatio === null) return null;
  return `its fullest bucket ${formatFillPercent(health.fillRatio)} full`;
}

function fullStampDetail(health: StampHealth, stamp: BeeStamp | null): string {
  const amount = fullestBucketText(health, stamp);
  const howFull = amount ? `, ${amount}` : '';
  if (health.immutable === null) {
    return `Full${howFull}, and the node did not say whether it is immutable. An immutable batch this full refuses uploads until a new stamp is bought and set.`;
  }
  return `Immutable and full${howFull}. The node refuses uploads until a new stamp is bought and set.`;
}

/**
 * The fill and the kind of a batch that still takes uploads, as parts of the
 * step's detail. A mutable batch that has filled keeps taking them, which is
 * worth saying because it is spending what earlier uploads stored.
 */
function fillParts(health: StampHealth): string[] {
  const { fillRatio, immutable } = health;
  if (immutable === false && isFullestBucketFull(fillRatio)) {
    return ['mutable and full, so it now overwrites its oldest chunks rather than refusing uploads'];
  }
  const parts: string[] = [];
  if (fillRatio !== null) parts.push(`${formatFillPercent(fillRatio)} full`);
  if (immutable !== null) parts.push(immutable ? 'immutable' : 'mutable');
  return parts;
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
  const parts = [`${formatTtl(health.ttl)} left`, ...fillParts(health)];
  if (profile.stamp_id) parts.push(`batch ${shortHex(profile.stamp_id)}`);
  if (stamp) parts.push(`depth ${stamp.depth}`);
  return parts.join(' · ');
}

const UPLOADER_TITLE = 'Uploader running';

/** What a running container proves on its own, which is less than it reads as. */
const UPLOADER_UNVERIFIED =
  'The uploader container is reported running. Receiving and uploading have not been verified.';

/**
 * The gates as an operator names them rather than as the uploader's classes are
 * called. An unrecognised gate keeps its own name, which is better than a
 * guessed translation of one this page has never seen.
 */
const GATE_WORDS: Record<string, string> = {
  ChequebookGate: 'the chequebook gate',
  PostageGate: 'the postage gate',
};

function uploaderStep(input: ChecklistInput): ChecklistStep {
  const { profile, stampHealth, uploaderHealth } = input;
  const title = UPLOADER_TITLE;
  const deployed = profile.containers.some(
    (c) => c.service === STREAM_UPLOADER_SERVICE,
  );
  if (deployed && uploaderHealth?.state !== 'not_deployed') {
    return runningUploaderStep(uploaderHealth, profile);
  }

  // The manager asks the node again before it changes containers. A node that
  // says nothing and any chequebook balance are warning states under D15 and
  // D16, so neither can hide the action. A stamp the node already reported as
  // missing, expired or not usable is the evidence that still blocks it.
  const poolBacked = shapeOf(profile) === 'abr-uploader';
  const prerequisiteReady = poolBacked
    ? !beePublishersProblem(profile.bee_publishers)
    : stampHealth.state === 'active' || stampHealth.state === 'unknown';
  const ready =
    isRunning(profile) &&
    canDeployUploader(profile) &&
    prerequisiteReady;
  return {
    title,
    problem: 'Uploader not started',
    state: ready ? 'warn' : 'off',
    detail: ready
      ? poolBacked
        ? 'The node pool is configured. Start the uploader to complete the stack.'
        : stampHealth.state === 'active'
        ? 'Stamp is set. Start the uploader to complete the stack.'
        : 'A stamp is recorded. Start rechecks it. A node that does not answer may leave the uploader waiting, while a stamp the node reports unusable is refused.'
      : 'Start is held until the earlier readiness checks pass. Existing containers are left running.',
    action: ready
      ? { label: 'Start uploader', kind: 'deploy-uploader', primary: true }
      : undefined,
  };
}

/** The uploader step's problems, which the overview names as well. */
export const UPLOADER_WAITING_FOR_NODE = 'Uploader waiting for its node';
export const UPLOADER_WARNED = 'Uploader started with a warning';
export const UPLOADER_REPORTS_A_PROBLEM = 'Uploader reports a problem';
export const UPLOADER_NOT_ANSWERING = 'Uploader not answering';

/**
 * What each reading makes of a running uploader's step.
 *
 * A wait and an unanswered health route are warnings rather than a wait and a
 * pass since 2026-09-25: the uploader is up and uploading nothing, or nothing
 * confirmed that it uploads, and the overview lists exactly what this step does
 * not call ok. A reading of `not_deployed` beside a container the page lists is
 * the two lists racing a deploy, and stays the container's own claim.
 */
const RUNNING_UPLOADER_STEPS: Record<UploaderHealthState, { state: StepState; problem?: string }> = {
  waiting_for_node: { state: 'warn', problem: UPLOADER_WAITING_FOR_NODE },
  warned: { state: 'warn', problem: UPLOADER_WARNED },
  unhealthy: { state: 'err', problem: UPLOADER_REPORTS_A_PROBLEM },
  unreachable: { state: 'warn', problem: UPLOADER_NOT_ANSWERING },
  ok: { state: 'ok' },
  not_deployed: { state: 'ok' },
};

/**
 * The uploader's own account of itself, for a view that asked.
 *
 * Since D16 a started uploader may be waiting for a Bee node that is not
 * answering, or running on a startup gate that warned instead of refusing.
 * Both are states nothing on the container says, which is why they are read
 * from the uploader rather than inferred here.
 */
function runningUploaderStep(
  health: UploaderHealthReading | undefined,
  profile: Profile,
): ChecklistStep {
  const title = UPLOADER_TITLE;
  if (!health) return { title, state: 'ok', detail: UPLOADER_UNVERIFIED };

  const { state, problem } = RUNNING_UPLOADER_STEPS[health.state];
  return {
    title,
    state,
    ...(problem ? { problem } : {}),
    detail: uploaderHealthDetail(health, profile),
  };
}

/**
 * What an uploader's own reading says, in the words its readiness step uses, so
 * a list that names the reading says the same thing as the deployment's page.
 */
export function uploaderHealthDetail(
  health: UploaderHealthReading,
  profile: Profile,
): string {
  switch (health.state) {
    case 'waiting_for_node':
      return waitingDetail(health);
    case 'warned':
      return `${warningsText(health.startGateWarnings ?? [])} The uploader started anyway, and its own logs name the node.`;
    case 'unhealthy':
      return `${reasonsText(health.reasons, usesNodePool(profile))} Its own logs have the rest.`;
    case 'ok':
      return 'The uploader reports healthy.';
    case 'unreachable':
    case 'not_deployed':
      return `${UPLOADER_UNVERIFIED} Its health route did not answer.`;
  }
}

function waitingDetail(health: UploaderHealthReading): string {
  const node = health.node;
  const where = node ? ` at ${node.url}` : '';
  const since = health.waitingSince
    ? ` since ${formatDateTime(health.waitingSince)}`
    : '';
  // Absent until an attempt has failed, which a wait reports before it has made
  // one, so this says why the node is being waited for rather than only that it is.
  const why = node?.lastError ? `, last error: ${node.lastError}` : '';
  const tries = node
    ? ` ${node.attempts === 1 ? '1 attempt' : `${node.attempts} attempts`} so far${why}.`
    : '';
  return `Waiting for its Bee node${where}${since}.${tries} It keeps trying and finishes starting when the node answers.`;
}

function warningsText(warnings: readonly UploaderStartGateWarning[]): string {
  if (warnings.length === 0) return 'A startup gate warned.';
  const spelled = warnings.map((warning) => {
    const gate = GATE_WORDS[warning.gate] ?? warning.gate;
    return warning.rung ? `${gate} warned on the ${warning.rung} rung` : `${gate} warned`;
  });
  return `${capitalised(andList(spelled))}.`;
}

/**
 * The uploader's reason codes as words. Written out rather than translated
 * through a table, so a reason a newer stack reports still reaches the page
 * instead of being dropped by a lookup that has never heard of it. A reason
 * whose code does not say what an operator is looking at gets its meaning after.
 */
function reasonsText(reasons: readonly string[], publishesToPool: boolean): string {
  if (reasons.length === 0) return 'The uploader reports a problem it did not name.';
  const named = `The uploader reports ${andList(reasons.map((reason) => reason.replace(/_/g, ' ')))}.`;
  const meanings = reasons.flatMap((reason) => {
    const meaning = reasonMeaning(reason, publishesToPool);
    return meaning ? [meaning] : [];
  });
  return [named, ...meanings].join(' ');
}

/** The uploader's reason for bee refusing a paid write on a batch that nothing retries. */
const POSTAGE_REFUSED_REASON = 'postage_refused';

/**
 * The uploader reads the batch each node spends once, when it starts, and keeps
 * this reason for the life of the process, so only a deploy carrying a batch
 * that pays clears either the failures or the reason.
 */
function reasonMeaning(reason: string, publishesToPool: boolean): string | null {
  if (reason !== POSTAGE_REFUSED_REASON) return null;
  return publishesToPool
    ? 'Postage refused means a rung’s Bee node refused that rung’s postage batch, which is full or has expired, so that rung’s uploads fail until the uploader is deployed again with a batch that pays.'
    : 'Postage refused means its Bee node refused its postage batch, which is full or has expired, so its uploads fail until the uploader is deployed again with a batch that pays.';
}

function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
