# Chequebook funding and transfer recovery

A Bee node's wallet and chequebook are different balances. A deposit moves BZZ
from the node's wallet into its chequebook. A withdrawal moves it back. The
manager presents these transfers as recorded operations whose outcome must be
checked from transaction evidence. A balance change cannot confirm a transfer.

This page describes accepted T09 behavior included in the local `main-v2`
integration checkpoint `4372848` on 2026-09-09. It includes the journal, receipt
recovery, durable browser workflow, history, account/instance guards and owned
transport factory through `b1b1aec`. New submission preparation captures T06's
SQL target proof and uses one qualified Docker/Bee connection. Local Unix and
supervised SSH adapters are implemented, but the production qualification
catalog is empty. Acquisition refuses without a matching qualified record.
Actual SSH and exact-image qualification, finite receipt polling and final
connected acceptance remain open. The local merge is not evidence of a host
deployment or live transfer.

## Balances and new uploader starts

The storage card shows wallet balances, the chequebook address, total and
available chequebook balances, and settlement totals when the node answers.
Unavailable readings remain unknown and must not appear as zero or a fresh
successful reading. The manager's configured floor is shown consistently in
the UI and enforced on paths that start an uploader. The default floor is
0.5 BZZ. The protocol amount uses PLUR, with 10^16 PLUR per BZZ.

Under Levi's decided D02 policy, a new uploader start is refused when a critical
funding or postage prerequisite cannot be verified. A missing reading is not
permission to accept a new paid start. This policy does not automatically stop
an existing stream. Engine-only recovery and node bootstrap remain separate
from starting an uploader.

A read-only balance or readiness check does not submit money. Filling the
chequebook requires an explicit confirmed transfer intent. The manager does
not offer arbitrary transfers from a node wallet to an outside address as
part of T09.

## Confirm once and retain the request

Before the first money POST, the browser must durably save the confirmed
intent and its request UUID in one IndexedDB transaction. The intent includes
the original signed-in account, deployment instance, direction and exact
amount. If persistence fails, submission is refused. Only the invocation whose
transaction commits the new intent may make its initial POST.

Keep the intent after navigation, reload and terminal results. Another tab
restores the saved intent. It cannot silently replace it. New transfer is an
explicit action followed by a confirmation that checks the current saved
pointer again. Browser notifications refresh views but do not provide the lock.

After a lost response, query the original request id. An error or 404 does not
prove that an earlier POST can never reach the manager. Preserve the UUID.
Any explicit resend uses the same UUID and immutable payload under the same
account and deployment instance. There is no automatic resend. Deleting and
recreating a deployment under the same name must not retarget an old intent.

Submission and recovery writes carry the account that the page expects. The
server compares it with the current signed-in account before doing the work.
An account change in another tab therefore cannot silently send a reviewed
request as a different user. The authenticated user remains the recorded actor.

The server stores the operation before dispatch. Its immutable identity includes
chain, node address, chequebook, token, amount, direction, actor, deployment
instance, start-block evidence and observed nonce lower bound. The nonce
observation is not a nonce reservation. Request ids remain unique even after
an operation finishes. One unresolved operation per chain and node protects
against concurrent aliases and managers.

Dispatch is a durable one-shot claim. A lost Bee response or a failure to save
the returned hash leaves an unresolved operation. The manager never sends it
again automatically after a restart.

## Reading the outcome

| Stored state | Meaning |
| --- | --- |
| `submitting` | The operation was durably admitted. This state alone does not prove whether Bee received the POST. |
| `submitted` | A transaction hash was recorded. Mining and finality are not yet established. |
| `unknown` | Submission or later evidence could not establish an outcome. Keep the original request and inspect recovery evidence. |
| `settled` | A matching successful receipt and the required canonical, finalized history were verified. |
| `reverted` | A matching reverted receipt and the required canonical, finalized history were verified. |
| `rejected` | A positive preflight refusal prevented dispatch. This state is never inferred from a timeout during submission. |
| `asserted` | An operator recorded the explicit duplicate-risk assertion. It is not verified settlement or proof that submission never happened. |

Conflicting attribution or direct-response evidence takes precedence over an
older terminal label. The detail view must show the saved identity, hashes,
response evidence and last check. A bounded candidate list is not necessarily
all recorded evidence. When its limit is reached, the response journal may
contain additional conflicting hashes.

Balances remain useful context, but neither total nor available balance closes
or settles a transfer. An unrelated deposit, withdrawal or cheque settlement
can move those values.

## Checking and resolving an unresolved operation

Check uses the recorded identity and trusted manager chain configuration.
It first examines the known hash when available. Receipt verification checks
identity, canonical block ancestry and finality. Missing receipts remain
pending. Unavailable RPC, incomplete history, contradictory evidence and reorgs
remain unresolved. Checks are bounded and persist progress where supported.

If the hash was lost, recovery inspects matching pending transactions and then
performs a bounded block scan. An already-started scan must finish its recorded
range before a candidate can be treated as unique. An ambiguous or incomplete
search cannot authorize an assertion. Operations that might still broadcast
late remain relevant even after an operator assertion.

A supplied transaction hash is a request to verify that transaction against
the saved identity. It is not a force-settlement control. Historical checks
and history remain available after a deployment is deleted.

D10 permits a separate operator assertion only after a complete current
no-match result. The operator types the exact server-provided acknowledgement
that retrying the recorded amount may pay twice. The journal retains the actor,
time, amount and confirmation. A later result may still reveal a transaction
or conflicting evidence. The assertion does not submit a replacement transfer.

## API contract

All routes require the existing session and write-request protections. The
server derives the actor from the authenticated user, not request JSON. Amounts
are positive integer PLUR strings. New submissions require both `requestId`
and `profileInstanceId` UUIDs plus the positive integer `expectedAccountId`.
Existing exact-request replay is checked before looking up the current
deployment, so deletion does not break recovery. Recovery writes also require
`expectedAccountId`. An assertion additionally requires the reviewed journal
revision as a decimal string. A later journal change invalidates that assertion.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/profiles/:name/chequebook` | Read node balances and chequebook summary. |
| POST | `/profiles/:name/chequebook/deposit` or `/withdraw` | Submit `{ requestId, profileInstanceId, amount, expectedAccountId }`. An accepted or replayed result returns 202. Busy or conflicting identity returns 409 with the relevant operation. |
| GET | `/chequebook/operations` | Bounded history with optional profile filter and cursor. |
| GET | `/chequebook/operations/by-request/:requestId` | Recover the exact original request. |
| GET | `/chequebook/operations/:id` | Read the operation and its response evidence together. |
| POST | `/chequebook/operations/:id/check` | Request another evidence check with `{ expectedAccountId }`. |
| POST | `/chequebook/operations/:id/resolve` | Supply `{ transactionHash, expectedAccountId }` for verification. |
| POST | `/chequebook/operations/:id/assert` | Submit `{ amountPlur, confirmation, expectedAccountId, expectedRevision }` using the recorded amount, exact duplicate-risk confirmation and reviewed revision under D10. |

A busy response can name another operation. The browser must not attach that
operation to its own saved intent as though its submission succeeded. History
is available independently of the deployment page.

The factory selects trusted locators and existing qualification IDs from
`CHEQUEBOOK_DOCKER_TRANSPORTS`. Chain reads use `CHEQUEBOOK_RPC_ENDPOINTS`.
Runtime configuration cannot create a qualification record, and the factory
has no direct Bee URL fallback. It no longer uses `CHEQUEBOOK_BEE_ENDPOINT_MODE`.
History and exact replay do not require current transport configuration.
Pending Bee reads require the saved deployment instance and matching node
identity. Missing pending observations remain unavailable, while receipt and
manual chain recovery can still use the frozen operation after profile deletion.

## Evidence and remaining acceptance

The journal and target-ownership checkpoint `16fd7b3` passed 78 actual SQL
checks and types. The preceding combined branch passed 1002 manager, 289 common,
18 frontend and 48 browser checks plus types. Native browser regressions cover
durable intents, competing tabs, reload, account changes, lost responses,
deleted-deployment history, conflicting evidence and explicit recovery actions.

Synthetic Docker/Bee preparation is reviewed through `3cd3443`, with 211 focused
checks and types. The separate step-deadline correction `3d66035` passed 88
focused checks and types. These results exercise protocol and ownership code
without qualifying an actual Bee image or making a live transfer.

The connected factory checkpoint `b1b1aec` passed 42 focused factory, runtime,
deadline and pending-read checks, 151 compatibility checks and manager types.
Its synthetic cases include lost-response replay, target changes, deleted-profile
receipt recovery and shutdown during capture, connection, claim and POST.
Shutdown retains cleanup promises and reports unverified resource closure.
These results do not establish aggregate verification of the merged branch.

Completion still requires exact immutable-image bridge and actual SSH
qualification, finite receipt-only polling, the portable intent-browser harness,
and the connected authenticated SQL/browser acceptance run on the integrated
code. Polling must not resend money, scan unknown submissions automatically or
renew its budget indefinitely on refresh. The production qualification catalog
remains empty until the recorded binary/disconnect harness succeeds.
Real-money testing remains a separately authorized T22 activity with Levi's
pending D05 inputs and strict ownership of cleanup.

The historical 0.5 BZZ fill on the funded `review-20260907` deployment remains
unverified. Without transaction evidence, this document does not establish
whether it was submitted, whether it settled or whether a retry is safe.
