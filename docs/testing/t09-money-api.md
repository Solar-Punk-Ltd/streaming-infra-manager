# T09 transaction API integration contract

This backend slice connects the durable transaction journal to authenticated routes. The frontend money flow still needs its corresponding request-ID, saved-history and recovery integration before aggregate acceptance. The existing frontend amount-only POST is intentionally rejected by the new contract. This local branch has not been deployed.

## Runtime trust and target selection

Two manager process settings are read at startup. They are not accepted from API requests, profile records or Bee responses.

- `CHEQUEBOOK_RPC_ENDPOINTS` is a JSON object keyed by supported chain ID, for example `{"100":"https://rpc.example.invalid"}`. Supported IDs are 1, 100 and 11155111, paired with the pinned token contracts in `transactionIdentity.ts`. Values must be HTTP or HTTPS URLs without user information or fragments. Route any real endpoint credential into the manager process through the existing secret mechanism. Do not paste it into a profile, source file, issue or log. The registry keeps endpoints private and checks the endpoint's actual chain ID before use.
- `CHEQUEBOOK_BEE_ENDPOINT_MODE=direct` is an operator assertion that the configured address leads directly to one Bee listener, possibly through connection-preserving Docker port mapping. It is not independent verification of the topology or Docker ownership. Missing, empty or `disabled` blocks new preparation and live Bee pending-list reads. Invalid mode or malformed registry configuration fails startup with a fixed configuration error.

An absent chain mapping refuses new preparation and records unavailable evidence during recovery. A wrong chain response cannot silently select another chain or endpoint. Frozen operation identity selects the trusted runtime mapping after profile deletion. Runtime endpoint rotation takes effect after process restart. This implementation does not write or rotate configuration.

The configured locator uses exactly one saved `bee-uploader` service and its `BEE_UPLOADER_API_PORT`, together with the profile's host. SSH `user@host` loses its user portion. Hostnames and SSH aliases are preserved for DNS. Local hosts follow the existing `BEE_LOCAL_HOST` behavior. The external publishing destination `bee_url` does not select the transaction target. Known deploy, stop and remove transitions refuse preparation. Missing or duplicate Bee services, malformed ports and profiles without an owned Bee component refuse it too.

The target revision includes the canonical T01 `profiles.instance_id`, profile creation/update timestamps, host, port slot, kind, components, status, stack version and selected API port. It is compared again before dispatch. The instance UUID identifies one deployment lifetime independently of timestamp precision. A saved name that is removed and recreated receives a different instance UUID. T06 current target and port-reservation integration is still required before aggregate acceptance. No second SSH or Docker ownership implementation was added here.

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
| POST `/profiles/:name/chequebook/deposit` | `{requestId, profileInstanceId, amount}` | `ChequebookAdmissionDetail` |
| POST `/profiles/:name/chequebook/withdraw` | `{requestId, profileInstanceId, amount}` | `ChequebookAdmissionDetail` |
| GET `/chequebook/operations` | Optional `limit`, `cursor`, `profileName` | `ChequebookHistoryPage` |
| GET `/chequebook/operations/by-request/:requestId` | Exact intent UUID | `ChequebookOperationDetail` |
| GET `/chequebook/operations/:id` | Saved operation UUID | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/check` | Empty object | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/resolve` | `{transactionHash}` | `ChequebookOperationDetail` |
| POST `/chequebook/operations/:id/assert` | `{amountPlur, confirmation}` | `ChequebookOperationDetail` |

New submissions require the current profile UUID as `profileInstanceId`. It is part of the immutable intent and journal record. Preparation compares it before opening Bee, admission locks the profile row and checks it in the same transaction as journal insertion, and preflight compares it again. Exact request replay still precedes current-profile lookup. A mismatched instance refuses a new intent with a fixed `chequebook_profile_changed` response. An unavailable profile cannot open a Bee session. A profile removed before admission also receives the fixed refusal. Migration 023 adds only nullable `chequebook_operations.profile_instance_id`. It depends on T01 migration 014 and never infers a historical value from a current same-name profile. Historical NULL values remain readable and recoverable.

Amounts are canonical positive integer PLUR strings, at most 30 digits. New transfer intent uses a UUID that the browser must persist before its POST. Repeated UUIDs replay the same intent and never prepare another transfer. A different payload under that key returns a conflict. The browser must use the read-only by-request route if it knows the UUID but lost the response containing the operation ID. No money POST is needed to discover that record, and no current profile is needed.

Accepted or replayed admission returns 202. It can contain a rejected or unknown operation and never implies settlement. A busy node or conflicting request payload returns 409 with the current operation detail. Reads and recovery operations return 200, missing records 404, invalid input 400, unavailable preparation or journal storage 503, and an ineligible assertion 409. Errors at the storage and preparation boundaries carry fixed safe messages. Upstream diagnostics and endpoint values are not attached as error causes.

History defaults to 50 rows and permits at most 100. It orders by immutable creation timestamp and UUID. The opaque cursor retains PostgreSQL microseconds so rows inside the same millisecond are not skipped. Detail reads obtain the operation and all direct-response evidence in one SQL statement. No profile join can remove historical records.

The shared detail shape contains `operation`, `responseEvidence` and `assertionConfirmation`. Admission also contains `kind`. The assertion text is produced by the one shared `chequebookAssertionConfirmation` helper. The exact amount and text must match the current operation. Only a current CAS-bound complete no-match observation can support an assertion. An assertion accepts the duplicate-payment risk. It does not prove absence or settlement.

## Recovery and evidence presentation

A known hash checks the chain receipt. An unknown or interrupted submission checks Bee pending hashes and the bounded chain scan. Manual resolution also verifies full transaction identity on the trusted chain. None of these paths sends or retries a Bee transaction.

The pending-list adapter opens a separate read-only pinned session and verifies that its fresh node, chain, chequebook and token match the frozen operation. It reads only pending hashes from Bee's v2.8.2 `pendingTransactions` response. Transaction identity comes from chain evidence. A missing profile, replaced node, disabled direct mode or unavailable Bee cannot be reported as an empty pending list. The chain scan can still discover a mined matching candidate, and known-hash or manual checks remain profile-independent. An unavailable pending list cannot qualify a pass as complete no-match evidence for assertion.

`attribution_conflict` must take display precedence, even when late evidence arrives after a previously settled or asserted state. The frontend must not render that old state as an unqualified verified settlement. Preserve and display all `responseEvidence`. When `additionalEvidenceInResponseJournal` is true, the bounded `candidateHashes` list is not exhaustive. Product copy should say that additional transaction evidence needs review. Do not expose storage terminology as the operator's explanation. No force-settlement or stronger-evidence override exists in this slice.

## Local verification limits

The adapter and API tests use injected state or disposable loopback HTTP servers. They do not touch a deployment, wallet, live RPC or Bee. The production composition uses the reviewed private connection, runtime registry and journal repository. Frontend behavior is unchanged in this slice.

Levi approved a dedicated disposable local PostgreSQL database on 2026-09-08. All 39 preexisting SQL regressions passed at `960c378`, including the four previously pending checks for unchanged 129-candidate progress, a full 256-candidate conflict with response evidence, sub-millisecond history pagination and atomic conflict detail. The database uses synthetic data in fresh per-test schemas, a random loopback port, the cached `postgres:16-alpine` image and no alternate worker database. The new profile-instance checks cover name reuse with identical timestamps, recreation before admission, exact replay after deletion and historical NULL identity. After the reviewed T01 dependency merge, all 43 SQL cases passed, including the four new instance checks. The full manager suite passed 666 tests, the common package passed 269 tests, and all workspace typechecks passed.

The funded `review-20260907` deployment is preserved. The historical 0.5 BZZ fill remains unverified. This work provides no evidence that it was unsent, settled or safe to retry.
