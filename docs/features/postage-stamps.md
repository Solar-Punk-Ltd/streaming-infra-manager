# Postage stamps

A postage stamp, or batch, is prepaid storage on Swarm. A Bee node buys it on
Gnosis Chain with BZZ from its own wallet, and every chunk it uploads carries a
stamp from that batch as proof that the storage is paid for. A deployment with
a Bee node of its own handles its batches on its page, on the **Storage and
funding** card: it buys one, sets one on the deployment with **Use**, tops one
up for more life, and dilutes one for more room.

Status, 2026-09-25. Written on `feat/stamp-top-up-and-dilute`, off `5c76e2b5`
on `fix/full-stamps-and-sick-uploaders`, and checked against the code at
`1d7e8aff`. Top-up and dilute are new on that branch. Neither has been run
against a real Bee node or with real money: every test uses fakes or the
offline mock, and the operator presses these buttons himself. What Bee and the
postage contract do is read from their source, bee at `v2.7.0` (checkout of
2026-01-29) and storage-incentives' `PostageStamp.sol` (checkout of
2026-01-15), and each such statement below says so.

## What a batch is

A batch has a **depth**. It holds `2^depth` chunks of 4 KB, so a depth 23 batch
names 8,388,608 chunks, 32 GiB. Bee splits every batch into `2^16` buckets, its
16 bucket bits, so each bucket holds `2^(depth - 16)` chunks: 2 at depth 17 and
128 at depth 23. A chunk's bucket is set by its own address, not chosen, so the
chunks never spread evenly and **one bucket fills first**, long before the batch
as a whole is full.

That fullest bucket is what decides whether an upload is refused, and it is
what Bee reports: its `utilization` is the chunk count of the batch's fullest
bucket, not of the whole batch. The manager reads how full a batch is as that
count over what one bucket holds, `fullestBucketFillRatio` in
`common/src/stampHealth.ts`, where 1 is full. The stamps table shows it in its
**Used** column as a percentage with the two counts under it, "128 of 128".

The manager buys and dilutes within depth 17, the shallowest batch Bee sells,
and depth 40, its own ceiling (`MIN_STAMP_DEPTH` and `MAX_STAMP_DEPTH` in
common).

## When the fullest bucket fills

- An **immutable** batch refuses every upload that lands in a full bucket, with
  a 402. Bee still calls such a batch usable and still shows its time left,
  which is how the tester's 1080p rung read "Postage stamp set, 2d 3h left" on
  2026-09-24 while its node refused every upload. The manager calls it `full`,
  and a full batch blocks its deployment's readiness and its rung's place in a
  pool string, the way an expired one does.
- A **mutable** batch never refuses. It takes the upload and overwrites the
  oldest chunk in that bucket, so what earlier uploads stored is lost while new
  uploads keep working. It stays `active`, and the readiness step says it now
  overwrites.
- A batch whose kind the node did not report is read as immutable, since that
  is the kind that refuses.

An immutable batch past **90%** full warns as **Stamp nearly full**, because 90%
is the uploader's own default start ceiling, `STAMP_MAX_UTILIZATION`: an
uploader restarted on such a batch refuses to start while uploads still work.

## Life and price

A batch holds a balance for every chunk, the **amount** in the stamps table, in
PLUR per chunk (1 BZZ is 10^16 PLUR). Every Gnosis block, five seconds, the
chain takes the current price from that balance for every chunk. So a batch's
life, its TTL, is its balance over the price, times five seconds. When the
balance runs out the batch has expired: its uploads fail, nothing revives it,
and the node drops it some time later.

- The price moves, so every life shown before paying is at **today's price**,
  from the node's `/chainstate`. A batch lives longer if the price falls and
  shorter if it rises.
- Bee refuses to buy a batch with less than a day of life at today's price, so
  the buy form says what a day costs a chunk (`minimumStampAmountPlur`). At the
  host's price on 2026-09-13, 90,968 PLUR a chunk a block, a day cost
  1,571,927,040 PLUR a chunk.
- Buying or topping up costs the amount for every chunk the batch holds,
  `amount × 2^depth` PLUR (`stampCostPlur`). A day for a depth 23 batch at that
  price is 1.318627974316032 BZZ.
- The postage contract refuses a top-up or a dilute that would leave a batch
  with less than its minimum validity, 17,280 blocks, which is a day
  (`minimumValidityBlocks` and `minimumInitialBalancePerChunk` in
  `PostageStamp.sol`).
- A batch warns as **Stamp ends soon** within two days of running out
  (`STAMP_EXPIRY_WARNING_SECONDS`).

## What a deployment's page says about its batch

The readiness step **Postage stamp set** and the batch alerts on the Storage
card read the batch recorded on the deployment against what its node says
(`stampHealthFrom`). The pool page and the overview read the same verdict.

| State | What it means | Blocks | What is offered |
|---|---|---|---|
| none | No batch recorded on the deployment. | yes | Buy stamp |
| pending | Bought, and Bee has not made it usable yet. | yes | nothing, it settles by itself |
| active | Usable, with room or mutable, and time left. | no | Top up or buy within two days of running out, Dilute or buy past 90% full |
| full | Immutable, its fullest bucket full. | yes | Dilute or buy |
| expired | No time left. | yes | Buy stamp |
| gone | The node no longer holds the recorded batch. | yes | Buy stamp |
| unknown | The node was not asked or did not answer. | no | Retry node checks, where the page asked |

Under **Needs attention** on the overview, a missing, expired, full, nearly
full or ending batch carries the same remedy as a button that opens the
deployment's storage: Buy stamp, Dilute or buy, or Top up or buy.

## The four operations on the Storage card

Each batch in the stamps table has its readings on one row and, under it, what
can be done with it: **Use**, or "in use" for the recorded one, **Top up** and
**Dilute**. All three are off for an expired batch and for one not usable yet,
and while another change is in flight.

### Buy

The form under the table takes an amount per chunk, a depth, an optional label
and whether the batch is immutable, and shows the life and the cost before the
operator buys. It costs `amount × 2^depth` PLUR from the node's wallet and the
transaction fee in xDAI. The new batch is unusable for a few minutes, and the
manager polls it every three seconds for up to fifteen minutes and sets it on
the deployment once it is usable, unless another batch was set with **Use**
meanwhile. Setting a batch redeploys nothing: a running uploader goes on paying
with the batch its env file named until the deployment is deployed again, and
a pool rung's new batch reaches its ABR uploader only through the pool string
pasted into it again.

### Use

Records a batch the node already holds as the deployment's batch. It costs
nothing, sends nothing to the chain and redeploys nothing. It is unavailable on
a **full immutable batch**, and the row says why, "full, dilute it first":
setting it would record a batch whose node refuses every upload in its full
bucket.

### Top up

Adds an amount per chunk to a batch's balance. It buys the batch life and
changes nothing else: not its depth, not its fill, not its id. It costs
`amount × 2^depth` PLUR from the node's wallet and the transaction fee in xDAI.

The dialog names the batch by its short id, depth, life left and how full it
is, and takes one amount, PLUR per chunk, with a hint of what a day more costs
a chunk at today's price. Before the operator confirms it shows the life the
amount adds, the life after and the cost, written out to the last digit because
it is money leaving the wallet, and the confirm names that cost, "Top up for
1.318627974316032 BZZ". Where the node's wallet was read and holds less than
the cost, the confirm is off and the dialog says how much the wallet holds.

### Dilute

Raises a batch's depth. Every step doubles the chunks the batch holds and the
chunks each bucket holds, keeps the fullest bucket's count, so it halves how
full the batch is, and halves the life left, because the same balance now pays
for twice the chunks. It costs **no BZZ**, only the transaction fee in xDAI, and
it keeps the batch id. It is the remedy for a full immutable batch: the host's
depth 23 batch with 128 of 128 chunks in its fullest bucket is half full at
depth 24, 128 of 256, with half its life.

The dialog names the batch the same way and takes one input, the new depth,
from one step deeper to 40, starting one step deeper. Before the operator
confirms it shows what the batch holds after, in chunks and in each bucket, how
full it is after, its life after, and that it costs no BZZ. Where the life after
would be under a day it warns, says the postage contract refuses a dilution
that leaves less than a day, and suggests topping up first. It does not block
the confirm, which names the depth, "Dilute to depth 24".

Diluting leaves less life, so a batch diluted with little time left warns as
ending soon, and a top-up buys that life back.

## After Bee answers

Bee sends a top-up or a dilute from the node's own wallet and answers once the
transaction is mined, with the batch id and the transaction hash. A top-up is
two transactions, an approval of the BZZ transfer and the top-up itself (bee
`pkg/postage/postagecontract`). The manager answers the page 202 with Bee's
answer.

The node then reads the change back from the chain, which its listener does a
few blocks behind the tip, four in bee's source (`pkg/postage/listener`). Until
it has, the node's list still shows the old life and depth. So the dialog
closes, the page reads the node's batches again at once, and the card says, in
a notice the operator closes, which transaction carries the change and that the
new life, or the new depth and life, shows once the transaction is mined and
the node has read it, usually within a minute. The card reads the node again
every ten seconds, and **Refresh** reads it at once.

Neither change touches the deployment's record or its pool string, because the
batch keeps its id. A diluted batch takes uploads again once its node has the
new depth. An uploader that has already reported `postage_refused` goes on
reporting it until it is deployed again, because the stack's uploader keeps
that reason for the life of its process (the stack's
`packages/stream-uploader/README.md` at `v3.3`), and a ladder takes a rung that
fell behind back into its master playlist once eight segments in a row land.

## What the manager refuses before Bee is asked

- A body that breaks the rules: a batch id that is not 32 bytes of hex, with or
  without `0x`, an amount that is not a positive whole number of PLUR, or a
  depth outside 17 to 40. Answered 400.
- A batch the deployment's node does not hold. The manager reads the batch off
  the node's own list first and answers 404 `stamp_not_found`. Bee itself
  answers a change to a batch it does not know with a bare 500, and its batch
  store holds every batch on the chain, so without that read a stranger's batch
  could be paid for (bee `pkg/api/postage.go`).
- A dilute to a depth that is not deeper than the batch's own. Answered 400 with
  the batch's depth in the sentence. Bee refuses only a shallower depth and
  leaves an equal one to the contract, which refuses it on chain.

A refusal from Bee itself, "out of funds" for one, reaches the page in Bee's
own words, the way a refused buy does.

## API

`POST /profiles/:name/stamp/topup` with `{ batch_id, amount }` and
`POST /profiles/:name/stamp/dilute` with `{ batch_id, depth }`, behind the same
session as every stamp route. Both answer 202 with `{ batchID, txHash }`. The
whole list of stamp routes is in [manager/README.md](../../manager/README.md#postage-stamps-per-profile-its-own-bee-node).

## Implementation

| File | What it does |
|---|---|
| `common/src/stampChanges.ts` | `dilutionPreview` and `topUpPreview`, what a change leaves a batch with, and `BeeStampTransaction`, `TopUpStampRequest` and `DiluteStampRequest`, the shapes that cross the stack. |
| `common/src/stampHealth.ts`, `stampCost.ts` | How full a batch is and what state it is in, and what life and cost an amount buys. |
| `manager/src/domain/BeeClient.ts` | `topUpStamp` and `diluteStamp`, the two `PATCH` requests, on the on-chain budget buying uses. |
| `manager/src/domain/StampService.ts` | `topUpStamp` and `diluteStamp` for a deployment's own node: read the batch first, refuse, send, forget the node's cached reads, log one line. |
| `manager/src/domain/errors/StampNotFoundError.ts`, `DiluteDepthError.ts` | The two refusals, answered 404 and 400. |
| `manager/src/api/routes/stamp.ts`, `manager/src/schemas/stamp.ts` | The two routes and their bodies. |
| `frontend/src/uploaders/StampTable.tsx`, `stampRowActions.ts`, `bucketFill.ts` | The table's Used column and each batch's actions, with Use unavailable on a full immutable batch. |
| `frontend/src/uploaders/TopUpStampDialog.tsx`, `topUpView.ts`, `DiluteStampDialog.tsx`, `diluteView.ts`, `BatchSummary.tsx` | The two dialogs and what they show before the operator confirms. |
| `frontend/src/deployments/StorageCard.tsx` | Opens the dialogs, sends the change, reads the node again and says what was sent. |
| `frontend/dev/mock-stamps.mjs` | The offline mock's two routes, with the manager's schemas and refusals, and the change landing on its batch two seconds later. The mock seeds the pool's 720p rung with a full immutable batch. |
| `frontend/test/stamp-changes-browser.test.mjs` | A headless Chrome against the mock tops up and dilutes that batch from the Storage card. |

## Limits

- The dilute dialog warns and does not block a dilution that leaves under a
  day, as it was asked to, although the contract refuses one. Bee may then
  answer with an error the operator reads in Bee's words. Whether that
  refusal costs a transaction fee depends on Bee's gas estimate, which was not
  measured.
- Nothing warns about a top-up that leaves a batch under a day, which the
  contract refuses as well. It can only happen on a batch with less than a day
  left, where the dialog's hint already says what a day costs.
- The manager does not check the wallet before a top-up. The page does, where
  it read the wallet, and Bee refuses one it cannot pay as "out of funds".
- A refusal from Bee reaches the page as `bee_node_unreachable` with Bee's words
  in its message, the code every failed call to a node gets, which reads as
  though the node did not answer.
