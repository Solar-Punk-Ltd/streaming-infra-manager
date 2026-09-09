# T20 continuation, 2026-09-09

Latest added SQL coverage,2026-09-09: include `engineConfigExplicitRestore.test.ts` from T01, using the existing owned `t01_test` setup, and the legacy metadata CAS file from T04b once its exact committed path and GREEN are accepted. Their initial missing-API REDs are specifications, not passing coverage. Current local validation runs remain serialized while workers share this machine. This does not by itself require serializing every CI job.

## Newly required local entrypoints

T09 adds `manager/test/integration/sshForwardSupervisor.test.ts`. This is a native Node parent-death fixture with synthetic children, no actual SSH. Invoke explicitly alongside localDockerUnix and preserve exact process/path cleanup checks. T01 adds `manager/test/database/operationHoldScope.test.ts` on T01_TEST_PG_PORT/t01_test once its GREEN is accepted.

T04b adds `manager/test/database/executionInventory.test.ts` using `T04B_TEST_PG_PORT` and `t04b_test`. Its read-only listing regression includes all unreleased states, deleted profiles and resolved or missing job holds. Capture/attribution and T09 SSH lifecycle regressions are synthetic ordinary manager unit files, with no actual SSH or Docker connection.

T11 adds `manager/test/database/engineSettingsVersionCapture.test.ts`, using `T11_TEST_PG_PORT` and `t11_test`. Its real publication/admission races are separate from the synthetic HTTP version-capture tests discovered by the ordinary manager unit glob.

T11 now includes `manager/test/database/engineSettingsJob.test.ts` alongside engineSettingsInstance on `T11_TEST_PG_PORT`/`t11_test`. T01 adds `engineConfigRecoveryHold.test.ts` on `T01_TEST_PG_PORT`/`t01_test`. These files exercise actual database ownership and recovery-record persistence, so skipping them cannot satisfy those guarantees.

T09 adds `manager/test/integration/localDockerUnix.test.ts`. Despite its directory, this is a local native Unix-socket test with synthetic Docker/Bee traffic, not a real deployment. Invoke it explicitly in the local checks without requiring a running manager or real Docker socket. It owns a temporary listener and verifies cleanup. The ordinary manager unit glob does not discover it. Keep the actual deployment integration suite's separate authorization and target preflight.

T11 adds `frontend/test/mock-chequebook-http.test.mjs` for authenticated offline uploader funding refusal and funded/external/pool controls. It must run explicitly alongside the existing mock HTTP entrypoints. It uses synthetic child-memory data and no Docker or Bee connection.

T01 adds `manager/test/database/deployAttemptAdmission.test.ts`, `rolloutPortTransaction.test.ts` and `engineConfigDeployClaim.test.ts`, using `T01_TEST_PG_PORT` and synthetic `t01_test`. The last suite covers the inactive atomic config/job/operation claim, with later descriptor and lifecycle suites still to follow. T04a adds `versionRemoval.test.ts`, using `T04A_TEST_PG_PORT` and `t04a_test`. T04b adds `buildJobOwnership.test.ts` and `deployFailureOwnership.test.ts`, using `T04B_TEST_PG_PORT` and `t04b_test`. T09 stream, Docker handshake and owned preparation tests are synthetic manager unit files and require no Docker connection. Their GREEN checkpoints do not qualify the actual Bee image.

T04b adds `manager/test/database/executionRoots.test.ts`, using T04B_TEST_PG_PORT and t04b_test. T09 adds `chequebookTargets.test.ts`, using T09_TEST_PG_PORT and t09_test. T11 adds actual `frontend/test/engine-observations-browser.test.mjs` with deadlines, obsolete responses and draft preservation. Its `manager/test/database/engineSettingsInstance.test.ts` uses T11_TEST_PG_PORT and t11_test and must be included. T10's integrationCleanupHttp unit test runs owned synthetic HTTP and is discovered by the ordinary manager unit glob. Real authenticated integration remains a later authorized run, not executed evidence.

## Earlier checkpoints, superseded where noted above

Latest required suite additions: T04b `migrationAdmission.test.ts`, `bundledShipmentPrune.test.ts` and `bundledArtifactMaterializer.test.ts` use `T04B_TEST_PG_PORT` and synthetic `t04b_test`. Root T10 `profileRemoval.test.ts` and `emptyGroupRemoval.test.ts` use `T10_TEST_PG_PORT` and `t10_test`. T11 `engineOverviewSnapshot.test.ts` uses `T11_TEST_PG_PORT` and `t11_test`. T11's `frontend/test/mock-engine-http.test.mjs` and `mock-engine-observations.test.mjs`, plus T09 `transfer-recovery-browser.test.mjs` and history entrypoints, are outside the ordinary src test glob and must be explicitly wired. These are local suites, not evidence of any GitHub workflow run.

Cross-provider review, OpenAI-hosted. The existing branch `fix/t20-ci-checks` is at `1eb7cdd`. It has no active worker or worktree at this checkpoint. Its workflow draft is partial. Main-v2 remains unchanged. No workflow has run on GitHub and no repository setting has changed.

## Required integration

Finish the corrected task dependencies before final workflow wiring. Core checks need common build, every package's types and unit suites, frontend build and the actual offline browser regressions. Native browser tests require an explicit Chrome path and must own their servers. Missing Chrome must be reported as unavailable, not silently counted as a passing browser check.

The SQL entrypoints now include synthetic databases `t01_test`, `t04a_test`, `t04b_test`, `t06_test`, `t08_test`, `t09_test`, `t10_test`, `t11_test` and `t12_test`, with their corresponding task-prefixed test-port variables. T04b owns publicationRevision and bundledShipments. T08 owns stackVersionApproval. T09 owns chequebookOperations and profileGenerations. T12 owns buildClaimPhase and deploymentPhase. Include inherited buildSnapshotClaim and portReservations suites. Preflight must connect to every configured database before invoking tests, since absent configuration otherwise produces skips. Discover final files from integrated branches before fixing the runner list.

The final Docker job needs actual entrypoints for T01 startup failure and T02 real SRS parser, plus the existing T03 OME admission gate and T05a shared-image race. T05a's later qualification must run Engine29.1.3 with Compose5.1.4. Printing versions alone is not a gate. No real-image build, pull, engine harness or host operation is authorized now. T10's production identity and cleanup guards must precede authenticated integration-client wiring.

T11 adds a mock-observation entrypoint that runs Node with tsx and development conditions. T09 adds native intent, controller, HTTP adapter, dialog, history and recovery browser suites plus journal mock tests. Do not rely on the older package test command to discover these automatically. Final acceptance must prove the workflow actually invokes them and reports unexecuted layers honestly.

## Existing action pins, partial provenance review

The three existing pins match their official release pages. As read on2026-09-09, all release dates are more than two weeks old. GitHub displays verified commit signatures for each, and also a verified tag signature for pnpm/action-setup. This is release/commit identity evidence, not a completed audit of their bundled dependencies.

| Existing pin | Official release evidence |
| --- | --- |
| actions/checkout `3d3c42e5aac5ba805825da76410c181273ba90b1` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),20 July, matching commit and GitHub verified signature |
| pnpm/action-setup `0977fd99725f1db4007ccb2928dbb4e90d06cc86` | [v6.0.10](https://github.com/pnpm/action-setup/releases/tag/v6.0.10),3 August, matching commit, verified commit/tag signatures and immutable-release indicator |
| actions/setup-node `820762786026740c76f36085b0efc47a31fe5020` | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0),14 July, matching commit, verified signature and immutable-release indicator |

No action version, package or lockfile changed during this review. Installed-tree signatures, registry provenance and malware checks are not established by the release pages and remain unverified here. Any introduced package or action version still requires the repository's applicable provenance checks. Do not describe the current workflow as ready on the strength of SHA pins alone.
