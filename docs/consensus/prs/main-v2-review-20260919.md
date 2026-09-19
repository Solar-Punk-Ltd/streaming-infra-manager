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

The final combined server run is pending. Real PostgreSQL regressions and the complete browser suite still need the repository's existing PR checks. The shared verification mapping does not provision this repository's nine task databases, so those checks are not represented as passing.

## Limits

Remote execution copies are conservatively retained when there is no trustworthy mount reader, which can increase disk use. No live infrastructure behavior was exercised or changed. The streaming-stack pin, dependencies and repository settings are unchanged. The separate swarm-hls PR 241 remains outside this batch.
