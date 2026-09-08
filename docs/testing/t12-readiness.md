# T12 readiness evidence

The checklist orders container state, the Bee API observation, node funding, postage and uploader prerequisites. Its first incomplete step supplies the detailed headline and the primary action. A running container is not evidence of receiving, uploading or playback.

## Bee probe contract

The adapter follows the pinned Bee v2.8.2 source:

- [Health handler](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/health.go) always returns HTTP 200 with the probe status, version and API version, including when the reported probe status is nok.
- [Readiness handler](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/readiness.go) answers ready with HTTP 200 or notReady with HTTP 400.
- [Probe statuses](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/probe.go) distinguish ok and nok.

Neither probe supplies startup percentage or an estimated completion time. The interface displays no estimate. Valid block and chainTip values from the node's optional chainstate response are observations, not a computed percentage or evidence that uploads succeed.

The manager reads the three endpoints concurrently. Each response has a three-second maximum deadline including its body and a 64 KiB body limit. Other HTTP results, malformed payloads and partial probe evidence remain unknown. Failed network connections remain separate from the node explicitly reporting unhealthy. API ready requires both valid health and readiness responses.

## Freshness

The browser records its monotonic clock when the readiness response arrives. An observation expires after 30 seconds from that receipt, even when sibling wallet or stamp requests finish later. The server-reported observation timestamp stays visible as evidence. It is not compared with the browser wall clock, which may be ahead or behind.

A refresh immediately clears the balances, stamp list and chain state used by the checklist. The prior node observation stays visible as stale while the request runs. Unknown, initializing, unhealthy, unreachable and stale remain distinct. The page already remounts by deployment name, so a newly opened deployment starts with no observation. A new uploader action requires current funding, stamp and Bee API evidence. Existing containers are left running.

## Deployment intent

Migration 021 persists starting or restarting in the same database update that claims DEPLOYING. RUNNING becomes restarting. STOPPED and a new direct DEPLOYING insert become starting. ERROR and legacy rows have no known phase and display Deploying. The phase describes manager intent only. Terminal and error writes clear it. Group members are inserted STOPPED and receive their phase when subsequently claimed.

T04a and T06 add a separate direct claim in PostgresBuildLedger. Integration must apply and test the same prior-status rule there before T12 acceptance is complete.

## Validation and remaining integration

- Frontend unit tests cover first-blocker/action agreement, missing observations, no playback claims, starting and restarting after serialization, and stopping/removing summaries.
- Isolated PostgreSQL tests cover new insertion, concurrent conditional claims, reload, terminal/error clearing and interrupted transitions.
- Bee adapter tests use loopback HTTP servers to cover healthy plus notReady, ready plus valid block counts, malformed and partial observations, explicit unhealthy, network failure, bounded bodies and timeouts.
- The isolated Chrome test opens both Bee and SRS logs from their container rows and verifies the requested service. It checks expiry, an in-flight reload, a failed reload, initialization, navigation and page reloads with starting, restarting and unknown deployment intent. It also verifies that a slow wallet response cannot extend an earlier probe observation. Node-only selection tests cover Bee-only profiles. Node SSR rendering is unsuitable for the current MUI package resolution and is not claimed as passing.
- T09 supplies the later transaction settlement wording and money UI integration. This branch does not modify money submission or balance settlement code.

## TDD checkpoints

The source is the agreed T12 issue and consensus document under the root repository's `.scratch/main-v2-review-consensus/`. The journeys are finding the next prerequisite, diagnosing Bee initialization, opening the correct container logs, and identifying current versus previous observations during deployment changes.

| Behavior | RED commit | GREEN commit | Evidence |
|---|---|---|---|
| Headline, ordered checklist and primary action agree | cdcc064 | fbab0de | Four initial frontend regression cases |
| Starting and restarting survive a reload and an atomic claim | 6fbe698 | f8872ee | Three PostgreSQL cases and three frontend cases |
| Stopping and removing are not called stopped | d369bc9 | f5c3727 | Readiness summary regression |
| Logs select the requested container | 8521f21 | 3135308 | Selection test plus later browser interaction |
| Bee readiness needs bounded, recognized probe evidence | 86c8f41 | aaf5c8b | Five loopback HTTP cases |
| Old observations expire and no estimate is invented | 3eb50ea | db29876 | Clock-injected frontend cases and checklist coupling |
| Unsynchronized server clocks do not reject a new response | 6b802d1 | 3ce7104 | Ahead and behind clocks plus browser slow-sibling case |
| Engine cards do not reuse a green Running claim during deployment | 08a313e | b6cf856 | Browser assertion failed on the old Running pill and passed on State not checked |

The missing-module or missing-export failures in the first, logs and initial freshness tests were intentional missing-interface RED evidence. The PostgreSQL and later browser failures executed the old behavior. The first attempted Node SSR Logs test could not load the existing MUI dependency shape and was replaced with real-browser coverage.

Commit 8702ccb introduced passing browser acceptance coverage. Its message uses the word reproduce, but the stronger navigation assertion was already GREEN. The keyed page remount already clears observations across deployment names. This commit is not claimed as a RED or as a navigation fix.

## Final checks

- Manager: 507 tests passed with `DATABASE_URL=postgres://unused node --import tsx --conditions=development --test --test-concurrency=2 test/unit/**/*.test.ts`.
- Common: 262 tests passed with `node --import tsx --test src/**/*.test.ts`.
- Frontend: 17 tests passed with `node --import tsx --conditions=development --test src/uploaders/beeReadiness.test.ts src/deployments/*.test.ts`.
- Browser transport helper: three tests passed with `node --test test/support/chrome-protocol.test.mjs`.
- Browser acceptance: passed with `node --test test/readiness-browser.test.mjs`, including the final stale engine assertion.
- PostgreSQL: three tests passed with `T12_TEST_PG_PORT=<isolated loopback port> DATABASE_URL=postgres://unused node --import tsx --conditions=development --test test/database/deploymentPhase.test.ts`. The test database was disposable and has been removed.
- All workspace typechecks and `git diff --check` passed.

Scoped Node coverage reports 97.06 percent line and 96.61 percent branch coverage for the new Bee probe module. The new frontend observation, deployment phase and Logs selection helpers together report 96.30 percent line and 90 percent branch coverage. These are scoped helper results, not whole-project or browser coverage claims.

The browser test copied the existing T18 Chrome helper at 9187429 into its own tree. It uses a separate headless profile, a dynamic loopback Vite port and an API fixture without any upstream proxy. Non-GET fixture requests and off-origin browser requests are rejected and asserted absent. Only exact owned processes and temporary profiles are cleaned up. The final Chrome PID and its debug port, Vite port and PostgreSQL port were verified gone after testing.

No host, live Bee node, wallet, chain RPC or GitHub surface was used. The earlier 0.5 BZZ fill remains unverified and is outside this row.
