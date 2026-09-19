# Fix deployment cleanup, credential privacy, authentication and UI state

Partial redeploys could remove files still mounted by a running engine. Profile responses exposed custom RPC keys, and an overlapping sign-in could survive password rotation. This batch fixes those failures and six related control-panel and monitoring findings from the cross-provider review, OpenAI-hosted, of `main-v2` at `a5b42539`.

| Finding | Priority | Result |
| --- | --- | --- |
| F01 | P1 | Cleanup retains execution copies used by containers and keeps them when Docker observations are uncertain. Unresolved deployment attempts prevent retirement. |
| F02 | P1 | Public profiles, groups and events expose endpoint presence and host only. Private reads preserve the exact saved URL for deployment. Unrelated edits keep it, and replacement or source changes work without sending it back to the browser. |
| F03 | P1 | Session admission and password replacement compare the verified credential under the same user row lock. Stale sign-ins and competing password changes are refused. Throttle reservations settle on error paths. |
| F04 | P1 | Recreating a deployment under the same name discards the removed node's wallet address immediately. |
| F05 | P2 | Uploader startup guidance follows D15 and D16. Low balance and an unreachable node warn, while proven unusable postage still refuses. |
| F06 | P2 | ABR readiness includes the uploader's runtime health after its pool configuration. |
| F07 | P2 | Passphrase rotation refreshes the publish URL. Obsolete responses are ignored, and Copy stays disabled while the current URL is incomplete. |
| F08 | P2 | Session revocation closes active and pending command-output streams without cancelling accepted deployments or builds. |
| F09 | P2 | Host traffic comes from the host init process's network view. Missing readings remain unavailable, and recovery resets the rate baseline. |

## Validation

Each finding has a regression that failed before its fix. Focused checks passed for execution retention, endpoint privacy, authentication, command streams, readiness, ABR health, wallet replacement, passphrase rotation and host traffic. The UI checks include real Chrome fixtures.

Independent Astra review covered the production corrections. Review also caught and closed a backslash URL disclosure and an incomplete-copy interval. The first five-fix candidate passed the server build, typechecks, unit suites and native transport suites. Later combined runs caught an unused import and three incomplete test fixtures, all corrected in separate commits.

A combined server run passed build and typechecks, then found eight outdated test setups after the private RPC projection changed. Those setups are corrected. All 34 focused cases in the affected suites pass, including a new refusal for a historical job that never owned its deployment.

The PR's first run passed build, typechecks, unit and native checks. Its database job ran all 547 tests with no skips. The new controlled lock-order test was the only failure, with PostgreSQL reporting `55P03` on the profile row while cleanup waited for daemon admission. The reviewed correction now takes the daemon lock before the profile lock, matching engine configuration admission.

Verification completed on 2026-09-19 at `e88581a42483e8caf7fa6a3ca41b5492a8b74f1e`. [Run 35440997869](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35440997869) passed build and typechecks, 3,422 unit tests, seven native transport tests, 547 PostgreSQL tests across 36 suites, and 261 browser-suite tests across 34 files. All 4,237 tests passed with zero failures and zero skips. The lock-order regression passed after the correction. The existing PR workflow supplies the nine disposable PostgreSQL databases and complete browser suite that the shared verification mapping does not provision.

## Copilot follow-up

All three comments were verified. Comment `4053142114` exposed a P1 gap where
URL userinfo could become public host metadata. The projection now strips the
complete userinfo and returns null for an empty host, while preserving the
stored private endpoint. A real PostgreSQL regression reproduced the exposure
in [run 35442940317](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35442940317).
Its six synthetic cases cover profile and group responses, updates and private
reads. Comments `4053142123` and `4053142127` identified stale pending statements.
The verification records now name the completed run and exact commit above.

## Limits

Remote execution copies are conservatively retained when there is no trustworthy mount reader, which can increase disk use. No live infrastructure behavior was exercised or changed. The streaming-stack pin, dependencies and repository settings are unchanged. The separate swarm-hls PR 241 remains outside this batch.
