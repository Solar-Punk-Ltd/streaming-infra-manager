# T09. Reconcile money movement by transaction identity

Source: R09. Priority: P2, with financial acceptance before the flow is called complete. Depends on: T10. Decision: D10 decided. Size: M, upper end.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`transferOutcome` (common/src/chequebook.ts:346) infers settlement from total balance movement. A peer cashout can mark a withdrawal successful and a lost response after acceptance has no identity to reconcile against. The manager already receives the transaction hash from Bee (ChequebookService.ts:110) and the stack `.env` carries `RPC_ENDPOINT`.

## Accepted design, in short

- Before the Bee call, insert a `chequebook_operations` row in state submitting: deployment, direction, amount, the node's Ethereum address and chain id, the chequebook contract address, the start block number and hash, and the node's transaction count with the tag it was read at, as an observation bound and never a reservation. One open operation per (chain id, node address) by a partial unique index. A second request answers 409 with the open operation.
- Response received: hash stored, state submitted, receipt polled by hash from `RPC_ENDPOINT` for a bounded time. Status 1 settled, status 0 reverted and shown as failed, no receipt pending. An endpoint error is "could not check". `RPC_ENDPOINT` is never logged or answered.
- Response lost: state unknown. No automatic retry exists. Recovery is by full identity only: sender equal to the node's address, chain id, destination equal to the BZZ token contract for a deposit or the chequebook contract for a withdrawal, calldata decoding to the amount, nonce within the recorded bound. Bee's pending list is checked first. A bounded, resumable chain scan with a persisted cursor runs whenever there is no unique match, not only when the list is empty. Zero or several candidates leave the operation unknown, the Move action for that node locked, and the card naming the node address and amount.
- Manual evidence: `POST .../chequebook/operations/:id/resolve` with a hash, verified for the full identity and a terminal receipt. A matching pending hash is adopted as pending and stays protected. An unrelated receipt does nothing.
- D10 override: after at least one full search pass found nothing, a typed confirmation naming the amount and the duplicate-payment risk closes the operation by assertion, recorded as an assertion with user and time, never as a verified outcome.
- The BZZ token address per chain id is a documented constant, an unknown chain refuses reconciliation. The deployed Bee, token and chequebook decoding is verified in the task. Balances are corroboration and never decide. Refresh, navigation and restart keep the record.
- Nothing here changes the status of the funded 0.5 BZZ fill, whose submission stays unverified.

## Acceptance

- Accepted but not mined: the response is dropped, latest nonce stays, no receipt, the wait expires, the request is repeated. Submission count stays one, the operation stays unknown or pending.
- A pending observer that has not seen the transaction: no retry, no unlock.
- Another transaction consumes the sampled nonce: the intended transfer at n+1 is matched by identity, n is never adopted for being sampled.
- An unrelated pending transaction hides a mined one: the scan still runs.
- Manual resolution naming a wrong transfer: neither settles nor releases.
- Receipt success, revert and absence, RPC outage, response loss, a mined transaction missing from the pending list, ambiguous candidates, navigation and restart, a simultaneous peer cashout, repeated requests. No real funds.

## Where the design lives

PRD "**Question 7, T09's uncertain submission**" (Fable round 2), "##### Question 5. T09 nonce and block-scan recovery" (OpenAI round 3), "##### Question 5, T09" (Fable round 3), OpenAI round 4 Question 3, decision D10.

## Code anchors

ChequebookService.ts deposit :91 to :111, assertFunded :151 to :174. BeeClient.ts :14 and :25. common/src/chequebook.ts:346. frontend uploaders/MoveBzzDialog.tsx :281 to :289, useBeeUtils.ts :248 to :262.
