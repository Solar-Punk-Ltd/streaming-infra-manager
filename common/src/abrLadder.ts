import { BEE_UPLOADER_SERVICE } from './constants.js';
import {
  isInvalidUrlState,
  type PublishUrlState,
  publishUrlReason,
  publishUrlWarning,
} from './publishUrl.js';
import {
  isStampExpiringSoon,
  type StampState,
  stampStateReason,
} from './stampHealth.js';

/**
 * An ABR ladder is a deployment **group** whose members are ordinary
 * bee-uploader profiles — one Bee node per quality rung — used as the publish
 * targets for a stream-uploader running elsewhere.
 *
 * Nothing about it is a new kind of deployment. A rung is a normal profile with a
 * normal slot, its own data dir and its own `stamp_id`, deployed by the
 * `bee-uploader` service that already exists. That is the point: the streaming
 * repo needs to know nothing about ladders, and every per-node operation the
 * manager already supports — fund, buy a batch, stop, remove — works unchanged.
 *
 * The ladder exists in two places only: the member *names*, which carry the rung,
 * and the BEE_PUBLISHERS string assembled from them.
 *
 * Why one node per rung: postage batches drain in proportion to bitrate. Across
 * the shipped ladder 1080p burns roughly seven times the bytes of 360p, so batches
 * of equal depth expire hours apart. A node per rung turns a batch running out
 * into one rung going quiet and ABR stepping down, rather than the whole stage
 * stopping. Each node also brings its own chequebook and its own crash domain.
 */

/**
 * What a deployment group is for.
 *
 * `abr-ladder` is recorded on the group rather than inferred from its members'
 * names: a ladder with a rung removed still *is* a ladder — one that needs
 * fixing — and inferring it would make the group quietly stop being one at
 * exactly the moment that matters.
 */
export const STANDARD_GROUP_KIND = 'standard';
export const ABR_LADDER_GROUP_KIND = 'abr-ladder';
export const GROUP_KINDS = [STANDARD_GROUP_KIND, ABR_LADDER_GROUP_KIND] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export function isLadderKind(kind: string | null | undefined): boolean {
  return kind === ABR_LADDER_GROUP_KIND;
}

/** One rung of the shipped ladder. Ascending quality. */
export interface AbrRung {
  name: string;
  width: number;
  height: number;
  /** Encoder target, kbps. Batch sizing depends on it — see suggestedRungDepth. */
  kbps: number;
}

/**
 * The shipped ABR ladder — the same rungs, geometry and target bitrates as the
 * engine's default `ABR_LADDER`, in the order `AbrLadder.rungs()` returns and
 * `BeePublisherPool.perRung` expects.
 *
 * Index 0 is the lowest rung, which is also the pool's coordinator: the stream
 * catalog and each ladder's master playlist go through it, because it has the
 * longest-lived batch and those two feeds are the only addresses a viewer needs
 * to open a stage.
 */
export const DEFAULT_ABR_LADDER: readonly AbrRung[] = [
  { name: '360p', width: 640, height: 360, kbps: 700 },
  { name: '480p', width: 854, height: 480, kbps: 1200 },
  { name: '720p', width: 1280, height: 720, kbps: 2800 },
  { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
];

export const DEFAULT_ABR_RUNGS: readonly string[] = DEFAULT_ABR_LADDER.map(
  (rung) => rung.name,
);

export const ABR_LADDER_SIZE = DEFAULT_ABR_LADDER.length;

/** The single service every rung member deploys. */
export const ABR_RUNG_COMPONENTS: readonly string[] = [BEE_UPLOADER_SERVICE];

/** Bee's minimum purchasable batch depth — the floor the ladder scales from. */
export const MIN_STAMP_DEPTH = 17;

/**
 * The one status a rung can be published to.
 *
 * Held here rather than imported from the manager's status enum, which `common`
 * does not depend on. A stopped rung's node answers nothing, so its address in
 * BEE_PUBLISHERS is a promise the ladder cannot keep — and the Uploaders tab, which
 * is about batches, showed no status at all, so a stopped rung looked identical to
 * a running one.
 */
export const PUBLISHABLE_RUNG_STATUS = 'RUNNING';

// Profile names are capped at 31 characters (see PROFILE_NAME_RE). A member name
// is `<group>-<rung>`, and the longest rung is `1080p`, so a ladder's group name
// has less room than an ordinary one. Enforced at the edge rather than discovered
// as a check-constraint violation halfway through creating the group.
const PROFILE_NAME_MAX = 31;
const LONGEST_RUNG = DEFAULT_ABR_RUNGS.reduce(
  (longest, rung) => Math.max(longest, rung.length),
  0,
);
export const LADDER_GROUP_NAME_MAX = PROFILE_NAME_MAX - LONGEST_RUNG - 1;

/**
 * The member name for a rung.
 *
 * The rung lives in the name, not in a column and not in the member's position,
 * because position is not stable: remove one member and re-add it and every rung
 * below it would silently re-map, so a batch sized for 360p would end up paying
 * for 1080p. A name is stable, unique, already validated, and legible in the
 * deployments table.
 */
export function ladderMemberName(groupName: string, rungName: string): string {
  return `${groupName}-${rungName}`;
}

/** Every member name of a ladder, ascending. */
export function ladderMemberNames(groupName: string): string[] {
  return DEFAULT_ABR_RUNGS.map((rung) => ladderMemberName(groupName, rung));
}

/**
 * The rung a member publishes, or null if the name is not a rung of this group.
 *
 * Always stripped against the *known* group name, so `abr` / `abr-1080p` and
 * `abr-1` / `abr-1-360p` cannot be confused for one another.
 */
export function rungFromMemberName(
  groupName: string,
  memberName: string,
): string | null {
  const prefix = `${groupName}-`;
  if (!memberName.startsWith(prefix)) return null;
  const rung = memberName.slice(prefix.length);
  return DEFAULT_ABR_RUNGS.includes(rung) ? rung : null;
}

/** Ascending ladder index of a rung, or -1. Used to order members. */
export function rungOrder(rungName: string): number {
  return DEFAULT_ABR_RUNGS.indexOf(rungName);
}

/**
 * Whether a group's members form a complete ladder.
 *
 * Derived from the member names rather than recorded on the group row: it needs
 * no schema, and it cannot go stale — a group that stops looking like a ladder
 * (a rung removed) stops being treated as one, which is the honest answer.
 */
export function isLadderGroup(
  groupName: string,
  memberNames: readonly string[],
): boolean {
  const rungs = new Set(
    memberNames
      .map((name) => rungFromMemberName(groupName, name))
      .filter((rung): rung is string => rung !== null),
  );
  return DEFAULT_ABR_RUNGS.every((rung) => rungs.has(rung));
}

/** True when any member carries a rung name — a ladder, complete or not. */
export function looksLikeLadderGroup(
  groupName: string,
  memberNames: readonly string[],
): boolean {
  return memberNames.some(
    (name) => rungFromMemberName(groupName, name) !== null,
  );
}

/**
 * Depth to suggest for a rung's batch, given the depth chosen for the lowest rung.
 *
 * A batch of depth d holds 2^d chunks, and a rung fills its batch in proportion to
 * its bitrate — so equal depths across the ladder means the top rung's batch fills
 * roughly seven times faster than the bottom one's and the four expire hours
 * apart. That staggering is the whole problem one-node-per-rung exists to contain,
 * and handing every rung the same default would walk straight back into it.
 *
 * Each doubling of bitrate wants one more depth, hence log2 of the ratio to the
 * lowest rung: on a base of 17 the shipped ladder suggests 17 / 18 / 19 / 20.
 */
export function suggestedRungDepth(
  rungName: string,
  baseDepth: number = MIN_STAMP_DEPTH,
): number {
  const lowest = DEFAULT_ABR_LADDER[0]!;
  const rung = DEFAULT_ABR_LADDER.find((entry) => entry.name === rungName);
  if (!rung || lowest.kbps <= 0) return baseDepth;
  const steps = Math.round(Math.log2(rung.kbps / lowest.kbps));
  return Math.max(MIN_STAMP_DEPTH, baseDepth + Math.max(0, steps));
}

/**
 * One `rung@url<batch>` entry of the uploader's BEE_PUBLISHERS.
 *
 * The batch is bracketed rather than introduced by `#` because `#` opens a
 * comment in a `.env` file: an unquoted value would be truncated at the first one
 * and the batch ids silently lost.
 */
export function beePublisherEntry(
  rungName: string,
  url: string,
  batchId: string,
): string {
  return `${rungName}@${url}<${batchId.replace(/^0x/, '')}>`;
}

/** One rung of a ladder, reduced to what BEE_PUBLISHERS needs. */
export interface LadderRungState {
  rung: string;
  /** Profile name of the member publishing this rung. */
  name: string;
  status: string;
  /** Reachable from the uploader. */
  url: string;
  stampId: string | null;
  /**
   * What the rung's bee node says about that batch, when it was asked.
   *
   * A recorded id is not a working batch — batches expire on their own and
   * nothing writes that back. `'unknown'` (or absent) means unverified, which
   * deliberately does not block: a node being unreachable is not evidence that
   * its batch is dead.
   */
  stampState?: StampState;
  /** Seconds left on that batch, when the node said. Drives the expiry warning. */
  stampTtl?: number | null;
  /**
   * What `url` above is worth. Composed arithmetically, so it always parses as a
   * URL; `'unknown'` (or absent) means nothing has checked it.
   */
  urlState?: PublishUrlState;
}

/** A rung and what is wrong, or worth checking, about it. */
export interface RungNote {
  rung: string;
  reason: string;
}

export interface BeePublishersResult {
  ready: boolean;
  /** The paste-ready value, or null while a rung is missing or unstamped. */
  value: string | null;
  /** Every rung found, ascending. */
  rungs: LadderRungState[];
  /** Why the value is withheld. Empty when ready. */
  missing: RungNote[];
  /**
   * Ready, but worth a look: a batch nobody could verify, an address nothing
   * answered at, a batch about to run out. Never a reason to withhold the value —
   * only reasons to check before trusting it.
   *
   * Reported only for rungs that are not already in `missing`: a rung we have
   * refused does not need a second, softer complaint as well.
   */
  warnings: RungNote[];
}

/**
 * Build BEE_PUBLISHERS from a ladder's rungs.
 *
 * Pure, and separate from fetching them, so the ordering and the readiness rules
 * can be tested without a database. Rungs are emitted in ascending ladder order
 * regardless of the order supplied — `BeePublisherPool.perRung` sorts by ladder
 * anyway, but the string is also read by humans, and lowest-first matches how the
 * ladder is described everywhere else.
 *
 * Emitted only when every rung has a batch the node will still honour: the
 * uploader refuses a ladder with a rung missing, so a partial string would fail
 * later and less clearly than naming the rung that is not ready — and a string
 * built from expired batches is worse still, since it looks complete and fails
 * on every upload.
 */
export function assembleBeePublishers(
  supplied: readonly LadderRungState[],
): BeePublishersResult {
  const rungs = [...supplied].sort(
    (a, b) => rungOrder(a.rung) - rungOrder(b.rung),
  );

  const missing: RungNote[] = [];
  const warnings: RungNote[] = [];

  for (const rung of DEFAULT_ABR_RUNGS) {
    const found = rungs.find((entry) => entry.rung === rung);
    if (!found) {
      missing.push({ rung, reason: 'no member deployed for this rung' });
      continue;
    }

    const blocker = blockingReason(found);
    if (blocker) {
      missing.push({ rung, reason: blocker });
      continue;
    }

    for (const reason of softReasons(found)) warnings.push({ rung, reason });
  }

  const ready = missing.length === 0;
  return {
    ready,
    value: ready
      ? beePublishersValue(
          rungs.map((entry) => ({
            rungName: entry.rung,
            url: entry.url,
            batchId: entry.stampId!,
          })),
        )
      : null,
    rungs,
    missing,
    warnings,
  };
}

/**
 * The first thing that makes a rung unpublishable, or null.
 *
 * Ordered by what the operator has to fix first: a stopped node makes the batch
 * question moot, and an address that cannot be reached makes both moot.
 */
function blockingReason(rung: LadderRungState): string | null {
  if (rung.status !== PUBLISHABLE_RUNG_STATUS) {
    return `this rung is ${rung.status.toLowerCase()}, not running — deploy it before pointing an uploader at it`;
  }
  if (isInvalidUrlState(rung.urlState)) {
    return publishUrlReason(rung.urlState!);
  }
  if (!rung.stampId) return stampStateReason('none');
  return stampStateReason(rung.stampState ?? 'unknown');
}

/** Everything about a publishable rung that is still worth saying. */
function softReasons(rung: LadderRungState): string[] {
  const reasons: string[] = [];

  const urlWarning = publishUrlWarning(rung.urlState ?? 'unknown');
  if (urlWarning) reasons.push(urlWarning);

  if ((rung.stampState ?? 'unknown') === 'unknown') {
    reasons.push(
      'this rung’s bee node could not be reached, so its batch was not checked — an expired batch would look exactly like this',
    );
  }

  if (isStampExpiringSoon(rung.stampTtl)) {
    reasons.push(
      `this rung’s batch runs out in ${formatShortTtl(rung.stampTtl!)} — top it up or buy the next one before it does`,
    );
  }

  return reasons;
}

/** Coarse, human TTL for a warning line: hours below a day, else days. */
function formatShortTtl(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** Space-separated BEE_PUBLISHERS value, in the order given. */
export function beePublishersValue(
  entries: readonly { rungName: string; url: string; batchId: string }[],
): string {
  return entries
    .map((entry) => beePublisherEntry(entry.rungName, entry.url, entry.batchId))
    .join(' ');
}
