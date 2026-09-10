# T09 transaction API integration contract

**Status, 2026-09-10.** This work is on the branch `feat/ai-remediation`, at commit `6dc33d1`, which is pull request #40 into `main-v2`. The sections below are in the order they were built and each is the checkpoint it says it is. Target ownership integration is done: `createChequebookOperationsService` builds the production preparation from `PostgresChequebookTargetOwnership.capture`, so an admission on a real database gets the proof rather than failing closed. The last section, "Bounded receipt polling and connected acceptance", is the current state. Nothing on this branch has been deployed.

The durable transaction journal is connected to authenticated routes and to the saved-intent, history and recovery UI.

## Frozen target repository checkpoint

Migration 026 adds nullable `chequebook_operations.submission_target`. Historical NULL values are never filled from a current same-name profile. History, exact request replay and chain recovery remain available after deletion. A row without target proof cannot claim dispatch.

`PostgresChequebookTargetOwnership.capture` reads one coherent SQL ownership proof. It contains the canonical profile instance, operator and engine-config revisions, kind, components, host, slot, stack version and stable status. It also contains the alias, daemon, exact microsecond verification timestamp and one active TCP Bee API reservation with its persistent ID. The reservation must name `bee-uploader` as its only held service. The daemon inventory must be seeded and that project must have no unresolved deploy attempt. The proof contains no runtime endpoint or secret. Cached container ports are not consulted.

Admission copies this proof before its first wait. Exact request replay precedes proof validation. New admission and dispatch both recheck ownership under the money chain and node locks, then allocation, daemon-attempt, profile, alias and reservation locks. The dispatch update happens while those locks remain held. Ownership refusal leaves the journal unclaimed. A lost claim acknowledgement never authorizes another POST.

That checkpoint proved SQL ownership only, and at it the direct locator did not supply the proof, so new admissions on a real database failed closed. The owned transport factory closed that, and the production composition now passes the capture into preparation. Container-bound preparation and full-container inspection on its private connection came with it. The exact-image bridge qualification is still required and has not run: `PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` is a frozen empty list. No Docker inspection or network call runs inside these SQL transactions. A later immutable transport must keep an already-claimed send on the original container even if ownership changes after commit.

The merged dependency baseline passed all 47 prior T09 SQL cases. The target checkpoint adds 31 cases for stale identity and alias verification, exact reservation ownership, both sides of ownership locks, attempt admission, caller mutation, historical NULL, lost dispatch acknowledgement and a one-connection pool. Refusal reads use the same checked-out client after rollback so they cannot wait for their own connection to be released. All evidence uses a dedicated synthetic PostgreSQL database, never a Bee or deployment.

## Runtime trust and target selection

Two manager process settings are read at startup. They are not accepted from API requests, profile records or Bee responses.

- `CHEQUEBOOK_RPC_ENDPOINTS` is a JSON object keyed by supported chain ID, for example `{"100":"https://rpc.example.invalid"}`. Supported IDs are 1, 100 and 11155111, paired with the pinned token contracts in `transactionIdentity.ts`. Values must be HTTP or HTTPS URLs without user information or fragments. Route any real endpoint credential into the manager process through the existing secret mechanism. Do not paste it into a profile, source file, issue or log. The registry keeps endpoints private and checks the endpoint's actual chain ID before use.
- `CHEQUEBOOK_BEE_ENDPOINT_MODE=direct` is an operator assertion that the configured address leads directly to one Bee listener, possibly through connection-preserving Docker port mapping. It is not independent verification of the topology or Docker ownership. Missing, empty or `disabled` blocks new preparation and live Bee pending-list reads. Invalid mode or malformed registry configuration fails startup with a fixed configuration error.

An absent chain mapping refuses new preparation and records unavailable evidence during recovery. A wrong chain response cannot silently select another chain or endpoint. Frozen operation identity selects the trusted runtime mapping after profile deletion. Runtime endpoint rotation takes effect after process restart. This implementation does not write or rotate configuration.

The configured locator uses exactly one saved `bee-uploader` service and its `BEE_UPLOADER_API_PORT`, together with the profile's host. SSH `user@host` loses its user portion. Hostnames and SSH aliases are preserved for DNS. Local hosts follow the existing `BEE_LOCAL_HOST` behavior. The external publishing destination `bee_url` does not select the transaction target. Known deploy, stop and remove transitions refuse preparation. Missing or duplicate Bee services, malformed ports and profiles without an owned Bee component refuse it too.

The target revision includes the canonical T01 `profiles.instance_id`, profile creation/update timestamps, host, port slot, kind, components, status, stack version and selected API port. It is compared again before dispatch. The instance UUID identifies one deployment lifetime independently of timestamp precision. A saved name that is removed and recreated receives a different instance UUID. T06 current target and port-reservation integration was still required when this section was written, and it is in. No second SSH or Docker ownership implementation was added here.

## Single-connection submission

A fresh transfer opens one private HTTP session. Its Agent permits exactly one connection creation and refuses every replacement socket. It does not follow redirects or retry requests. Identity reads, final preflight and the one POST share that socket. This provides a connection boundary only for the direct topology described above. It cannot pin a signer behind a layer-7 request-routing proxy.

Preparation requires agreement between `/addresses`, `/wallet` and `/chequebook/address`. The wallet must identify a supported chain, the same node and the same chequebook. The registry reads a latest start block, reads the transaction-count lower bound at that explicit block number, then checks the numbered block hash again. The lower bound does not reserve a nonce.

The durable operation is admitted before the POST. Under its node guard, the adapter checks the target revision, fresh identity, positive native balance and sufficient direction-specific BZZ funds. A nonzero native balance is only a gas precondition, not a guarantee that gas is sufficient. Bee or the chain can still refuse execution. The dispatch claim is committed before the single send. A closed connection during or after that claim remains an unknown outcome. A request that may have sent POST bytes is never retried.

Preparation and preflight each have a 30-second overall deadline. The pinned session expires 30 seconds after creation if dispatch has not started. HTTP reads have 10-second limits. The single POST has a 180-second limit. Responses are limited to 64 KiB. Every preparation failure, rejection, replay after preparation, claim failure, response-journal failure and completed submission disposes the session. The early request-ID lookup happens before target lookup or connection creation.

## Authenticated routes and shared shapes

The shared `SessionInfo` returned by `GET /auth/session` includes the existing numeric account `id`, username, admin flag and expiry. The browser uses that stable account ID to scope saved intents across sessions. It is not a session token or a new authorization rule.

All routes remain behind the existing session gate. Writes retain the existing same-site request header requirement. The submitting and asserting identity is `user:<signed-in-user-id>`, derived by the server. The body cannot select an actor, chain, contract, RPC endpoint or Bee endpoint. Unknown body or query fields are rejected.

| Method and path | Input | Result |
| --- | --- | --- |
| GET `/profiles/:name/chequebook` | Profile name | Existing balance summary |
| POST `/profiles/:name/chequebook/deposit` | `{requestId, profileInstanceId, expectedAccountId, amount}` | `ChequebookAdmissionDetail` |
| POST `/profiles/:name/chequebook/withdraw` | `{requestId, profileInstanceId, expectedAccountId, amount}` | `ChequebookAdmissionDetail` |
| GET `/chequebook/operations` | Optional `limit`, `cursor`, `profileName` | `ChequebookHistoryPage` |
| GET `/chequebook/operations/by-request/:requestId` | Exact intent UUID | `ChequebookOperationDetail` |
| GET `/chequebook/operations/:id` | Saved operation UUID | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/check` | `{expectedAccountId}` | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/resolve` | `{transactionHash, expectedAccountId}` | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/assert` | `{amountPlur, confirmation, expectedAccountId, expectedRevision}` | `ChequebookOperationDetail` |

Every submission includes the saved positive safe-integer account ID as `expectedAccountId`. The route compares it with the authenticated user before any preparation, journal access or Bee action. A different session account receives the fixed 409 `account_changed` refusal. This field cannot choose the actor. Returning to the original account permits exact request replay even after profile deletion.

Recovery writes also require `expectedAccountId`, checked before service or journal access. This is the account that reviewed the recovery action. Any currently authenticated operator may recover another operator's saved operation under the existing authorization policy. A switched account returns fixed 409 `account_changed` and asks the operator to review the action again under the current account. These request preconditions are not stored as assertion evidence.

New submissions require the current profile UUID as `profileInstanceId`. It is part of the immutable intent and journal record. Preparation compares it before opening Bee, admission locks the profile row and checks it in the same transaction as journal insertion, and preflight compares it again. Exact request replay still precedes current-profile lookup. A mismatched instance refuses a new intent with a fixed `chequebook_profile_changed` response. An unavailable profile cannot open a Bee session. A profile removed before admission also receives the fixed refusal. Migration 023 adds only nullable `chequebook_operations.profile_instance_id`. It depends on T01 migration 014 and never infers a historical value from a current same-name profile. Historical NULL values remain readable and recoverable.

Amounts are canonical positive integer PLUR strings, at most 30 digits. New transfer intent uses a UUID that the browser must persist before its POST. Repeated UUIDs replay the same intent and never prepare another transfer. A different payload under that key returns a conflict. The browser must use the read-only by-request route if it knows the UUID but lost the response containing the operation ID. No money POST is needed to discover that record, and no current profile is needed.

Accepted or replayed admission returns 202. It can contain a rejected or unknown operation and never implies settlement. A busy node or conflicting request payload returns 409 with the current operation detail. Reads and recovery operations return 200, missing records 404, invalid input 400, unavailable preparation or journal storage 503, and an ineligible assertion 409. Errors at the storage and preparation boundaries carry fixed safe messages. Upstream diagnostics and endpoint values are not attached as error causes.

History defaults to 50 rows and permits at most 100. It orders by immutable creation timestamp and UUID. The opaque cursor retains PostgreSQL microseconds so rows inside the same millisecond are not skipped. Detail reads obtain the operation and all direct-response evidence in one SQL statement. No profile join can remove historical records.

The shared detail shape contains `operation`, `responseEvidence` and `assertionConfirmation`. Admission also contains `kind`. The assertion text is produced by the one shared `chequebookAssertionConfirmation` helper. The assertion request also supplies the revision from the complete detail the operator reviewed. It is a canonical nonnegative decimal string within the PostgreSQL bigint range. `ChequebookRecovery` compares it with the final loaded operation, and assertion admission compares it again atomically. Either mismatch returns fixed 409 `operation_changed`. Only assertion CAS throws this typed error. Receipt and scan observation CAS behavior is unchanged. The reviewed revision and account precondition never become assertion evidence. The exact amount and text must match the current operation. Only a current CAS-bound complete no-match observation can support an assertion. An assertion accepts the duplicate-payment risk. It does not prove absence or settlement.

## Recovery and evidence presentation

A known hash checks the chain receipt. An unknown or interrupted submission checks Bee pending hashes and the bounded chain scan. Manual resolution also verifies full transaction identity on the trusted chain. None of these paths sends or retries a Bee transaction.

The pending-list adapter opens a separate read-only pinned session and verifies that its fresh node, chain, chequebook and token match the frozen operation. It reads only pending hashes from Bee's v2.8.2 `pendingTransactions` response. Transaction identity comes from chain evidence. A missing profile, replaced node, disabled direct mode or unavailable Bee cannot be reported as an empty pending list. The chain scan can still discover a mined matching candidate, and known-hash or manual checks remain profile-independent. An unavailable pending list cannot qualify a pass as complete no-match evidence for assertion.

`attribution_conflict` must take display precedence, even when late evidence arrives after a previously settled or asserted state. The frontend must not render that old state as an unqualified verified settlement. Preserve and display all `responseEvidence`. When `additionalEvidenceInResponseJournal` is true, the bounded `candidateHashes` list is not exhaustive. Product copy should say that additional transaction evidence needs review. Do not expose storage terminology as the operator's explanation. No force-settlement or stronger-evidence override exists in this slice.

## Local verification limits

The adapter and API tests use injected state or disposable loopback HTTP servers. They do not touch a deployment, wallet, live RPC or Bee. The production composition uses the reviewed private connection, runtime registry and journal repository. Frontend behavior is unchanged in this slice.

Levi approved a dedicated disposable local PostgreSQL database on 2026-09-08. All 39 preexisting SQL regressions passed at `960c378`, including the four previously pending checks for unchanged 129-candidate progress, a full 256-candidate conflict with response evidence, sub-millisecond history pagination and atomic conflict detail. The database uses synthetic data in fresh per-test schemas, a random loopback port, the cached `postgres:16-alpine` image and no alternate worker database. The new profile-instance checks cover name reuse with identical timestamps, recreation before admission, exact replay after deletion and historical NULL identity. After the reviewed T01 dependency merge, all 43 SQL cases passed, including the four new instance checks. The full manager suite passed 666 tests, the common package passed 269 tests, and all workspace typechecks passed.

The funded `review-20260907` deployment is preserved. The historical 0.5 BZZ fill remains unverified. This work provides no evidence that it was unsent, settled or safe to retry.

## Terminal conflict admission checkpoint

A new intent is refused when the node has an active operation or any historical operation with `failure_reason='hash_conflict'`. The repository checks this under its existing node admission lock. Exact request replay still happens first. Historical state, response evidence, hash ownership and any newer active operation are preserved. This change does not reopen a historical row or alter the partial unique index.

A fresh GET alone cannot guarantee that its evidence stays current until the next POST. The authenticated SQL/API regression holds a terminal GET, commits conflicting direct-response evidence, releases the older response, then attempts a new intent. Admission returns 409 busy with the conflict detail and no new record or Bee dispatch. A separate SQL case covers exact replay and an unaffected node. The older attribution regression now admits B before the late conflict on A, preserving its intended historical-competitor case under the stronger admission rule.

The new regression failed before the fix as `admitted` instead of `busy`, and the HTTP case returned 202 instead of 409. After the fix all 45 T09 PostgreSQL cases, 669 manager unit tests and workspace typechecks passed. The synthetic database was container `dbb1a1d59df09b3d2dd6fe095473437abc2fbab1f380c900e41691db27aa0941`, loopback port 49809. It was stopped after verification and exact-ID inspection confirmed removal. No host, live chain or funded node was used.

## Reviewed recovery action preconditions

Recovery check, manual resolution and assertion require the account that reviewed the action. A mismatch refuses the write before service access, while preserving the existing policy that any authenticated operator can recover saved operations. Assertion additionally requires the exact reviewed revision, checked at the final recovery load and again by the repository under its existing operation lock. A same-account competing assertion or newer conflict returns the fixed changed-operation response. Request-only account and revision values do not enter the assertion audit record.

The focused coordinator and authenticated HTTP suite passes 21 tests. All 47 PostgreSQL tests pass, including same-account concurrent assertions and conflicting direct-response evidence between the final load and assertion CAS. The full manager suite passes 675 tests, the shared package passes 269 tests, and workspace typechecks pass. No checks use real funds or a deployment. The dedicated synthetic PostgreSQL container was `0519d196ae73b99e0aab3bfae1ba4e2774cd7978a992e95bcd025a581c448271` on loopback port 52292. It was stopped after the checks and exact-ID inspection confirmed removal. History and recovery UI integration was the next slice when this was written, and it is in.

## Bounded receipt polling and connected acceptance

Migration 031 adds nullable `chequebook_operations.receipt_poll_until`, checked
so a deadline cannot exist without a transaction hash. `ChequebookOperation`
carries it as `receiptPollUntil`. The repository writes it in exactly the three
statements that move a row into `submitted`, namely `recordSubmission` with a
submitted outcome, candidate adoption in `recordRecovery` and `resolveCandidate`,
and each of those keeps an existing value rather than replacing it, so a budget
is opened once and never renewed. A receipt check, a manual check, a second
response on a conflicted row and an assertion all leave it alone. Historical
rows keep NULL and are never polled.

`RECEIPT_POLL_BUDGET_MS` is 30 minutes, `RECEIPT_POLL_INTERVAL_MS` is 20 seconds
and `RECEIPT_READ_INTERVAL_MS` is 10 seconds, all exported from
`common/src/chequebookOperations.ts` so the manager and the page quote the same
numbers. The repository takes `{ receiptPollBudgetMs }` so a test can use a
short budget.

`listAwaitingReceipt({ intervalMs, limit })` returns the rows the poller owes a
check: `submitted`, hash known, not `hash_conflict`, deadline still ahead, and
last checked longer ago than one interval, oldest check first.
`ChequebookReceiptPoller` runs one batch at a time through the existing
`ChequebookReceiptCheck`, schedules the next tick after the batch ends rather
than from its start, catches a journal failure on one row and carries on, stops
between rows once it has been told to stop, and writes at most one log line per
tick naming operation ids and observation kinds only.
`ChequebookOperationsService.start()` starts it, `shutdown()` stops it before the
transports close, and `index.ts` starts it right after the service is created. A
restart resumes the rows whose budget has not passed and adopts no others,
because the query is the only thing that decides what is due.

The poller's log is the manager's own `Logger`, supplied by
`createChequebookOperationsService`. A tick that changed something is an
information line, a journal the poller could not read is a warning line reading
"Receipt polling could not read the transfer journal." A test supplies its own
recorder through `receiptPolling.log`. The factory hands the poller two bound
calls, `listAwaitingReceipt` and `check`, and not the objects behind them.

A check that sees exactly the observation the row already holds refreshes
`receipt_checked_at` only. It leaves `revision` and `updated_at` where they are,
under the same compare-and-set. A check whose observation differs, including a
`could_not_check` whose history cursor moved, writes as before and advances the
revision. This matters to the operator rather than to the poller: the recovery
actions are keyed on the revision and refuse when it moved, and a poll every 20
seconds that sees the same pending answer would otherwise refuse most Check
presses made while polling runs.

`manager/test/database/chequebookConnected.test.ts` is the connected acceptance
suite. It composes the production `createChequebookOperationsService` over a
real PostgreSQL schema, the real router behind `requireSameSite` and the real
session gate, and the owned Docker transport over a temporary Unix socket served
by `manager/test/support/syntheticDockerBee.ts`. Only the Bee, the chain and the
database are synthetic. Its ten cases cover an accepted deposit polled to
settlement with no Check request, a reverted receipt, a lost response that stays
unknown and unpolled and blocks the next intent, an RPC outage that polling
survives, a spent budget that leaves the chain to the operator, a restart that
resumes a live budget and adopts nothing after it, exact replay, a start that
fails partway and leaves no schema behind, a close that finishes every step
before reporting the first failure, and the removal of the temporary socket
directory. The composition itself lives in
`manager/test/support/connectedChequebook.ts` and is shared with
`connectedChequebookServer.ts`, the process the connected browser suite forks.
Both refuse to run unless the API is on loopback and the synthetic Docker is on
its own socket inside a directory only this user can read.

Run it with the disposable database:

```
docker run --rm -d --name t09-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55436:5432 postgres:16-alpine
docker exec t09-pg psql -U postgres -c 'CREATE DATABASE t09_test'
cd manager && T09_TEST_PG_PORT=55436 DATABASE_URL=postgres://postgres@127.0.0.1:55436/t09_test \
  ./node_modules/.bin/tsx --conditions=development --test 'test/database/chequebook*.test.ts'
docker stop t09-pg
```

A file whose variable is unset skips silently, so read `# skipped 0` in the
summary as well as `# fail 0`.
