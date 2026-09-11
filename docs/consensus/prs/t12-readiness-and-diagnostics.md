# Make deployment readiness explain the current blocker

When the Bee node is unavailable or a deployment is changing state, the interface could show inconsistent next steps, stale Running labels and an invented startup estimate. This change makes the ordered checklist supply the headline and primary action. It shows timestamped Bee observations, distinguishes starting from restarting and exposes Logs on each container row.

Branch: `codex/t12-readiness-and-diagnostics`, reviewed checkpoint `2966ab3cd28239fe8cc3e29decb83d13e81b2edc`. Dependencies include T07 `24b85bf`, T11's initial correction `fba33b5` and T06 `b65f8d9`, which carries the reviewed T04a fixes. Local draft only.

## Behavior

- Checks run in order: containers, Bee API, funding, postage and uploader. A disabled uploader action explains that earlier readiness checks must pass. Existing containers stay running.
- Bounded health, readiness and optional chainstate reads distinguish unknown, initializing, unhealthy and unreachable. The browser expires observations 30 seconds after receipt using its monotonic clock. A refresh makes prior evidence stale immediately. No startup percentage or completion estimate is invented.
- Migration 021 persists starting or restarting with the profile transition. Legacy or uncertain transitions say Deploying. Stopping and removing are not called stopped. Running containers do not establish receiving, uploading or playback.
- The ordinary transition and immutable-build claim evaluate the same prior-status rule inside the atomic status update. Competing claims cannot reuse stale intent. A failed claim or reference write preserves the prior profile state.
- Per-container Logs opens the selected service. Observed engine state is labelled honestly while deployment state changes.

## Validation

The full handoff passed 507 manager tests, 262 shared tests, 17 frontend tests, 3 real PostgreSQL tests, 3 browser-helper tests, offline Chrome acceptance and workspace typechecking. Browser checks include both service logs, expiry, held and failed refreshes, navigation, reloaded transition intent and a slow sibling request. The final explanation correction has a test-first regression and all 7 focused readiness tests pass. That one-line copy change did not warrant repeating the full suite.

Pinned Bee v2.8.2 contract evidence, test commands and limitations are in `docs/testing/t12-readiness.md`. The initial readiness checkpoint's disposable database and browser processes were removed. No live service or funds were used.

The later T06 integration and build-claim correction passed 816 manager tests, 64 actual PostgreSQL tests, manager types and diff checks. Eleven focused phase tests include the new competing-claim, stale-snapshot, rollback and completion cases. RED `53d1724` had six failures and two controls passing before GREEN `2966ab3`. The worker retains its separately owned synthetic database for ongoing T04b integration. No deployment database was used.

## Remaining integration

The T04a/T06 phase-writer integration is complete in this branch. T09 still supplies transaction settlement and final money UI semantics. T11's newer literal/omitted source correction and the portable browser harness wiring remain aggregate obligations. This draft does not claim those integrations are complete.

The historical 0.5 BZZ fill remains unverified.
