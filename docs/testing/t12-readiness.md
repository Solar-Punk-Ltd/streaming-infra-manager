# T12 readiness evidence

The checklist orders container state, node funding, postage and uploader prerequisites. Its first incomplete step supplies the detailed headline and the primary action. A running container is not evidence of receiving, uploading or playback.

## Bee probe contract

The adapter follows the pinned Bee v2.8.2 source:

- [Health handler](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/health.go) reports the probe status, version and API version.
- [Readiness handler](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/readiness.go) answers ready with HTTP200 or notReady with HTTP400.
- [Probe statuses](https://github.com/ethersphere/bee/blob/v2.8.2/pkg/api/probe.go) distinguish ok and nok.

Neither probe supplies startup percentage or an estimated completion time. The interface displays no estimate. Valid block and chainTip values from the node's optional chainstate response are observations, not a computed percentage or evidence that uploads succeed.

The manager reads the three endpoints concurrently. Each response has a three-second maximum deadline including its body and a 64 KiB body limit. Other HTTP results, malformed payloads and partial probe evidence remain unknown. Failed network connections remain separate from the node explicitly reporting unhealthy. API ready requires both valid health and readiness responses.

## Deployment intent

Migration 021 persists starting or restarting in the same database update that claims DEPLOYING. RUNNING becomes restarting. STOPPED and a new direct DEPLOYING insert become starting. ERROR and legacy rows have no known phase and display Deploying. The phase describes manager intent only. Terminal and error writes clear it. Group members are inserted STOPPED and receive their phase when subsequently claimed.

T04a and T06 add a separate direct claim in PostgresBuildLedger. Integration must apply and test the same prior-status rule there before T12 acceptance is complete.

## Validation and remaining integration

- Frontend unit tests cover first-blocker/action agreement, missing observations, no playback claims, starting and restarting after serialization, and stopping/removing summaries.
- Isolated PostgreSQL tests cover new insertion, concurrent conditional claims, reload, terminal/error clearing and interrupted transitions.
- Bee adapter tests use loopback HTTP servers to cover healthy plus notReady, ready plus valid block counts, malformed and partial observations, explicit unhealthy, network failure, bounded bodies and timeouts.
- Direct container Logs actions require a browser interaction check. Node-only selection tests cover Bee-only profiles and a selected container different from the engine. Node SSR rendering is unsuitable for the current MUI package resolution and is not claimed as passing.
- T09 supplies the later transaction settlement wording and money UI integration. This branch does not modify money submission or balance settlement code.
