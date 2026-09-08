# Chequebook funding and transfer recovery

A Bee node's wallet and chequebook are different balances. A deposit moves BZZ
from the node's wallet into its chequebook. A withdrawal moves it back. The
manager presents these transfers as recorded operations whose outcome must be
checked from transaction evidence. A balance change cannot confirm a transfer.

This page describes accepted T09 behavior and its local implementation on
`codex/t09-money-by-transaction`, with the T12 readiness integration. As checked
on 2026-09-08, `main-v2` is still at `d046ebf`. The transaction backend is
implemented locally. The durable browser workflow, deployment-instance guard
and T06 target-ownership integration are being completed. Do not assume the
current live dialog implements the behavior below. No live transfer was made
to verify this remediation.

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
and `profileInstanceId` UUIDs. Existing exact-request replay is checked before
looking up the current deployment, so deletion does not break recovery.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/profiles/:name/chequebook` | Read node balances and chequebook summary. |
| POST | `/profiles/:name/chequebook/deposit` or `/withdraw` | Submit `{ requestId, profileInstanceId, amount }`. An accepted or replayed result returns 202. Busy or conflicting identity returns 409 with the relevant operation. |
| GET | `/chequebook/operations` | Bounded history with optional profile filter and cursor. |
| GET | `/chequebook/operations/by-request/:requestId` | Recover the exact original request. |
| GET | `/chequebook/operations/:id` | Read the operation and its response evidence together. |
| POST | `/chequebook/operations/:id/check` | Request another evidence check with an empty body. |
| POST | `/chequebook/operations/:id/resolve` | Supply `{ transactionHash }` for verification. |
| POST | `/chequebook/operations/:id/assert` | Submit the recorded amount and exact duplicate-risk confirmation under D10. |

A busy response can name another operation. The browser must not attach that
operation to its own saved intent as though its submission succeeded. History
is available independently of the deployment page.

## Evidence and remaining acceptance

The local backend checkpoint `960c378` passed 634 manager tests, 261 shared
tests and workspace types. All 39 SQL regressions at that checkpoint subsequently
passed against a disposable PostgreSQL database, including retained response
evidence, pagination and atomic reads. These counts do not cover later edits.

Completion still requires deployment-instance regressions, durable browser
storage and two-tab tests, lost-response and account-change recovery, deleted
profile history, conflict display, T06 target ownership, T12 readiness integration
and final combined verification. Real-money testing is a separately authorized
T22 activity with Levi's pending D05 inputs and strict ownership of cleanup.

The historical 0.5 BZZ fill on the funded `review-20260907` deployment remains
unverified. Without transaction evidence, this document does not establish
whether it was submitted, whether it settled or whether a retry is safe.
