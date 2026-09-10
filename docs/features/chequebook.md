# Chequebook funding and transfer recovery

A Bee node's wallet and chequebook are different balances. A deposit moves BZZ
from the node's wallet into its chequebook. A withdrawal moves it back. The
manager presents these transfers as recorded operations whose outcome must be
checked from transaction evidence. A balance change cannot confirm a transfer.

Status, 2026-09-10. Everything on this page is on the branch
`feat/ai-remediation`, at commit `6dc33d1`, which is pull request #40 into
`main-v2`. It carries the journal, receipt recovery, the durable browser
workflow, history, the account and instance guards, the owned transport factory
and the automatic receipt polling. New submission preparation captures T06's SQL
target proof and uses one qualified Docker and Bee connection. Local Unix and
supervised SSH adapters are implemented, but the production qualification
catalog is empty, and acquisition refuses without a matching qualified record.
Actual SSH and exact-image qualification have not run. Nothing on this branch
has been deployed, and no transfer has been made with real money.

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
| `submitted` | A transaction hash was recorded. Mining and finality are not yet established. The manager checks the chain for its receipt about every 20 seconds while the operation's `receiptPollUntil` deadline is ahead. Three kinds of `submitted` row are never checked automatically: one with no deadline, which is every operation recorded before this behaviour existed, one whose deadline has passed, and one whose failure reason is `hash_conflict`. |
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

An operation that enters `submitted` gets one polling budget of 30 minutes,
written to `receiptPollUntil` at that moment. While the budget lasts the manager
asks the chain for the receipt about every 20 seconds, and the page showing the
operation re-reads the saved record every 10 seconds so the outcome appears
without a click. A settled or reverted receipt ends the polling by changing the
state.

The gap between checks grows when the chain endpoint stops answering. One pass
takes at most 20 operations and each one waits out the receipt inspector's own
timeout, so a pass during a complete outage can take about five minutes instead
of a few seconds. Nothing is lost by that, the budget is still the same 30
minutes and the page says the checks are about every 20 seconds and longer while
the endpoint does not answer.

The budget is never renewed. Nothing an operator does extends it, a restart
resumes only the operations whose budget has not passed, and every operation
recorded before this behaviour existed keeps an empty deadline and is never
polled. When the budget ends without a final receipt the operation stays
`submitted` with its last observation, the page says that automatic checks
ended, and Check remains the operator's own action, exactly as before. The page
holds itself to that same budget from its own side. It never re-reads a record
for longer than 30 minutes after that record last changed, whatever deadline the
record carries. An operation in `submitting` or `unknown` is never polled:
recovery stays explicit. An operation whose failure reason is `hash_conflict` is
never polled either, whatever deadline its row still carries, and the page shows
no automatic checking sentence for it.

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

**The composition is exercised whole, and only the Bee, the chain and the
database are synthetic.** `manager/test/database/chequebookConnected.test.ts`
signs in over HTTP, goes through the real router behind the real session and
same-site gates into a real PostgreSQL journal, out over the owned Docker
transport to a synthetic Bee, and reads the outcome back.
`frontend/test/transfer-connected-browser.test.mjs` does the same with the
browser as the only client, against that manager run as a forked process. Both
need a disposable PostgreSQL on `T09_TEST_PG_PORT` and skip out loud without it,
and the browser runner treats a silent skip as a failure.

**The rest of the suites.** Three database files cover this feature:
`chequebookConnected`, `chequebookOperations`, which holds the polling
behaviour, and `chequebookTargets`. Nine browser suites cover the durable
intent, the dialog, the history, the recovery actions, the two API surfaces, the
fixture and the polling itself. The unit suites cover the poller, the receipt
check, the receipt inspector, the routes, the schemas, submission, recovery and
the qualification catalog. All of them pass on a laptop, and all of them are in
the jobs the checks workflow declares for a pull request. The last full run
recorded on the branch, taken at `e857994`, is in
[../handover/main-v2-remediation.md](../handover/main-v2-remediation.md). No job
of that workflow had run on a GitHub runner when this page was written.

**What the tests cannot establish.** They exercise protocol and ownership code
against a synthetic Bee. They do not qualify a real Bee image, they do not open
a real SSH connection, and they move no money.

**The production qualification catalog is empty.**
`PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` in
`manager/src/domain/chequebook/beeBridgeQualification.ts` is a frozen empty
list, and a unit test pins it that way. Acquisition refuses a transport with no
matching qualified record, so on a real host this feature does nothing until a
recorded qualification run puts an entry there. A synthetic pass qualifies
nothing and must never be used to populate it.

**What completion still requires.** The exact immutable-image bridge
qualification and an actual SSH qualification, both of which need a host and
have not run. Real-money testing is a separately authorised T22 activity, which
waits for Levi's D05 numbers and keeps strict ownership of cleanup.

The historical 0.5 BZZ fill on the funded `review-20260907` deployment remains
unverified. Without transaction evidence, this document does not establish
whether it was submitted, whether it settled or whether a retry is safe.
