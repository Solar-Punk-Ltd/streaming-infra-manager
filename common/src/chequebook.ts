/**
 * A bee node's chequebook: the pot it pays forwarding peers from, and whether
 * it still has enough in it to be worth starting an uploader against.
 *
 * A drained chequebook looks like nothing at all. The node answers `/health`,
 * the uploader keeps taking segments, and every push stalls waiting for a
 * payment the node cannot make. So the floor, the conversions and the verdict
 * live here, shared: the manager's deploy gate, the frontend's pill and the
 * offline mock read one number and reach one answer, and cannot drift apart.
 */

/** BZZ is quoted in PLUR, its integer unit. 1 BZZ is 10^16 PLUR. */
export const PLUR_PER_BZZ = 10n ** 16n;

/** The floor a node has to hold before its uploader is worth starting. */
export const DEFAULT_CHEQUEBOOK_FLOOR_BZZ = '0.5';

const BZZ_FRACTION_DIGITS = 16;

/**
 * Fraction digits in a BZZ amount written into a sentence.
 *
 * The same four a balance is shown with, so a sentence sitting under a balance
 * and the balance itself never quote two different numbers for one reading.
 */
const MESSAGE_FRACTION_DIGITS = 4;

/** A plain decimal, so no exponent, no sign and no thousands separators. */
const DECIMAL_BZZ_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Far above the total supply of BZZ, and a bound on what gets turned into a
 * bigint. BigInt has no size limit, so a long enough digit string is a way to
 * make the process do arbitrary work on the way to a number nothing can hold.
 */
export const MAX_PLUR_DIGITS = 30;

const PLUR_RE = new RegExp(`^\\d{1,${MAX_PLUR_DIGITS}}$`);

/**
 * A BZZ amount an operator typed, as PLUR, or null when it is not one.
 *
 * Refuses zero as well as nonsense: every caller is moving money, and moving
 * none of it is a mistake rather than a no-op worth submitting to the chain.
 */
export function bzzToPlur(text: string): bigint | null {
  const trimmed = text.trim();
  if (!DECIMAL_BZZ_RE.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > BZZ_FRACTION_DIGITS) return null;

  const plur =
    BigInt(whole || '0') * PLUR_PER_BZZ +
    BigInt(fraction.padEnd(BZZ_FRACTION_DIGITS, '0'));
  return plur > 0n ? plur : null;
}

/**
 * PLUR as a BZZ amount for a sentence: always four decimals, truncated.
 *
 * Truncated rather than rounded, so a message can never claim a node holds more
 * than it does. Use `plurToBzzExact` where every digit matters, such as filling
 * in an amount field.
 */
export function plurToBzz(plur: bigint): string {
  const negative = plur < 0n;
  const magnitude = negative ? -plur : plur;
  const whole = magnitude / PLUR_PER_BZZ;
  const fraction = (magnitude % PLUR_PER_BZZ)
    .toString()
    .padStart(BZZ_FRACTION_DIGITS, '0')
    .slice(0, MESSAGE_FRACTION_DIGITS);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * PLUR as the BZZ amount it exactly is, for an amount field rather than a
 * sentence: every digit that matters and no trailing zeros.
 *
 * `bzzToPlur` reads this back as the same number, which is what "use all"
 * needs. Rounding here would leave dust behind on every move.
 */
export function plurToBzzExact(plur: bigint): string {
  const negative = plur < 0n;
  const magnitude = negative ? -plur : plur;
  const whole = magnitude / PLUR_PER_BZZ;
  const fraction = (magnitude % PLUR_PER_BZZ)
    .toString()
    .padStart(BZZ_FRACTION_DIGITS, '0')
    .replace(/0+$/, '');

  const sign = negative ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * A PLUR amount bee reported, or null when it did not report a usable one.
 */
export function parsePlur(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return PLUR_RE.test(trimmed) ? BigInt(trimmed) : null;
}

/**
 * What bee answers a submitted on-chain call with, before it is mined.
 *
 * Shared because it crosses the whole stack unchanged: bee hands it to the
 * manager, the manager hands it to the browser, and nothing on the way adds a
 * field to it.
 */
export interface BeeTransaction {
  transactionHash: string;
}

/** What bee answers `GET /chequebook/balance` with, both amounts in PLUR. */
export interface ChequebookBalance {
  totalBalance: string;
  availableBalance: string;
}

export type ChequebookState =
  /** The node was not asked, or could not answer. Never a reason to alarm. */
  | 'unknown'
  /** At or above the floor: peers will keep forwarding this node's uploads. */
  | 'ok'
  /** Below the floor, with something left. Fill it before it runs out. */
  | 'low'
  /** Nothing left to pay with. Uploads stall until it is filled. */
  | 'empty';

export interface ChequebookHealth {
  state: ChequebookState;
  /** What the node said it can still pay with, or null when it did not say. */
  availablePlur: bigint | null;
  floorPlur: bigint;
}

/**
 * Classify what a node reported against the floor.
 *
 * `balance` is null for "not asked, or did not answer", which is deliberately
 * not the same as a zero balance: a node that is down says nothing about its
 * chequebook, and reporting it as empty would be inventing a reading.
 */
export function chequebookHealthFrom(
  balance: ChequebookBalance | null,
  floorPlur: bigint,
): ChequebookHealth {
  const availablePlur = balance ? parsePlur(balance.availableBalance) : null;

  if (availablePlur === null) {
    return { state: 'unknown', availablePlur: null, floorPlur };
  }
  if (availablePlur === 0n) {
    return { state: 'empty', availablePlur, floorPlur };
  }
  return {
    state: availablePlur < floorPlur ? 'low' : 'ok',
    availablePlur,
    floorPlur,
  };
}

/** True where the operator has to act before this node can pay for uploads. */
export function isChequebookShort(state: ChequebookState): boolean {
  return state === 'low' || state === 'empty';
}

/**
 * Why this node cannot pay for what it uploads, phrased for an operator, or
 * null when there is nothing wrong to say.
 *
 * One sentence per state, shared, because the readiness checklist on the
 * deployment page and the attention row on the overview say the same thing
 * about the same node and must not word it two different ways.
 */
export function chequebookStateReason(health: ChequebookHealth): string | null {
  switch (health.state) {
    case 'empty':
      return 'Chequebook empty. Uploads stall until it is filled.';
    case 'low':
      return `Chequebook ${plurToBzz(health.availablePlur ?? 0n)} BZZ available, under the ${plurToBzz(health.floorPlur)} BZZ floor. Peers stop forwarding this node's uploads when it cannot pay.`;
    case 'ok':
    case 'unknown':
      return null;
  }
}

/** What a set of nodes said about their chequebooks, by profile name. */
export type ChequebookHealthsByName = ReadonlyMap<string, ChequebookHealth>;

/**
 * Which of these nodes cannot pay at all, out of the readings a page collected.
 *
 * The blocker for a group of nodes that work together, such as an ABR pool: a
 * rung with an empty chequebook is listed in the pool string like any other, and
 * an uploader publishing to it lands nothing on that rung. A low rung still
 * pays, so it is a warning and never a reason to call the pool unready. A node
 * that did not answer said nothing either way and is left out.
 */
export function drainedChequebooks(
  healths: ChequebookHealthsByName,
  names: readonly string[],
): string[] {
  return names.filter((name) => healths.get(name)?.state === 'empty');
}

/**
 * What the operator is told when the uploader gate could not read a chequebook
 * and started anyway.
 *
 * The gate is deliberately permissive, because a node that cannot be asked is
 * no evidence of an empty chequebook. That leaves an uploader running with its
 * funding unverified, which was a line in the manager's log and nothing on
 * screen, so an upload that lands nothing looks like an upload that works.
 */
export function uncheckedChequebookNotice(name: string): string {
  return `Started without checking the chequebook of ${name}: its node did not answer.`;
}

/**
 * Why a deposit is more than the node's wallet can cover.
 *
 * These four sentences are the whole of what an operator is told when a move of
 * BZZ is refused, and the offline mock has to refuse in the same words as the
 * manager or reviewing the frontend against it proves nothing about the real
 * thing. So they are written once, here, next to the numbers they quote.
 */
export function depositOverWalletReason(
  walletPlur: bigint,
  amountPlur: bigint,
): string {
  return `This node's wallet holds ${plurToBzz(walletPlur)} BZZ and the deposit asks for ${plurToBzz(amountPlur)} BZZ. Send more BZZ to the node's funding address, or fill with less.`;
}

/** A deposit is an on-chain transaction, and gas on Gnosis is paid in xDAI. */
export const NO_XDAI_FOR_GAS_REASON =
  "This node's wallet has no xDAI, so it cannot pay the gas an on-chain deposit costs. Send a little xDAI to the node's funding address, then try again.";

/** Why a withdrawal is more than the chequebook has left to give back. */
export function withdrawalOverChequebookReason(
  availablePlur: bigint,
  amountPlur: bigint,
): string {
  return `This node's chequebook has ${plurToBzz(availablePlur)} BZZ available and the withdrawal asks for ${plurToBzz(amountPlur)} BZZ. Withdraw less, or wait for the cheques already handed out to be cashed.`;
}

/** Why an uploader will not be started against this node's chequebook. */
export function uploaderUnfundedReason(health: ChequebookHealth): string {
  return `This deployment's Bee node has ${plurToBzz(health.availablePlur ?? 0n)} BZZ available in its chequebook and the floor is ${plurToBzz(health.floorPlur)} BZZ. Fill the chequebook, then start the uploader.`;
}

/** `ChequebookHealth` in the form that survives JSON, where no bigint can go. */
export interface ChequebookHealthPayload {
  state: ChequebookState;
  availablePlur: string | null;
  floorPlur: string;
}

export function chequebookHealthPayload(
  health: ChequebookHealth,
): ChequebookHealthPayload {
  return {
    state: health.state,
    availablePlur: health.availablePlur?.toString() ?? null,
    floorPlur: health.floorPlur.toString(),
  };
}

export function chequebookHealthFromPayload(
  payload: ChequebookHealthPayload,
): ChequebookHealth {
  return {
    state: payload.state,
    availablePlur: parsePlur(payload.availablePlur),
    floorPlur: parsePlur(payload.floorPlur) ?? 0n,
  };
}

/**
 * What `GET /profiles/:name/chequebook` answers with.
 *
 * Every amount is a PLUR string, and every field is null when the call behind
 * it failed: the node's address, its balance and its settlement totals are
 * three separate requests, and one of them failing is no reason to withhold
 * the other two.
 */
export interface ChequebookSummary {
  address: string | null;
  totalBalance: string | null;
  availableBalance: string | null;
  totalSent: string | null;
  totalReceived: string | null;
  health: ChequebookHealthPayload;
}

/** Which way a submitted transfer moves the chequebook's total. */
export type TransferDirection = 'deposit' | 'withdraw';

/** The transfer that was submitted, and so what a later reading has to show. */
export interface TransferExpectation {
  direction: TransferDirection;
  amountPlur: bigint;
}

export type TransferOutcome =
  /** The total has moved by the amount, the way the transfer asked it to. */
  | 'settled'
  /** Both readings are numbers and the amount has not arrived yet. */
  | 'pending'
  /** A reading is missing, so the transfer cannot be judged either way. */
  | 'unknown';

/**
 * The one field a submitted transfer is judged on.
 *
 * Its own type so a caller can hand over a full `ChequebookSummary`, a
 * `ChequebookBalance`, or a reading it assembled itself.
 */
export interface ChequebookTotalReading {
  totalBalance: string | null;
}

/**
 * Whether a submitted deposit or withdrawal has landed, from what the
 * chequebook's total said before it and says now.
 *
 * The total is the field that answers this and the available balance is not. A
 * deposit raises the total and a withdrawal lowers it, by the amount, once the
 * transaction mines. The available balance moves every time the node writes a
 * cheque or a peer cashes one, so watching that field calls an unrelated
 * payment a settled transfer.
 *
 * A reading that is missing or unreadable is `unknown` rather than a movement.
 * Bee answers the chequebook calls independently, so a number turning null is a
 * failed read and never money changing hands. Reporting that as a settled
 * transfer tells an operator their BZZ has moved when nothing is known.
 *
 * Settled is "at least the amount, in the right direction" rather than exactly
 * the amount, because peers cash cheques while a transfer mines and the total
 * carries both movements at once.
 */
export function transferOutcome(
  before: ChequebookTotalReading | null,
  after: ChequebookTotalReading | null,
  expectation: TransferExpectation,
): TransferOutcome {
  const beforePlur = parsePlur(before?.totalBalance);
  const afterPlur = parsePlur(after?.totalBalance);
  if (beforePlur === null || afterPlur === null) return 'unknown';

  const settled =
    expectation.direction === 'deposit'
      ? afterPlur >= beforePlur + expectation.amountPlur
      : afterPlur <= beforePlur - expectation.amountPlur;
  return settled ? 'settled' : 'pending';
}
