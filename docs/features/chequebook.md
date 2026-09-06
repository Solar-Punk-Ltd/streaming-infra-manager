# Chequebook on every Bee node

Status: built on `feat/chequebook`, off `feat/auth` (D4 refuse below the floor, D5 0.5 BZZ, D6
no sending out of a node this round). One PR against `main-v2`, unpushed.

## What a chequebook is, and why the manager needs to show it

A Bee node pays the peers that forward its uploads. It pays with cheques drawn on a chequebook, a
small contract on Gnosis Chain that belongs to the node and holds BZZ. The node's wallet (the
address the manager already shows under "Node funding address") is a different pot: the wallet
holds xDAI for gas and BZZ for buying postage stamps and for topping up the chequebook. Moving BZZ
from the wallet into the chequebook is a deposit, an on-chain transaction that costs a little
xDAI.

When the chequebook runs dry nothing looks broken. The node answers `/health`, the uploader keeps
accepting segments, and every push to the network stalls waiting for a payment the node cannot
make. On 2026-08-12 a whole day of measurement was attributed to protocol overhead while the
chequebook sat at 99.9999 percent drained, and the counters saying so were in the same response
the whole time. The `main-v3` branch of the stack now refuses to start its uploader below a
chequebook floor of 0.5 BZZ for that reason. The manager should show the same number, warn before
it is reached, and offer the fix in place.

## What the operator sees

- **Storage and funding card** (deployment page, every deployment that runs its own Bee node):
  under the wallet balances a new **Chequebook** row: `available 1.2400 BZZ · total 1.3100 BZZ`
  and the chequebook address with a copy button. Two buttons: **Fill chequebook** and
  **Withdraw**. Below, one line of context: `Paid out to peers so far 0.0700 BZZ · received
  0.0000 BZZ`, from the node's settlements.
- **Fill chequebook** opens a small dialog: amount in BZZ (decimal, up to 16 places), the wallet
  balance shown next to it with a "Use all" link that leaves nothing behind, a sentence saying
  what happens: "Moves BZZ from this node's wallet into its chequebook. This is an on-chain
  transaction on Gnosis Chain, it costs a little xDAI in gas, and it cannot be undone from here."
  Confirm sends it. The dialog then shows the transaction hash bee answered with, shortened and
  with a copy button, and closes once the chequebook total has moved by the amount. After two
  minutes it stops waiting and says either that the total has not moved yet or that the node
  stopped answering, with a **Check again** button either way. Withdraw is the mirror image,
  chequebook to wallet, same dialog.
- **Readiness checklist** (deployment page): the "Bee node funded" step gains a chequebook clause.
  Above the floor: `xDAI 0.4 for gas · BZZ 2.1 for storage · chequebook 1.2400 BZZ available`.
  Below the floor: state warn, `Chequebook 0.1200 BZZ available, under the 0.5000 BZZ floor.
  Peers stop forwarding this node's uploads when it cannot pay.` with the action **Fill
  chequebook**.
  At zero: state err, `Chequebook empty. Uploads stall until it is filled.`
- **Readiness pill** (list rows, overview): two new labels. `Chequebook empty` (red) when the
  node reported zero available. `Chequebook low` (amber) when below the floor. Both only when
  the node actually answered, never from a missing reading. A node that could not be asked keeps
  the existing labels.
- **Overview, Needs attention**: rows for both labels, text as above, button **Fill chequebook**,
  which opens the deployment at its storage card.
- **ABR node pool page**: the rung table gets a **Chequebook** column beside the wallet column,
  amber when low, red when empty. The pool string card lists `<rung> chequebook empty` among the
  things holding it up, because an uploader publishing to a dry rung uploads nothing on that rung.
- **Start uploader** (decision D4): refused when the node's chequebook available balance is below
  the floor. The refusal reads: `This deployment's Bee node has 0.1200 BZZ available in its
  chequebook and the floor is 0.5000 BZZ. Fill the chequebook, then start the uploader.` A node
  that cannot be asked does not block, the same rule the stamp check already applies.

## Bee endpoints used

All on the node's API, which the manager already reaches at `beeApiUrlFor(profile)`. Amounts are
PLUR, the integer unit of BZZ: 1 BZZ is 10 to the 16 PLUR. The frontend's `BZZ_DECIMALS` is 16.

| Purpose | Request | Answer |
|---|---|---|
| Chequebook address | `GET /chequebook/address` | `{ chequebookAddress }` |
| Balance | `GET /chequebook/balance` | `{ totalBalance, availableBalance }` as PLUR strings. Available is total minus cheques already handed out and not yet cashed. |
| Fill | `POST /chequebook/deposit?amount=<plur>` | `{ transactionHash }`. Needs xDAI in the wallet for gas and at least the amount in BZZ. |
| Withdraw | `POST /chequebook/withdraw?amount=<plur>` | `{ transactionHash }` |
| Paid and received totals | `GET /settlements` | `{ totalSent, totalReceived, settlements[] }` in PLUR |
| Wallet | `GET /wallet` | already used. Bee 2.x also returns `walletAddress`, `chequebookContractAddress` and `chainID`, which the manager type can now read. |

Bee answers the deposit and withdraw calls once the transaction is submitted, not once it is
mined. Gnosis blocks take about five seconds, so the balance moves shortly after. The frontend
polls the chequebook until its total has moved by the amount, which is `transferOutcome` in
common. The available balance is the wrong field to watch: every cheque the node writes and every
one a peer cashes moves it, so an unrelated payment would confirm a transfer that had not mined.
A reading that is missing or unreadable answers `unknown`, never movement. bee-js 9.8.1 in the
stack's own dependencies uses exactly these paths, so they are confirmed against the Bee 2.8.1
image the stack runs.

Sending BZZ or xDAI from the node wallet to an outside address (`POST /wallet/withdraw/{coin}`)
exists in Bee too, but it only works when the node was started with
`--withdrawal-addresses-whitelist` naming the destination. That is a compose change in
swarm-hls-stream and a node restart per change. Decision D6, out of this PR unless Levi wants it.

## Manager changes

**Shared package** `common/src/chequebook.ts`, new, tested:

- `PLUR_PER_BZZ = 10n ** 16n`, `bzzToPlur(text): bigint | null` (decimal string with at most 16
  fraction digits, no exponent, positive), `plurToBzz(plur): string` (four decimals, truncated,
  the same the balances are shown with, used by messages).
- `ChequebookHealth`: `{ state: 'unknown' | 'ok' | 'low' | 'empty', availablePlur: bigint | null,
  floorPlur: bigint }` and `chequebookHealthFrom(balance | null, floorPlur)`. `unknown` for no
  reading. Shared so the manager's gate and the frontend's pill cannot disagree.
- `DEFAULT_CHEQUEBOOK_FLOOR_BZZ = '0.5'` (decision D5).

**Bee client** `manager/src/domain/BeeClient.ts`: add `getChequebookAddress`,
`getChequebookBalance`, `depositChequebook(amountPlur)`, `withdrawChequebook(amountPlur)`,
`getSettlements`. Deposit and withdraw use the existing 180 second buy timeout. The class name
no longer fits, rename to `BeeClient.ts` in its own commit.

**Service** `manager/src/domain/ChequebookService.ts`, new, next to `StampService`, sharing its
client factory and `beeApiUrlFor`:

- `summary(name)`: address, balance, settlement totals, health against the floor, fetched in
  parallel with `Promise.allSettled`, each piece independently nullable.
- `deposit(name, amountPlur)`: reads the wallet first and refuses with a plain
  `ChequebookFundsError` (400) when the wallet holds less BZZ than asked or no xDAI at all, so
  the operator gets a sentence and not Bee's raw revert text. Then calls Bee. Logs the tx hash.
- `withdraw(name, amountPlur)`: refuses when asked for more than available.
- `assertFunded(name)`: for the uploader gate. Throws `ChequebookUnfundedError` (409) below the
  floor. A node that cannot be asked logs a warning and lets the deploy proceed, mirroring
  `assertStampUsable`.
- Floor from `CHEQUEBOOK_FLOOR_BZZ` in the manager env, default `0.5`, parsed once in
  `utils/config.ts` and exposed in `GET /config` as `chequebookFloorBzz` so the frontend shows
  the same number the gate uses.

**Routes** `manager/src/api/routes/chequebook.ts`, new, validated with yup like the stamp routes:

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/profiles/:name/chequebook` | | `{ address, totalBalance, availableBalance, totalSent, totalReceived, health }`, any field null when that call failed |
| POST | `/profiles/:name/chequebook/deposit` | `{ amount }` PLUR string `^[1-9][0-9]*$` | `202 { transactionHash }` |
| POST | `/profiles/:name/chequebook/withdraw` | `{ amount }` same | `202 { transactionHash }` |

`UploaderStartGate`, which the orchestrator asks before any route starts an uploader on a running or errored deployment, calls `assertFunded` after the stamp check (D4). The check is not tied to one button: Retry, a settings change and a plain API deploy pass through it too.
`errorHandler` maps the two new errors. `frontend/nginx.conf` extends the long timeout location
from `stamp` to `(stamp|chequebook)` because a deposit can take longer than the default upstream
timeout.

## Frontend changes

- `uploaders/chequebookApi.ts`: `fetchChequebook`, `depositChequebook`, `withdrawChequebook`.
- `uploaders/useBeeUtils.ts`: fetches the chequebook summary with the other node data, exposes
  `chequebook`, and watches a submitted transfer with `waitForBalanceChange(expectation)` and
  `recheckBalance(expectation)`, both answering `settled`, `pending` or `unknown`. Same rule as
  stamps: a failed fetch sets it to null, never leaves a stale value standing.
- `uploaders/ChequebookRow.tsx` (inside `NodeFunding`), `uploaders/MoveBzzDialog.tsx` (one
  component, `direction: 'fill' | 'withdraw'`).
- `deployments/checklist.ts` funding step, `deployments/readiness.ts` two labels with exported
  constants, `overview/AttentionList.tsx` two cases, `groups/PoolRungRow.tsx` column,
  `groups/groupReadiness.ts` pool problem. Readiness takes an optional `ChequebookHealth` the way
  it takes `StampHealth` today: only pages that asked the node pass it.
- `deployments/StorageCard.tsx` gets the row and the buttons. The storage anchor is already
  what the attention rows navigate to.
- `data.ts` `ServerConfig` gains `chequebookFloorBzz`.
- Mock manager: each seeded node gets a chequebook (one rung seeded low, one stream seeded
  empty so the states are visible), deposit moves wallet to chequebook after three seconds,
  withdraw the reverse, `/config` returns the floor.

## Tests

- `common`: `bzzToPlur` accepts `1`, `0.5`, `.5`, `1.0000000000000001`, refuses `1e3`, `-1`,
  `0`, 17 fraction digits, letters. `chequebookHealthFrom` for null, zero, below, at and above
  the floor.
- `manager` unit: deposit refused without xDAI, refused above the wallet balance, PLUR schema
  refuses decimals and `0x`, `assertFunded` throws below the floor and proceeds when the node
  cannot be asked (stub client factory, the pattern `stampHealthFor.test.ts` uses).
- Frontend has no test runner. Verification runs in the Browser pane against the mock: fill
  dialog end to end, withdraw, the empty and low pills on the list and the overview, the rung
  column, the refused Start uploader with its message.

## Done means

- Every deployment with its own Bee node shows chequebook available and total, its address, and
  paid and received totals.
- Fill and Withdraw work against the mock and are confirmed on one real node by Levi on the host
  (his gate).
- Low and empty appear in the checklist, the pills, the overview and the rung table, and never
  from a node that was not asked.
- Start uploader is refused below the floor with the sentence above, unless D4 says warn only.
- The floor shown in the UI is the one the gate uses, from one config value.
- No new dependency. Typecheck, build and tests green. No em-dashes or semicolons in copy.
