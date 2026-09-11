# main-v2 review consensus and remediation roadmap

Status: needs-triage

Review label: **cross-provider review, OpenAI-hosted**

Date: 2026-09-07

Document revision: consensus-13 (Fable round 6 and OpenAI round 7 approve the exact recorded set)

Document state: **Planning consensus complete. Fable round 6 and OpenAI round 7 approve all 25 rows of the exact task set in Fable round 6 section 3. The consensus exit checklist is complete. D01 through D10 are decided. Open outside planning consensus: Levi's D04/D05 inputs, the 0.5 BZZ fill's evidence and T05a's later isolated harness on Engine 29.1.3 and Compose v5.1.4. Implementation and live acceptance are not complete or authorized by this document-only round.**

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager

Reviewed manager baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64

Live site: https://streamtestinfra.swarmens.limo/#/

Live streaming-stack versions observed: bundled at ee99c36 and main-v3 at ec3063f. The manager's deployed build SHA was not independently exposed by the UI.

Participants: OpenAI-hosted Codex and Fable, with Levi relaying between their sessions. Fable round 1 was added on 2026-09-07 by Fable 5.1 (Anthropic, `claude-fable-5-1`).

## Purpose and scope

Agree on a roadmap, implementation tasks and acceptance criteria that address the complete review. This is a shared working document, not a declaration that either reviewer's first answer is correct.

The operator should be able to create a deployment, establish funding and storage, publish, watch, change configuration and stop it without an older operation undoing their intent. The UI must distinguish what is configured, what is actually running and what has been verified.

Levi explicitly authorized creating this document and debating its contents. This task is planning and consensus work. Implementation, commits, repository settings, external posts and live financial actions are not authorized by this document itself. Earlier review-only restrictions remain in force outside the document work Levi requested.

Every finding must end with an agreed task, an evidence-backed correction, or an explicit open decision. Do not silently remove a finding or label work unnecessary. A change of scope, supported capacity, spending or retention belongs to Levi. Technical implementation choices can be settled by the reviewers when they preserve the requested behavior.

This repository uses local Markdown issues under .scratch. After agreement, the task catalog below can become separate numbered issue files under this feature's issues directory. This round creates only the shared PRD.

## Evidence and current test state

Evidence labels used below:

- **Live:** observed through the deployed application's UI.
- **Probe:** exercised actual application functions or services with isolated collaborators. These probes did not reproduce the complete Docker or database environment. Their outcomes were recorded in the OpenAI conversation, not saved as executable test files.
- **Static:** a source-level failure path. It still needs a regression test or targeted reproduction.
- **Unresolved:** an observation whose cause has not been established.
- **Code:** a call path traced in the source at the reviewed baseline, with file and line. (Added by Fable round 1.)
- **Local:** reproduced on Fable's machine, Docker 29.7.2 and Compose v5.5.1, which shows the mechanism and not the host's own Compose version. (Added by Fable round 1.)

Completed verification in the OpenAI review:

- 261 common tests passed.
- 341 manager tests passed across 31 selected files.
- Type checks passed for common, manager and frontend.
- Shell syntax checks passed for the firewall generator and stack-version build script.
- Fifteen manager test files that write fixtures or construct checkouts were excluded from the read-only pass. These counts are not a full-suite pass.
- The full live integration suite was not run. Its HTTP helper also lacks the current authentication contract, recorded as R10.
- No application source changes or issue posts were made during the review.
- No root STATE.md or CONTEXT.md was found during preparation of this round. The existing domain-document references should be reconciled under T21, without inventing missing history.

Live test state at handoff:

- OpenAI created review-20260907 on main-v3 at ec3063f, slot 4. It has its own Bee node and SRS. The uploader is held back because no postage stamp is set.
- Invalid SRS syntax was refused. A valid custom file persisted. Resetting to the version template worked.
- The test's engine settings were restored to defaults. The generated configuration was verified to contain max_connections 1000, hls_fragment 0.5 and hls_window 15.
- Levi funded the Bee node. Its last observed wallet balance was 5 BZZ and approximately 0.0999 xDAI. The chequebook was empty.
- A form for a 0.5 BZZ chequebook fill was prepared. Submission was handed to Levi. It had not been observed as submitted at the last check. Recheck before any subsequent action.
- The funded node is **not disposable**. Do not remove the deployment or its data as test cleanup without Levi deciding what happens to its funds and identity.
- Existing livetest-stream, livetest-viewer and v3-config-test deployments were not modified.
- The existing viewer loaded and decoded part of a 91-second 1280 by 720 recording. Playback repeatedly paused near four seconds in this browser. That is a partial result, not a proven player defect or a sustained-playback pass.
- Fresh publishing, stamp purchase, the chequebook transfer, full stop/start, group lifecycle and ABR publishing remain unverified live.

Host facts recorded on 2026-09-07 (**Live**, run by Levi from his own terminal over ssh, read-only, after Fable round 4, recorded by Fable):

- Docker Engine on 157.90.34.105: `29.1.3`, from `docker version --format '{{.Server.Version}}'`.
- Compose inside the manager's api container, which is what every deploy script runs: `v5.1.4`, from `docker compose -f /home/solarpunk/streaming-infra-manager/manager/docker-compose.yml exec -T api docker compose version`, confirmed by `docker exec manager-api-1 docker compose version`.
- Fable's R04 reproduction ran on Engine 29.7.2 and Compose v5.5.1, the same major lines. T05a's harness runs against v5.1.4, and the api image's pin starts from that value. Neither reading is a claim about any other host.

## Finding register and traceability

Priority is provisional. P1 means OpenAI recommends fixing it before relying on the affected workflow. P2 is a correctness or reliability issue. P3 is a usability improvement. Fable should challenge both the diagnosis and the priority.

| ID | Finding and evidence limit | OpenAI priority | Task |
| --- | --- | --- | --- |
| R01 | A configuration watcher can restore an older configuration and start an engine after newer intent. A probe restored old content and called startDeploy for a stopped deployment. Failed recreate also skips automatic rollback. | P1 | T01 |
| R02 | Concurrent SRS checks share srs.conf.check before the deployment reservation. An isolated race let an invalid request be checked against the other request's valid content. | P1 | T02 |
| R03 | Version update mutates the checkout before build success. The existing-deployment resolver accepted both building and failed states in a probe. The full live update/recreate race was not triggered. | P1 | T04 |
| R04 | Shared Docker image names may undermine concurrent deployment isolation. The source uses shared names and per-deployment up --build calls. Actual Compose image-resolution behavior under a race remains to be demonstrated. | P1, subject to reproduction | T05 |
| R05 | The firewall generator's maximum of 100 does not stop bundled slot 101 using RTMP 11012, which the generated rung-peer rules allow. The manager still permits bundled slots through 999. Generated-rule output confirmed the allowance. | P1 | T06 |
| R06 | General editing validates the old deployment state, then stores and deploys the new stamp and Bee settings. A service probe demonstrated old-stamp validation and new-stamp persistence. The dedicated stamp-selection route is a separate path. | P1 | T07 |
| R07 | A changed default version loses its tested flag but remains automatically selectable. Bundled refresh changes its SHA without clearing approval. Probes and source support the finding. | P2 | T08 |
| R08 | OME's regular-expression check accepts malformed XML. Multiple roots and bare ampersands were accepted by probes. The editor overstates use of the engine's parser. Required streaming elements need verification against each supported version. | P2 | T03 |
| R09 | Transfer settlement is inferred from total-balance changes. Probes show that cashouts can resemble withdrawals or hide deposits. Submission errors return to a retryable form even when acceptance could be uncertain. | P2, money-handling risk | T09 |
| R10 | The integration HTTP helper sends no session cookie or required request header. Source inspection shows it cannot exercise the protected API as documented. | P2 | T10 |
| R11 | At a glance showed 1.5-second segments and a 22.5-second window while the effective live config and engine card showed 0.5 and 15. | P2 | T11 |
| UX01 | The wizard defaults to the host passphrase even when the host has none. Unencrypted ingest is then the default path. Observed live. | P2 | T13 |
| UX02 | An invalid name displayed Looks good while Continue was disabled. Observed live. | P3 | T16 |
| UX03 | Bee startup used a generic one-minute estimate during a much longer funding and chain-history initialization flow. Logs showed progress that the page did not. | P2 | T12 |
| UX04 | Needs a stamp remained the headline while funding or node initialization was the immediate blocker. Observed live. | P2 | T12 |
| UX05 | The selector for Bee logs was inside the SRS engine's Logs dialog. It works, but the entry point hides deployment-wide diagnostics. | P3 | T12 |
| UX06 | SRT and Bee peer ports were presented as HTTP links. Observed live and supported by ContainersCard. | P3 | T17 |
| UX07 | An ABR uploader with no local pool defaults to an external-pool form, without a path to create the prerequisite while keeping the draft. Observed live. | P2 | T15 |
| UX08 | Version actions extended outside the visible table at the available 723px panel width. A requested phone-width override did not take effect, so a 390px test was not completed. | P3 | T18 |
| UX09 | Notes use the full deployment-edit path and its deployment preflight. This can couple metadata edits to unrelated stamp or funding failures. It does not prove that every notes edit restarts an unchanged container. | P2 | T19 |
| UX10 | During recreation, Publish described the deployment as stopped while the engine card could still show Running. Observed live. | P3 | T12 |
| UX11 | Stamp entry exposes PLUR per chunk and depth without a guided capacity, lifetime and cost choice. This is a product improvement proposal, not a claim that raw entry is defective. | P3 | T14 |
| Q01 | No checked-in CI workflow was found and the reviewed main-v2 branch was unprotected. | P2 | T20 |
| Q02 | Stack-version documentation says phases are unimplemented even though the corresponding features exist. Some domain-document references are also stale or missing. | P2 | T21 |
| Q03 | The paid and sustained-streaming E2E checks remain unfinished. Some live lifecycle paths were inspected only through their forms. | Verification obligation | T22 |

Source anchors at the reviewed baseline:

- R01 and R02: [EngineConfigService.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/engineConfig/EngineConfigService.ts:123) and [engineConfigCheck.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/engineConfig/engineConfigCheck.ts:106).
- R03: [stack-version-build.sh](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/scripts/stack-version-build.sh:79) and [DeploymentOrchestrator.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:158).
- R04: [docker-compose.yml](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/docker-compose.yml:62) and [deploy.sh](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/scripts/deploy.sh:550).
- R05: [firewall-rules.sh](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/deploy/host/firewall-rules.sh:44) and [ProfileService.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ProfileService.ts:244).
- R06: [ProfileService.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ProfileService.ts:335).
- R07: [PostgresStackVersionRepository.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/versions/PostgresStackVersionRepository.ts:104) and [versionForNewDeployment](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ProfileService.ts:389).
- R08: [omeXml.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/engineConfig/omeXml.ts:29).
- R09: [chequebook.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/common/src/chequebook.ts:346) and [MoveBzzDialog.tsx](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/uploaders/MoveBzzDialog.tsx:275).
- R10: [integration helpers](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/test/integration/helpers.ts:74) and [server gates](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/api/server.ts:68).
- R11: [engineText.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/deployments/engineText.ts:22).
- UX: [wizardState.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/forms/wizard/wizardState.ts:145), [PassphraseChoice.tsx](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/forms/wizard/steps/PassphraseChoice.tsx:14), [checklist.ts](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/deployments/checklist.ts:135), [ContainersCard.tsx](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/deployments/ContainersCard.tsx:76) and [NotesCard.tsx](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/deployments/NotesCard.tsx:6).
- Q02: [stack-versions.md](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/docs/features/stack-versions.md:3).

## Proposed roadmap

This order expresses dependencies, not a reduction of scope. All tasks remain included. Tasks without a listed dependency can be worked on independently. Estimates should follow Fable's review of the required changes, not be invented now.

| Phase | Outcome | Tasks | Exit condition |
| --- | --- | --- | --- |
| 0. Establish trustworthy evidence | An authenticated test harness, regression scenarios and a precise target inventory | T10, evidence work for T01 through T09, initial T20 setup, T22 preflight definition | Each disputed mechanism has a reproducer or a bounded investigation. Tests cannot accidentally target existing deployments. |
| 1. Preserve operator intent and deployment identity | Configuration changes, versions, ports and preflight checks behave correctly under failure and concurrency | T01 through T08 | Relevant failure and concurrency tests pass. No stale operation overwrites newer intent. No start uses an incomplete build or an unintended image. |
| 2. Make funding and readiness reliable | Transaction results and operational status match observed state | T09, T11, T12, T13, T19 | Money movement is reconciled by transaction identity. Cards agree on effective settings and the next actionable blocker. |
| 3. Make setup and navigation understandable | Guided storage and ABR flows, accurate validation, useful links and usable tables | T14 through T18 | The walkthrough and accessibility checks pass without removing advanced or group capabilities. |
| 4. Verify the complete result and maintain it | Authenticated regression checks, live acceptance evidence and current documentation | T20 completion, T21, T22 | Every finding is accounted for. Required checks pass on the final SHA. Live results and remaining limits are explicit. |

Money-handling acceptance must be implemented and verified before calling the paid workflow complete. The existing staged live test is evidence gathering, not proof that the current behavior is safe in every failure case.

## Task catalog

All tasks start at **needs-triage**. They become ready-for-agent only after both reviewers agree on the task and acceptance criteria, and any decision that changes its behavior is resolved. Split independent fixes into separate commits during implementation. Do not combine unrelated UI and backend fixes merely because they share a phase.

### T01. Give engine configuration rollouts explicit ownership

Source: R01. Priority: P1. Dependencies: none.

Track the configuration revision and operation that own the health watch. Rollback must acquire ownership before writing anything. Define what happens when recreation fails, inspection fails or the manager restarts during the watch.

Acceptance criteria:

- Applying A, then applying B, cannot let A's delayed watcher replace B or recreate B's container.
- Stop during the watch remains stopped. Reset during the watch remains reset. Removal cannot be undone by a delayed watcher.
- A failed recreate restores the previous usable configuration when recovery can be completed. If recovery also fails, the UI reports both failures and the exact remaining state.
- A rejected ownership claim changes neither the database nor configuration files.
- Controlled-clock tests cover competing watchers and late callbacks. A container-backed test verifies failed startup and recovery. The UI distinguishes checking, applied and recovery failed.

### T02. Isolate every SRS validation request

Source: R02. Priority: P1. Dependencies: none.

Use a unique input file per validation request and preserve the identity of the validated content through persistence.

Acceptance criteria:

- Concurrent valid and invalid requests for one deployment each validate their own content. The invalid request is refused.
- One request's cleanup cannot remove another request's input. Success, refusal, timeout and cancellation all clean up their own resources.
- Passing validation does not bypass the deployment reservation. Only the winning revision is stored.
- A regression test controls the interleaving and a real SRS parser check confirms the result for distinct directives.

### T03. Validate OME XML and describe validation honestly

Source: R08. Priority: P2. Dependencies: coordinate with T01.

Use real XML parsing and verify the integration requirements of each supported stack version. Do not turn a suspected LLHLS requirement into a universal rule without checking the engine and uploader contract.

Acceptance criteria:

- Multiple roots, invalid entities and malformed attributes are refused before recreation. Valid comments, CDATA and supported XML forms remain accepted.
- Required webhook and streaming elements are validated in their relevant locations according to the version's actual contract.
- The editor accurately distinguishes SRS parser validation, OME structural validation and subsequent runtime checks.
- If a dependency is introduced, its exact versions receive the repository's publish-age, signature/provenance, installed-signature and malware checks. Record any missing provenance.

### T04. Make version updates atomic and identify the running build

Source: R03. Priority: P1. Dependencies: none. Coordinate with T05 and T08.

Build into a new immutable artifact or checkout. Publish it only after successful validation. Keep the last usable build available. Distinguish the version selected for the next deployment from the build currently running.

Acceptance criteria:

- A failed update leaves the previous usable build intact and accurately identified.
- Starting or recreating a deployment during an update cannot consume a partially changed tree or mixed source and build output.
- Updating a version alone does not restart its existing deployments. Their displayed running SHA remains accurate until a successful explicit rollout.
- Overlapping update and configuration operations have a defined outcome, with no silent fallback to the bundled version.
- Update-failure and concurrent-recreate tests assert the actual script/artifact identity, not only a ready status flag.

### T05. Prove and fix isolation of built Docker images

Source: R04. Priority: provisional P1. Dependencies: settle artifact identity with T04.

First reproduce or refute the shared-tag race using the actual supported Compose behavior. Inspect both the bundled stack and the exact main-v3 deployment contract. A build mutex limited to the version service is not evidence that deployment image creation is serialized.

Acceptance criteria:

- Two concurrent deployments from different source SHAs run their intended image IDs and contents.
- Two viewers using the same source SHA but different build-time stream addresses each retain their intended configuration.
- If a race is confirmed, immutable image identities include the source revision and relevant build inputs, or one demonstrably sufficient host-level build-and-create lock covers every competing path.
- Existing deployments and rollback targets keep usable images. Cleanup does not delete referenced artifacts.
- If the diagnosis is refuted, retain the test and record the exact Compose version and mechanism that guarantees isolation. Do not silently remove R04.

### T06. Align allocation, port contracts and firewall exposure

Source: R05. Priority: P1. Dependencies: decision D01 if a capacity restriction is proposed.

Evaluate actual port and protocol collisions across supported versions. The firewall and allocator must agree on which endpoints may be public. Merely rejecting a firewall argument above 100 is insufficient.

Acceptance criteria:

- The bundled slot-101 RTMP case cannot become public because a rung-peer allowance covers the same number.
- New allocations reject physical collisions across versions, services and applicable host/protocol combinations, including group creation and concurrent reservations.
- Boundary cases 99, 100 and 101, occupied slots and mixed-version placements have regression coverage.
- Firewall tests evaluate the whole generated policy. A permitted public peer endpoint does not implicitly permit an administrative or media endpoint on the same host port.
- Existing deployments are inventoried before migration. No existing deployment is silently renumbered, stopped or assigned a reduced capacity claim.

### T07. Validate the proposed deployment state before changing it

Source: R06. Priority: P1. Dependencies: none. Coordinate with T19.

Construct the full proposed state, validate its stamp and Bee target, then reserve and persist that same revision. Apply the same rule to group edits and other paths that change deployment inputs.

Acceptance criteria:

- An invalid old stamp can be replaced by a valid new stamp through general Edit.
- A valid old stamp cannot authorize an invalid replacement or a different unchecked Bee target.
- Refused edits preserve database state, environment files and running containers.
- Competing edits cannot deploy one request's configuration after validating another request's state.
- Group edits have a documented all-or-partial outcome. Tests prove the chosen behavior and accurate reporting for every member.

### T08. Bind tested approval and default selection to a build

Source: R07. Priority: P2. Dependencies: T04.

Approval must name the reviewed commit or artifact. An update cannot transfer approval to a new build or silently make an untested build the automatic selection.

Acceptance criteria:

- Changing the SHA clears approval for the replacement, including the bundled version. Rebuilding the identical approved artifact does not arbitrarily lose valid approval.
- The wizard does not silently fall back to the first untested ready version when its default becomes unavailable.
- Preserve the last approved default artifact where supported. Otherwise show that no approved default is available and require an explicit choice.
- A stale Tested click cannot approve a newer SHA that arrived after the page was rendered.
- Tests cover default update, bundled refresh, same-SHA rebuild and update/approval races.

### T09. Reconcile money movement by transaction identity

Source: R09. Priority: P2, with financial acceptance required before declaring this flow complete. Dependencies: authentication support from T10 for integration coverage.

Track an operation and its transaction hash through submission, confirmation, failure and recovery. Aggregate balances are useful corroboration, not sufficient proof that a particular transfer settled.

Acceptance criteria:

- A peer cashout cannot mark a pending withdrawal successful. A cashout cannot hide confirmation of the deposit's own successful transaction.
- A rejected or reverted transaction is shown as failed. A transaction without enough evidence remains explicitly unknown or pending.
- A lost response after acceptance cannot cause an automatic duplicate transfer on retry. If the underlying API cannot identify the accepted transaction, require reconciliation before another submission of that operation.
- Refresh, navigation and manager restart do not erase the identity of an unresolved submitted operation.
- Tests cover concurrent balance movements, dropped responses, delayed and reverted receipts, repeat requests and node outages without using real funds.

### T10. Repair the authenticated integration-test client

Source: R10. Priority: P2, first-phase foundation. Dependencies: none.

Add explicit test-session setup, cookie handling and the required request header. Keep test credentials out of output and route them through the approved mechanism.

Acceptance criteria:

- Protected lifecycle requests work through the actual authentication and request-origin middleware.
- Missing or expired sessions and missing request headers are separately tested and refused with the intended status.
- Setup fails clearly when prerequisites are absent. A skipped suite is never reported as a passing integration run.
- Mutating tests require an explicitly selected test target, use a unique run namespace and clean up only resources they created. They refuse to treat the funded review deployment as disposable.
- The integration README and commands match the current application.

### T11. Use one source of effective engine settings

Source: R11. Priority: P2. Dependencies: none.

Use backend-resolved settings in every summary and editor. Preserve the distinction between a stored override and a version or host default.

Acceptance criteria:

- For the observed main-v3 defaults, the engine card, At a glance, editor help and generated config agree on 0.5 and 15.
- An explicit override followed by clearing it returns every surface to the correct effective default.
- Host overrides, bundled defaults and supported OME settings have meaningful regression coverage.
- If an arbitrary custom config prevents reliable inference, show that the value is controlled by the file instead of inventing an effective value.

### T12. Make readiness and diagnostics explain the current blocker

Source: UX03, UX04, UX05 and UX10. Priority: P2. Dependencies: T07, T09 and T11 where their results are displayed.

Distinguish waiting for funding, chain initialization, API failure, missing stamp, insufficient chequebook, uploader readiness and active publishing. Put deployment-wide diagnostics where the operator can find them.

Acceptance criteria:

- Headline, checklist and primary action agree on the first actionable blocker.
- Startup shows supported progress or a truthful unknown state, with freshness information. It does not keep promising completion within a minute without evidence.
- Bee and other container logs are directly discoverable from the deployment or relevant container row.
- Deploying is not described as stopped. Old observations are identifiable while a new state is being established.
- Running containers do not, by themselves, establish receiving, uploading or playable status. Tests cover missing and stale observations as well as success.
- Any change to fail-open behavior for unknown funding prerequisites follows D02. No automatic shutdown of existing streams is introduced implicitly.

### T13. Give new SRT deployments a safe default

Source: UX01. Priority: P2. Dependencies: D03 only for policy beyond the minimum correction.

Generate a per-deployment passphrase by default when no host-wide passphrase exists. Describe the effective encryption state plainly.

Acceptance criteria:

- A new SRS stream and ABR uploader on a host without a shared passphrase do not default to unencrypted ingest.
- Review and Publish agree on the selected encryption state.
- Existing deployment credentials are not changed by this work. Generated values stay out of logs and test transcripts.
- If unencrypted ingest remains supported, selecting it is an explicit, accurately described choice. A broader removal of that capability requires Levi's decision.

### T14. Add a guided stamp purchase flow

Source: UX11 and the requested flow improvements. Priority: P3. Dependencies: T09 and T12. Spending defaults require D04.

Explain storage capacity, expected lifetime, price and gas before purchase. Keep the current expert inputs available.

Acceptance criteria:

- The guided view maps a capacity and lifetime choice to the exact depth and per-chunk amount used by the existing API.
- It shows the resulting BZZ cost, known gas requirement and estimate uncertainty before submission.
- Unavailable or stale prerequisites do not look like a confirmed quote. Insufficient funds and insufficient lifetime have specific corrective guidance.
- No new spending default is assumed. Any accepted maximum spend is enforced in the submission path, not merely displayed as a warning.
- Expert entry remains available, with validation and cost/lifetime feedback based on the same calculations.

### T15. Connect ABR prerequisites and clarify resource categories

Source: UX07 and the categorization proposal. Priority: P2. Dependencies: T12.

Explain multiple-quality publishing before requiring knowledge of ABR pools. Let an uploader draft lead into creating its missing pool and return afterward. Present Streams, Viewers and Storage pools clearly, with Groups as an organizational view.

Acceptance criteria:

- Choosing an ABR uploader with no local pool explains the prerequisite and offers a route to create one without losing the uploader draft.
- Returning from pool setup selects the intended compatible pool and shows any remaining funding or stamp blockers.
- External pools, custom deployments and all existing group capabilities remain available.
- A walkthrough can identify which resources ingest, store and play a stream without decoding component names.
- Fable and OpenAI agree on the navigation mapping. Any proposal to remove or substantially change a user-facing capability is surfaced to Levi instead of silently adopted.

### T16. Make validation feedback consistent and accessible

Source: UX02 and observed form-label weaknesses. Priority: P3. Dependencies: none.

Acceptance criteria:

- Invalid names never display Looks good. The field explanation and disabled action use the same validation result.
- Name, notes, pool and relevant settings inputs have programmatically associated labels and errors.
- Keyboard operation and focus after a failed submission or step transition work predictably.
- Regression coverage includes invalid names, duplicate names and malformed pool input through the actual form.

### T17. Render endpoints according to their protocol and audience

Source: UX06. Priority: P3. Dependencies: T06's contract representation where needed.

Acceptance criteria:

- SRT and Bee peer endpoints are not HTTP hyperlinks.
- Browser links are reserved for appropriate HTTP or HTTPS endpoints. Non-browser endpoints have useful copy controls and protocol labels.
- Administrative, internal and public endpoints are distinguishable. The UI does not imply that an intentionally private port should open from the operator's browser.

### T18. Keep version information and actions usable in narrow layouts

Source: UX08. Priority: P3. Dependencies: T04 and T08 for accurate version state.

Acceptance criteria:

- At 723px and a verified phone-width viewport, version identity, state and actions are usable without an undiscoverable offscreen action column.
- Contract detail can be expanded without overwhelming the main row. Any remaining horizontal scrolling is evident and keyboard usable.
- Long names, error messages and building states do not hide the current default or tested status.
- Visual evidence records the actual viewport dimensions. A failed viewport override does not count as mobile coverage.

### T19. Save deployment notes without a deployment job

Source: UX09. Priority: P2. Dependencies: coordinate candidate-state handling with T07.

Acceptance criteria:

- A notes-only change does not build images, write deployment environment files or start a deploy job.
- It can be saved when a stamp is invalid or a node is unfunded, subject to the normal permission and record-existence checks.
- A mixed notes and configuration edit still follows the validated configuration workflow.
- Concurrent metadata and configuration edits preserve both accepted changes or return a clear conflict, without silently losing notes.

### T20. Add repeatable checks and an agreed merge gate

Source: Q01 and the overall verification gap. Priority: P2. Dependencies: T10 and the new regressions. Branch settings require D06.

Acceptance criteria:

- CI runs the intended type checks, unit regressions and meaningful frontend checks on the final change.
- A separate documented environment exercises Docker-backed behavior and authenticated integration coverage without production credentials or unsolicited paid transactions.
- Skips and unavailable environments are visible. CI success does not imply unexecuted live or paid checks passed.
- Required branch checks, direct-push policy and any exceptions are recorded with Levi's decision before repository settings are changed.
- Introduced dependency versions receive the provenance checks required by the repository's instructions.

### T21. Reconcile documentation with the agreed implementation

Source: Q02. Priority: P2. Dependencies: the relevant completed tasks.

Acceptance criteria:

- Stack-version docs accurately distinguish implemented behavior, remaining planned work and owner decisions.
- Engine configuration docs describe real validation and recovery guarantees. Funding docs describe real transaction states.
- Test setup, commands, authentication and cleanup boundaries match the current harness.
- STATE.md and CONTEXT.md references are investigated for moves or deletion before creating anything. Stale references are corrected without fabricating history.
- Every agreed task has a local issue entry or a traceable completion record. One logical fix remains one commit during implementation.

### T22. Complete a controlled live E2E acceptance run

Source: Q03 and Levi's original request. Priority: required acceptance. Dependencies: relevant fixes and T10. Funds, publishing input and cleanup require explicit prerequisites under D05.

Acceptance criteria:

- Record the manager SHA, streaming-stack SHA, Docker image identities, target host and exact test resources. Record what else is running.
- Before publishing, verify connectivity, gas, wallet funds, chequebook floor, stamp usability/lifetime/capacity and host resources. An unmet prerequisite prevents the paid test from starting.
- Capture the complete available service-health and metrics surface before and after the run, compare the whole result and record limitations. Do not present a throughput benchmark from a resource-bound test.
- Exercise create, edit, custom configuration refusal/application/recovery, reset, stop/start and viewer handoff. Verify the state after each operation, including page reload and event-stream reconnection.
- Verify the actual chequebook transaction and stamp purchase, then publish identifiable fresh test content and play that same content through the intended viewer. Record a bounded duration and continuity criteria before the run.
- Exercise group creation/edit/resize and the ABR pool/uploader/viewer path using authorized isolated resources. Assert the intended stream identity and quality outputs, not just container status.
- Investigate the earlier playback pauses in a supported browser. Keep browser-environment limitations separate from product failures.
- Cleanup follows an agreed inventory and funds plan. Preserve the funded review node until Levi decides its disposition. Required human transaction or credential steps are explicit, not reported as automated passes.

## Open owner decisions

These are recommendations for discussion, not decisions already made by Levi. Fable should first narrow the choices and their effects. Technical work that does not depend on them can proceed once implementation is separately authorized.

| ID | What Levi would decide | OpenAI recommendation | Affected tasks |
| --- | --- | --- | --- |
| D01 | Whether any interim restriction of advertised bundled capacity is acceptable while allocation and firewall policy are repaired | Prefer actual collision-aware allocation and exposure rules. Do not silently replace the advertised 999-slot capability with a 100-slot limit. If a temporary refusal is necessary, state exactly which placements are affected and obtain the capacity decision. | T06 |
| D02 | Whether an operator may explicitly start a new uploader while a critical funding prerequisite cannot be verified | Recommend that unverified critical prerequisites prevent a new paid-start acceptance result. If a runtime override is wanted, define it explicitly. Keep existing-running behavior separate and do not introduce automatic shutdown by inference. | T07, T12, T22 |
| D03 | Whether unencrypted SRT remains an expert option, and whether shared host passphrases remain the default when present | Minimum correction is generated credentials when the host has none. Do not change existing credentials or remove an existing mode without a decision. | T13 |
| D04 | Desired guided stamp presets and any monetary limits | Present a quote without a preselected spend. Ask for the operator's required capacity/lifetime and enforce any chosen spending ceiling. | T14 |
| D05 | Live test spending ceiling, publishing input, resource retention and disposition of remaining funds | Reuse and preserve the funded review node. Define the test duration and spending cap before further paid testing. Decide funds recovery before deletion. | T22 |
| D06 | Required branch checks, direct-push policy and exceptions for main-v2 | Recommend required type, regression and integration checks appropriate to the agreed release process. Do not change repository settings during the debate. | T20 |

### Decisions taken by Levi, 2026-09-07

Recorded by Fable from Levi's message "as recommended on all", given after a plain-language summary of D01 through D10 with the recommendations both reviewers had agreed on in OpenAI round 4. The recommendations above and in the rounds stay as history. This table is what was decided and what it unblocks. Two decisions still need numbers from Levi and are marked.

| ID | Decided | Unblocks |
| --- | --- | --- |
| D01 | Every version is capped at slot `min(version maximum, 100)`. The cap counts every stored deployment record, stopped ones included. | The cap part of T06. |
| D02 | A new uploader start is refused when its node does not answer the stamp or chequebook check, with a retry action. Running uploaders and engine-only recreates are untouched. | The refusal in T07 and T12. |
| D03 | The wizard generates a passphrase when the host has none, keeps the host-wide passphrase as the default when one exists, and keeps unencrypted ingest as an explicit expert choice with its warning. Existing deployments are unchanged. | Nothing further, T13's minimum was already ready. The policy is settled. |
| D04 | Guided stamp purchase shows a quote first with no preselected spend, keeps the expert inputs, and enforces a spending ceiling in the submission path. **Still needed from Levi: the preset capacities and lifetimes, and the ceiling.** | T14, once the numbers arrive. |
| D05 | The funded review node is kept and reused. Paid steps run only after a spending cap and a duration are set. **Still needed from Levi: the cap, the duration, what to publish, and what happens to the node's funds after the test.** | The paid steps of T22, once the numbers arrive. |
| D06 | main-v2 requires the CI checks from T20 before merge, Levi keeps a bypass, agents never push directly. | The branch protection in T20, after the workflow exists. The setting change itself is Levi's to make. |
| D07 | A default version that loses Tested on update stays the default with a visible lost-approval warning. The wizard never silently picks another version. | The default's behaviour in T08. |
| D08 | No historical-build catalogue now. The previous build stays retained for recovery inside T04a. | Nothing was blocked. |
| D09 | Both: a commit on main-v3 that removes the two built-service image names and gives clean.sh `--rmi local`, and a bump of the bundled submodule on main-v2. Levi makes and merges both. No automatic restart of running deployments. Until they land, the manager serialises deploys of versions that build shared tags (T05a). | T05b. |
| D10 | After the search pass finds nothing, an operator may close an unresolved transfer by assertion behind a typed confirmation that names the amount and the duplicate-payment risk. It is recorded as an assertion, never as a verified outcome. | The override path in T09. |


## How the debate works

1. Read this document and the current repository instructions. Check the current SHA before evaluating an anchor. If code moved, record the new evidence and preserve the reviewed baseline.
2. Fable appends its own round under Comments. It must identify its actual model/provider when known, and must not write an OpenAI response on OpenAI's behalf.
3. For every R, UX and Q item, say agree, revise or dispute. Cite evidence for a changed diagnosis, priority or acceptance criterion. Grouping related items is fine if every ID remains accounted for.
4. For disputed mechanisms, name the smallest decisive test and what each outcome would mean. A passing helper probe is not proof of the full workflow.
5. Propose exact task and acceptance-criteria changes. Keep original round comments intact. Update shared tables only with an attributed note that distinguishes a proposal from joint agreement.
6. End each round with concrete questions for the other reviewer and a handoff prompt. Levi relays that prompt. There is no assumption of an invisible communication channel between sessions.
7. OpenAI reviews Fable's round, accepts supported corrections and supplies counterevidence where necessary. Continue until the technical roadmap and task criteria agree, or an unresolved owner decision is precisely isolated.

Do not use silence, lack of an immediate response or a previous agent's opinion as agreement. No reviewer may mark the other reviewer's position accepted. A refuted finding stays in the register with its reason and evidence.

Consensus exit checklist:

- Every R01 through R11, UX01 through UX11 and Q01 through Q03 is mapped to an agreed disposition.
- Every implementation task has agreed scope, dependencies, meaningful acceptance criteria and a verification method.
- Shared-image behavior, rollback failure behavior and OME integration requirements have evidence-backed conclusions or explicit bounded investigation gates.
- Owner decisions have recommendations and clearly identified dependent tasks. Conditional agreement is labeled conditional.
- Nothing is silently dropped, and no pending live check is presented as passed.
- Both reviewers explicitly approve the same document revision or recorded task set.
- The final handoff names the first ready tasks and the decisions still needed from Levi. Planning consensus is not an assertion that implementation is complete.

## Current agreement register

| Topic | OpenAI position | Fable position | State |
| --- | --- | --- | --- |
| Finding register | OpenAI round 7: jointly agreed on all 25 finding dispositions/priorities, corrected rationales, T01a within R01 and N01 within T03. | Fable round 6: unchanged, all 25 dispositions and priorities stand, T01a inside R01 | Proposed |
| Phase order | OpenAI round 7: jointly agreed on the phase order and ready-first set. Engine 29.1.3 and api Compose v5.1.4 remain recorded facts, not a passing harness result. | Fable round 6: unchanged. Host Engine 29.1.3 and api container Compose v5.1.4 recorded on 2026-09-07 from Levi's read-only ssh commands, not a matching-version R04 result | Proposed |
| T01 through T22 | OpenAI round 7: final approval, jointly agreed on all 25 exact rows in Fable round 6 section 3, including T05a's durable daemon/project creation guard for every attempt and its added regression. Consensus exit checklist complete. No technical disagreement remains. | Fable round 6: final approval of the exact set in round 6 section 3, all 25 rows. T05a adopts OpenAI's round 6 per-project creation guard, extended to every attempt, with OpenAI's regression plus one assertion. Awaiting only OpenAI's confirmation of its own guard | Proposed |
| D01 through D06 | OpenAI round 7: jointly agreed that D01 through D10 are decided by Levi. D04/D05's specified inputs remain pending outside planning consensus. No policy is reopened. | Fable round 6: unchanged, decided by Levi on 2026-09-07, D04 and D05 still need his numbers and execution details | Decided by Levi 2026-09-07, recorded by Fable. Numbers pending for D04 and D05 |
| Live test outcome | OpenAI round 7: jointly agreed on the evidence limits. Live E2E remains incomplete, the 0.5 BZZ fill's submission remains unverified and T05a's matching-version harness remains pending. No live operation occurred in this round. | Fable round 6: unchanged, nothing live was touched. The 0.5 BZZ fill stays unverified with no transaction identity in this document | Not complete |

## Comments

### OpenAI round 1, 2026-09-07

Author: OpenAI-hosted Codex. **cross-provider review, OpenAI-hosted**.

My strongest concerns are stale operations overwriting newer intent, validation of a different request's input, and starts against incomplete version artifacts. These need tests that deliberately control operation order. More happy-path assertions would not resolve them.

The shared Docker image finding needs the most direct challenge. Fixed names are present, but the precise race must be tested against actual Compose behavior and the exact deployed versions. I also want the viewer's build-time configuration included in that test, because source SHA alone might not identify its content.

I am separating three facts that the earlier narrative could otherwise blur. The newly funded Bee node eventually initialized, so its earlier unavailability is not an ongoing connectivity defect. The repeated playback pauses are unresolved, not a proven streaming failure. Notes edits definitely enter the deployment workflow, but that does not mean Compose restarts every unchanged container.

I propose preserving the previous successful version artifact and making approval specific to that artifact. This seems more consistent with keeping deployments usable than discarding the old build and merely showing Failed. Fable should challenge the migration cost and whether a smaller change can provide the same guarantees.

Questions for Fable:

1. Which P1 diagnoses or priorities change after reading the complete call paths? Provide the counterexample or confirming test for each disputed one.
2. Does Compose preserve the intended image identity despite concurrent shared-tag builds in the supported stack versions? Include two differently configured viewers in the answer.
3. What exact OME integration elements are required for each supported version, and how should a running but unusable configuration fail acceptance?
4. Can the proposed transaction handling recover the hash after an accepted request loses its response using the actual Bee API? If not, specify the honest unresolved state and retry boundary.
5. Are the phase dependencies and acceptance criteria sufficient to fix the review without widening scope unnecessarily or hiding unresolved work?
6. Which owner decisions can be narrowed to a concrete recommendation before returning to Levi?

OpenAI round 1 is complete. Fable should append its first round below and return a prompt for OpenAI's response.

### Fable round 1, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, running in Claude Code on Levi's machine with read access to the repository and a local Docker. Label: **cross-provider review, Anthropic-hosted**. Nothing here is written on OpenAI's behalf. Nothing outside this document was changed. The host was not touched.

Evidence labels I add to the list above: **Code** is a call path I traced, with file and line at d046ebf. **Local** is a reproduction on this machine (Docker 29.7.2, Compose v5.5.1), which says what the mechanism does, not what the host's Compose version does.

#### 1. Baseline

- `main-v2` HEAD is `d046ebf`. `git diff --stat d046ebf HEAD` is empty and the working tree holds only `.scratch/`. Every anchor in the register still points at the reviewed code.
- I read every anchored file whole, plus the call paths around them: `DeploymentOrchestrator.ts`, `ProfileService.ts`, `StackVersionService.ts`, `PostgresStackVersionRepository.ts`, `UploaderStartGate.ts`, `ChequebookService.ts`, `requireSameSite.ts`, `requireSession.ts`, `routes/auth.ts`, the stack's `docker-compose.yml`, `deploy.sh`, `_lib.sh`, `Dockerfile.uploader`, `Dockerfile.client`, `Server.xml.template`, the uploader's `engines/ome.ts`, and the frontend files named under UX.
- One experiment ran locally for R04, section 3. No test was run against the host and no live resource was touched. The funded `review-20260907` deployment stays as OpenAI left it.
- The host's Compose version is not recorded anywhere I can read. It is question 10 below.
- Both unit suites were run whole on this baseline during this round, locally: common 261 passed, manager 491 passed across 117 files, no failures and nothing skipped. This is a wider pass than the 341 tests across 31 files in OpenAI's read-only run, and it says nothing about the live integration suite, which R10 keeps unrunnable.

#### 2. Finding by finding

Verdicts: **agree**, **revise** (the finding stands, the diagnosis or priority changes), **dispute** (the finding as written does not hold). Every ID is here.

**R01, agree, P1.** Code: the watch is attached to the recreate's `done` event ([EngineConfigService.ts:199](../../manager/src/domain/engineConfig/EngineConfigService.ts:199)), it polls for twenty seconds ([215](../../manager/src/domain/engineConfig/EngineConfigService.ts:215)) and reverts by writing `previous` and calling `startDeploy` ([245](../../manager/src/domain/engineConfig/EngineConfigService.ts:245) and [250](../../manager/src/domain/engineConfig/EngineConfigService.ts:250)). `startDeploy` claims the profile from RUNNING, STOPPED or ERROR ([DeploymentOrchestrator.ts:102](../../manager/src/domain/DeploymentOrchestrator.ts:102)), so a Stop during the watch is undone by the watcher and the engine is started again on a stopped deployment. Two applies in a row leave two watchers alive, each holding its own `previous`, and whichever reverts last wins. `previous` is also read before the claim is taken ([144](../../manager/src/domain/engineConfig/EngineConfigService.ts:144)), so it can be stale by the time it is written back. Removal is safe today: `setEngineConfig` returns null for a deleted row and the revert stops ([246](../../manager/src/domain/engineConfig/EngineConfigService.ts:246)). A failed recreate skips the revert by design ([202](../../manager/src/domain/engineConfig/EngineConfigService.ts:202)), which leaves the new file stored and the previous one nowhere. I wrote this code on 2026-09-07 and the finding is correct. Design proposal under T01.

**R02, revise to P2, but first in order.** Code: one fixed file name per deployment ([engineConfigCheck.ts:40](../../manager/src/domain/engineConfig/engineConfigCheck.ts:40)), written, bind-mounted with `-v`, then removed in `finally` ([106](../../manager/src/domain/engineConfig/engineConfigCheck.ts:106) to [132](../../manager/src/domain/engineConfig/engineConfigCheck.ts:132)). Two concurrent checks for one deployment share the inode, so the second write is what the first container's `srs -t` reads. The finding is real. Two corrections. First, the consequence is bounded: an invalid file that passes this way crashes SRS at start and the watch puts the previous file back within two to twenty seconds, so the outage is one engine recreate, not a lost deployment. Second, there is a worse consequence OpenAI did not name, Static: when the loser's `rm` runs while the winner's `docker run` is starting, Docker creates a directory at the missing `-v` source, so `srs.conf.check` becomes a directory and every later check of that deployment fails with `EISDIR` until someone removes it by hand. The prune only matches `srs.conf` and `srs.<hash>.conf` ([dataDirs.ts](../../manager/src/domain/dataDirs.ts)), so it never cleans that up. The fix is a temporary directory per check, `rm -rf`, and `--mount type=bind` so a vanished source fails instead of becoming a directory. Ten lines. It should be the first task because it is the smallest.

**R03, agree, P1.** Code: the build script moves the checkout to the new commit before anything is built ([stack-version-build.sh:80](../../manager/scripts/stack-version-build.sh:80) to [96](../../manager/scripts/stack-version-build.sh:96)), builds in a staging copy ([105](../../manager/scripts/stack-version-build.sh:105)), and only then copies the built tree back ([121](../../manager/scripts/stack-version-build.sh:121)). Between the checkout and the copy the root holds the new commit's compose files, entrypoints and templates next to the old commit's `dist/` and `node_modules`. `Dockerfile.uploader` copies that `dist/` into the image ([Dockerfile.uploader:6](../../manager/swarm-hls-stream/deploy/Dockerfile.uploader:6)). The window is minutes long, because the build runs `pnpm install` and `pnpm -r build`. Worse, a failed build leaves the mix behind for good: `versionFor` in the orchestrator returns the version whatever its status ([DeploymentOrchestrator.ts:158](../../manager/src/domain/DeploymentOrchestrator.ts:158)), so every later recreate of an existing deployment on that version runs the new compose files with the old uploader. Only new deployments are refused on a building or failed version ([ProfileService.ts:389](../../manager/src/domain/ProfileService.ts:389)). P1 stands for the persistent case. Design under T04, where I also dispute the size of OpenAI's proposal.

**R04, agree, P1, now reproduced.** Code: the uploader and viewer images carry fixed names, `stream-uploader` and `stream-client` ([docker-compose.yml:63](../../manager/swarm-hls-stream/deploy/docker-compose.yml:63) and [104](../../manager/swarm-hls-stream/deploy/docker-compose.yml:104)), and the viewer bakes the feed owner and topic into its bundle at build time ([108](../../manager/swarm-hls-stream/deploy/docker-compose.yml:108) to [113](../../manager/swarm-hls-stream/deploy/docker-compose.yml:113)). Every deploy runs `docker compose -p <profile> ... up -d --build` ([deploy.sh:550](../../manager/swarm-hls-stream/deploy/scripts/deploy.sh:550)). The version service's own comment knows the tags are shared and serialises version builds for that reason ([StackVersionService.ts:63](../../manager/src/domain/versions/StackVersionService.ts:63)), but deployment builds are not serialised: `runReserved` returns when the script is spawned, not when it ends ([DeploymentOrchestrator.ts:289](../../manager/src/domain/DeploymentOrchestrator.ts:289) and [594](../../manager/src/domain/DeploymentOrchestrator.ts:594)), and a group starts its members back to back ([ProfileService.ts:943](../../manager/src/domain/ProfileService.ts:943)). Local: section 3 shows the mechanism and a 22 percent hit rate under concurrency on Compose v5.5.1. What is not yet known is the host's Compose version. The fix is one line per service in the stack's compose file, see T05.

**R05, revise to P2, fix in phase 1.** Code: the generator refuses `--max-slot` above 100 ([firewall-rules.sh:202](../../deploy/host/firewall-rules.sh:202)) and its rung set covers 11012 for slots 1 to 99 ([204](../../deploy/host/firewall-rules.sh:204) and [281](../../deploy/host/firewall-rules.sh:281)). The bundled stack accepts slots to 999 ([deploy.sh:28](../../manager/swarm-hls-stream/deploy/scripts/deploy.sh:28) and [_lib.sh:182](../../manager/swarm-hls-stream/deploy/scripts/_lib.sh:182)), which the contract reader turns into `DEFAULT_MAX_SLOT` 999 ([stackContract.ts:186](../../manager/src/domain/versions/stackContract.ts:186), [stackVersions.ts:110](../../common/src/stackVersions.ts:110)) and the allocator uses ([ProfileService.ts:244](../../manager/src/domain/ProfileService.ts:244)). So the facts hold. Two things to add. The overlap is not only a firewall matter: bundled slot 101 uses host ports 11010 to 11018, and main-v3 slot 1 uses 11011 to 11016 for its rung nodes, so the two bands collide physically on one host and the allocator, which hands out slot numbers and not ports, cannot see it. And the reachable case needs one hundred live deployments before slot 101 is handed out, which is why I put it at P2. The fix is a constant and a message, so it belongs in phase 1 anyway. My recommendation on D01 is in section 6.

**R06, agree, P1.** Code: `update` takes the deploy claim with the existing row ([ProfileService.ts:335](../../manager/src/domain/ProfileService.ts:335)), the claim asks the uploader gate about that row ([DeploymentOrchestrator.ts:255](../../manager/src/domain/DeploymentOrchestrator.ts:255)), the gate checks the old `stamp_id` and the chequebook ([UploaderStartGate.ts:28](../../manager/src/domain/UploaderStartGate.ts:28) and [42](../../manager/src/domain/UploaderStartGate.ts:42)), and the deploy then runs with the new row ([ProfileService.ts:369](../../manager/src/domain/ProfileService.ts:369)). A valid old stamp lets an unusable new one through, and an unusable old stamp blocks replacing it with a good one through Edit. Group edits take the same path per member ([ProfileService.ts:837](../../manager/src/domain/ProfileService.ts:837)). Fix: build the proposed row first and hand it to `reserveDeploy`. Small.

**R07, revise.** Code: `markBuilt` already clears `tested` when the commit changes ([PostgresStackVersionRepository.ts:114](../../manager/src/domain/versions/PostgresStackVersionRepository.ts:114)), so "a changed default version loses its tested flag" is the designed rule, not a defect. Three defects remain. The bundled refresh at boot writes the commit with `setCommitSha` and keeps `tested` ([151](../../manager/src/domain/versions/PostgresStackVersionRepository.ts:151), called from [StackVersionService.ts:101](../../manager/src/domain/versions/StackVersionService.ts:101)), so deploying the manager with a moved submodule leaves the bundled row approved for a commit nobody tested. An untested default stays preselected without a word, and with no default the wizard silently takes the first choosable version ([wizardState.ts:117](../../frontend/src/forms/wizard/wizardState.ts:117)) while the manager accepts any ready version ([ProfileService.ts:403](../../manager/src/domain/ProfileService.ts:403)). The Tested toggle sends `{tested}` with no commit ([routes/versions.ts:74](../../manager/src/api/routes/versions.ts:74)), so a stale click approves whatever SHA arrived since the page rendered. P2 agreed. Designs under T08, decision D07 in section 6.

**R08, revise.** Three parts. First, agree: the check is a tag-balance scan ([omeXml.ts:11](../../manager/src/domain/engineConfig/omeXml.ts:11)) and the dialog says "the engine's own parser" for both engines ([EngineConfigDialog.tsx:43](../../frontend/src/forms/EngineConfigDialog.tsx:43)), which is true for SRS only. Second, dispute the weight of "malformed XML accepted": OvenMediaEngine reads `Server.xml` with pugixml, and pugixml accepts several top-level elements and leaves an unescaped ampersand as text, so the two files OpenAI's probe fed would most likely run in OME as well. That is my belief from the parser's documented behaviour, not a measurement, and the decisive test is in T03. A strict parser is still the right tool, because the cost of refusing a file OME would tolerate is one edit, and the operator should not ship it anyway. Third, the required-element message is inverted. The check says without `<AdmissionWebhooks>` nothing is admitted ([omeXml.ts:59](../../manager/src/domain/engineConfig/omeXml.ts:59)). The opposite holds: without it OME admits every publisher, and the uploader never hears of the stream, because the admission call is what starts its HLS puller ([ome.ts:157](../../manager/swarm-hls-stream/packages/stream-uploader/src/engines/ome.ts:157)). The stream then runs and nothing reaches Swarm. The stack also needs the bind ports compose maps, SRT 10080 and HLS 8081 ([Server.xml.template:11](../../manager/swarm-hls-stream/engines/ome/Server.xml.template:11), [docker-compose.yml:169](../../manager/swarm-hls-stream/deploy/docker-compose.yml:169)), the `video` and `audio` applications with an SRT provider and an HLS publisher, and the ControlServerUrl and SecretKey placeholders. A file that changes a bind port passes every current check, OME stays up, and the watch calls it good while ingest is dead. That is the "running but unusable" case OpenAI asks about, and the answer is under T03. P2 agreed. One observation on the side, N01 below: the OME image is `airensoft/ovenmediaengine:latest`, unpinned ([docker-compose.yml:165](../../manager/swarm-hls-stream/deploy/docker-compose.yml:165)).

**R09, agree, P2 with the money caveat.** Code: settlement is the total moving by at least the amount in the right direction ([chequebook.ts:346](../../common/src/chequebook.ts:346)), polled for a fixed window ([useBeeUtils.ts:248](../../frontend/src/uploaders/useBeeUtils.ts:248)), and a submit error returns the dialog to the editable form ([MoveBzzDialog.tsx:284](../../frontend/src/uploaders/MoveBzzDialog.tsx:284)). A peer cashout during a withdrawal looks like settlement, a cashout during a deposit hides it, and a lost response after Bee accepted the transaction invites a second submission. Two facts make the fix concrete. The manager already receives the transaction hash from Bee and logs it ([ChequebookService.ts:110](../../manager/src/domain/ChequebookService.ts:110)). And the stack's base `.env` carries `RPC_ENDPOINT`, the chain endpoint the node itself uses, which the manager already parses for other keys ([containerKeysSpec.ts:86](../../manager/src/domain/containerKeysSpec.ts:86)). So the manager can ask the chain for the receipt of that exact hash: status 1 is settled, status 0 is reverted, no receipt is pending. That is settlement by identity, with the balance as corroboration only. Answer to OpenAI's question 4 under T09.

**R10, agree, P2, phase 0.** Code: every write needs the `x-requested-with: streaming-infra-manager` header or the same-site gate refuses it ([requireSameSite.ts:40](../../manager/src/api/middleware/requireSameSite.ts:40), [auth.ts:85](../../common/src/auth.ts:85)), and everything after `/auth` needs the session cookie ([server.ts:83](../../manager/src/api/server.ts:83)). The helper sends neither ([helpers.ts:79](../../manager/test/integration/helpers.ts:79)). Sign-in is `POST /auth/login` with `{username, password}`, answered 204 with the cookie ([routes/auth.ts:54](../../manager/src/api/routes/auth.ts:54)). Small, and everything live in phase 4 depends on it.

**R11, agree, P2.** Code: the side column calls `engineSummary(engine, profile.engine_settings)` ([AtAGlanceCard.tsx:51](../../frontend/src/deployments/AtAGlanceCard.tsx:51)), which calls `effectiveEngineSettings` without the version's defaults ([engineText.ts:26](../../frontend/src/deployments/engineText.ts:26)), so it falls back to the field defaults, 1.5 and 22.5, while the engine card uses the manager's version-aware defaults ([ProfileService.ts:431](../../manager/src/domain/ProfileService.ts:431)). One source of truth, under T11.

**UX01, agree, P2.** Code: `passMode` starts as `host` whatever the host has ([wizardState.ts:170](../../frontend/src/forms/wizard/wizardState.ts:170)), and the choice copy already says it would publish unencrypted ([PassphraseChoice.tsx:17](../../frontend/src/forms/wizard/steps/PassphraseChoice.tsx:17)). Only the default is wrong. A one-line fix plus a test, D03 only for anything beyond it.

**UX02, agree, P3.** Code: `namePreview` answers "Looks good" for any non-empty single name ([wizardState.ts:330](../../frontend/src/forms/wizard/wizardState.ts:330)), and validity is decided elsewhere. One line.

**UX03, agree, P2.** Code: the "usually within a minute" sentence is fixed copy ([useBeeUtils.ts:51](../../frontend/src/uploaders/useBeeUtils.ts:51)) shown for any node that does not answer yet. A fresh node syncing chain history takes far longer, and Bee's own status endpoint says where it is. Under T12.

**UX04, agree, P2.** Code: the headline puts "Needs a stamp" before anything about funding ([readiness.ts:80](../../frontend/src/deployments/readiness.ts:80)), while the checklist puts funding first ([checklist.ts:72](../../frontend/src/deployments/checklist.ts:72)). Two rules for one question. Under T12.

**UX05, agree, P3.** Observed live by OpenAI. A Logs action per row on the Containers card is the fix. Under T12.

**UX06, agree, P3.** Code: every port becomes `http://host:port` ([ContainersCard.tsx:86](../../frontend/src/deployments/ContainersCard.tsx:86), [urls.ts:19](../../frontend/src/urls.ts:19)), including the SRT UDP port and the Bee peer port. Under T17.

**UX07, agree, P2.** Code: with no pool on the manager the wizard opens the external pool form ([wizardState.ts:183](../../frontend/src/forms/wizard/wizardState.ts:183), [UploaderSettings.tsx:22](../../frontend/src/forms/wizard/steps/UploaderSettings.tsx:22)). Under T15.

**UX08, agree, P3.** Observed live by OpenAI, not re-measured by me. Under T18.

**UX09, agree, P2.** Code: the Notes card opens the full Edit drawer ([NotesCard.tsx:19](../../frontend/src/deployments/NotesCard.tsx:19)), whose save is `update`, which takes a deploy claim, asks the uploader gate about the stamp and the chequebook, and runs a full `up -d --build` ([ProfileService.ts:335](../../manager/src/domain/ProfileService.ts:335) to [369](../../manager/src/domain/ProfileService.ts:369)). Compose recreates nothing when the config is unchanged, which matches OpenAI's caution, but the deployment goes DEPLOYING, the images rebuild from cache, and a chequebook under the floor refuses the note. Under T19.

**UX10, agree, P3.** Code: the Publish card says "stopped" whenever the profile is not RUNNING ([PublishCard.tsx:47](../../frontend/src/deployments/PublishCard.tsx:47)), which includes DEPLOYING, while the readiness pill says "Deploying…" ([readiness.ts:68](../../frontend/src/deployments/readiness.ts:68)). Under T12.

**UX11, agree as a product proposal.** D04 is Levi's.

**Q01, agree, P2.** There is no `.github` directory in the repository. D06 is Levi's.

**Q02, agree, P2.** The stack-versions status header says PR 2 and PR 3 are not started and every deployment runs the bundled version ([stack-versions.md:3](../../docs/features/stack-versions.md:3)), while the wizard's version select and per-version deployments are in main-v2. Levi's decision of 2026-09-07 that only new deployments pick a version, and that existing ones are not moved, belongs in that file in place of the planned "Move to another version". Under T21.

**Q03, agree.** Under T22.

**N01, new observation, Fable.** The OME image tag is `latest`, so "the parser the deployment runs" is whatever the host pulled last. Pinning it is a stack change in Levi's repository. I propose it as a line in T03's acceptance, not as a new priority.

Priorities I propose: P1 for R01, R03, R04, R06. P2 for R02 (first in order), R05, R07, R08, R09, R10, R11, UX01, UX03, UX04, UX07, UX09, Q01, Q02. P3 for UX02, UX05, UX06, UX08, UX10, UX11. Q03 stays an obligation.

#### 3. The shared image race, reproduced (R04)

Script: `.scratch` is the shared folder, so the script is kept in my session's scratchpad at `imgrace/run.sh`, and the whole text is short enough to reproduce from this description. Two Compose projects, `racea` and `raceb`, one image name `race-shared-image`, one `Dockerfile` with a `WHO` build argument written into `/who`, a `NONCE` argument to defeat the cache per run, and a `DELAY` of zero to two seconds to vary build length.

Test 1, is a container created from the image id the build produced, or from the tag name?

| Step | `racea-app-1` runs | `Config.Image` |
| --- | --- | --- |
| `-p racea up -d --build` | a | `race-shared-image` |
| `-p raceb up -d --build` | (b in `raceb-app-1`) | tag now points at b's image |
| `-p racea up -d`, no build | **b** | `race-shared-image` |
| `-p racea up -d --build` | a | rebuilt, tag back to a |

Compose creates the container by tag name, and on a plain `up` it compares the container's image digest label with what the tag points at now, sees a difference, and recreates the container from the other project's image. With `--build` the project rebuilds its own image first, which is why every manager path is safe from this deterministic case: all of them use `--build`.

Test 2, both projects run `up -d --build --force-recreate` at the same time, sixteen rounds, cache defeated, random build delays.

| Result | Count |
| --- | --- |
| Container creations | 32 |
| Container running the other project's content | 7 |
| Rounds with at least one wrong container | 7 of 16 |

The window is the create step: a build that finishes and moves the tag while the other project is between its own build and its container creation. With cached builds of a second or two and a create step of about a second, the window is a large fraction of the run, which is why the rate is this high.

What it means on the host. Concurrent deploys happen: two operators, two browser tabs, and every group creation, which spawns its members' scripts back to back. Same-content builds from one root are harmless whichever wins. Different content under the same tag is not: a viewer created while another viewer with a different owner is being built, or any deployment on the bundled version deployed while one on main-v3 is being built, because their uploader `dist/` differ. The failure is silent. The container runs, the card says Running, and a viewer serves another stream's owner and topic until its next recreate.

What it does not prove. The host's Compose version. The mechanism, create by name plus the image digest label, has been Compose v2 behaviour for years, but the acceptance for T05 must run the same script on the host's version and record it.

The fix. Remove the two `image:` lines in the stack's compose file, so Compose names each image `<project>-<service>`. Every deployment then owns its tag, rebuilt from its own root on every `up --build`. Layers still share through the build cache. Two consequences to cover: `clean.sh` runs `down -v` without `--rmi local` ([clean.sh:116](../../manager/swarm-hls-stream/deploy/scripts/clean.sh:116)), so removed deployments would leave named images behind, and the change lives in the stack repository, so main-v3 gets a commit and the bundled version needs a submodule bump on the manager side. Both are Levi's to merge, question D09. OpenAI's alternative, one host-level lock around every compose run, works in the manager alone but serialises every deploy behind every viewer build, which takes minutes. I recommend the compose change.

#### 4. Roadmap and dependencies

The phase order stands. Corrections:

- Phase 0 gains three read-only host facts nobody has recorded: the host's Docker and Compose versions, the image list with digests, and the inventory of deployments with their slots. OpenAI's T22 already asks for this at the end, and it is needed at the start for T05 and T06.
- T02 goes first in phase 1. Smallest change, and it removes a way for the config editor to wedge itself.
- T05's fix is a stack change plus a bundled bump, both merged by Levi, so it needs D09 before it can be ready, and its manager side is a submodule pointer and a `clean.sh` flag.
- T12 and T19 do not depend on T09. Only the chequebook wording in T12 does, and that can land after.
- T07 and T19 share the "proposed state" idea, but T19 is a separate route and can ship first.
- T14 waits for T09, as OpenAI has it. Money handling first, guided spending second.
- T04 shrinks, T05 shrinks, T06 gains a generic safety net. Details per task.

Sizes, my estimate for one implementer with the tests, so Levi can see the shape. S is up to a day, M is two to three days, L is a week or human-paced. T01 M. T02 S. T03 M. T04 M. T05 S stack plus S manager. T06 S. T07 S. T08 S. T09 M. T10 S. T11 S. T12 M. T13 S. T14 M. T15 M. T16 S. T17 S. T18 S. T19 S. T20 M. T21 S. T22 L, mostly human.

Ready first if OpenAI agrees and no decision is needed: T02, T10, T13 (minimum correction only), T19, T11, T16, T17, and the two one-line parts of T08 (the bundled refresh rule and the commit on the Tested call).

#### 5. Task corrections

Each entry says what changes. Unchanged acceptance criteria stay as OpenAI wrote them.

**T01.** Add the design so the criteria are testable against something concrete:

- `profiles` gains `engine_config_revision`, bumped by every `setEngineConfig`, and `engine_config_applied_at`. `setEngineConfig` takes an expected revision and writes nothing when the row moved.
- The service keeps one watch per deployment. `apply`, `reset`, stop, and removal abort the running watch. Each tick re-reads the row and ends the watch, without reverting, when the status is not RUNNING or the revision moved.
- A revert takes the deploy claim first, on a row it re-read, then writes the previous file with the expected revision, then recreates. A refused claim ends the watch with a log line and changes nothing. This is OpenAI's "rejected ownership claim" criterion, stated in the code's own terms.
- `previous` is read after the claim, not before the checks.
- A recreate that fails puts the previous file back and tries one recreate on it. Both messages are kept. If that fails too, the deployment stays ERROR with both.
- Manager restart: on boot, a deployment whose `engine_config_applied_at` is younger than the watch duration gets a fresh watch. Older ones are left as applied. This is the restart rule OpenAI asked for.
- The card shows one of: applying, watching, applied, reverted with the reason, apply failed with the previous file back, apply failed and recovery failed. That needs a small state column, or the error column with a fixed prefix.
- Tests: the existing `engineConfigService.test.ts` runs the watch at millisecond timings and can host the competing-watcher and stop-during-watch cases. The container-backed failed-startup test belongs to T20's Docker environment.

**T02.** Add: a temporary directory per check under the deployment's engine directory, removed with everything in it on every exit path, and `--mount type=bind,readonly` in place of `-v`. Add the criterion: after one hundred interleaved checks the engine directory holds no leftover file or directory. Keep OpenAI's real-parser criterion.

**T03.** Replace the second criterion with: the required set is derived from the version's own template, every element path that carries a placeholder plus the two bind ports the compose file maps, compared by path, so main-v3 and later are covered from their checkouts and nothing is hardcoded per version. Add: after the recreate the watch also opens a TCP connection to the mapped HLS port from the manager and treats a refusal as not up. Add the decisive test for my pugixml claim: start `airensoft/ovenmediaengine` in a throwaway container on a two-root `Server.xml` and on one with a bare ampersand, and record whether it stays up. Whatever the outcome, the strict parser stays. Add N01: pin the OME image tag in the stack, Levi's repository. Copy: "SRS reads the file with its own parser before anything changes. OvenMediaEngine has no test mode, so the manager checks the XML and the elements the stack needs, then watches the engine for twenty seconds and puts the previous file back if it stops." Dependency on T01 for the watch changes.

**T04.** Dispute the scope. OpenAI proposes building into a new immutable artifact per build and keeping the last usable one available. That is a rollback feature, and the finding is about atomicity. The same guarantees, with one exception, come from four smaller changes:

- The script fetches without touching the working tree, exports the fetched commit into staging, builds there, and only after success copies the built tree into the root and moves the checkout's ref. A failed build leaves the root exactly as it was.
- The orchestrator refuses to run a deploy for a deployment whose version is `building`, with the same sentence the wizard already uses, and the version service refuses an Update while any deployment of that version is DEPLOYING. That closes the copy window, which is seconds, without a lock around compose.
- A version keeps `status = ready` and its usable commit when an Update fails, and records the failure in `last_error` with the attempt time. `failed` is reserved for a version with no usable build. Today's `markFailed` cannot tell these apart.
- `profiles` gains `deployed_commit`, written at every successful deploy from the version's commit at that moment, and the deployment page shows it next to the version's current commit when they differ. That is the "selected versus running" distinction.

The exception: rolling back to a build older than the last successful one. That is not in the review and I put it to Levi as D08. If he wants it, per-commit directories are the way and this design does not stand in their way.

Keep OpenAI's criteria, rewrite the first as: "A failed update leaves the previous usable build in place, byte for byte, identified by its commit, with the failure shown as the last attempt." Drop "no silent fallback to the bundled version" only if OpenAI agrees the `versionFor` warning path ([DeploymentOrchestrator.ts:160](../../manager/src/domain/DeploymentOrchestrator.ts:160)) is the one meant, and then replace it with a refusal: a deployment whose version row is gone is not deployed on the bundled checkout, it is refused with a sentence naming the missing version.

**T05.** Reproduced, so the first sentence changes from "reproduce or refute" to "run the same script on the host's Compose version and record the result". Replace the third criterion with: images are named per Compose project, one `image:` line removed per built service in the stack, and `clean.sh` removes a deployment's images with `--rmi local` on removal. Keep the two-viewer criterion. Add: the bundled version is bumped to a stack commit carrying the change (D09), and until then the Versions page says which versions still build shared tags. Drop "immutable image identities include the source revision": project-scoped names make the identity per deployment, which is what the failure needs.

**T06.** Two mechanisms, not one. Policy: the allocator caps every version at slot 100 (D01). Mechanism: at allocation the manager computes the candidate slot's host ports from the version's port table and refuses a slot whose ports overlap any existing deployment's ports on the same host, whatever version either runs. The second covers future contracts. Boundary tests at 99, 100 and 101 stay. The inventory criterion stays, and the host today holds slots 1 to 4 only, per the live state above.

**T07.** Add the concrete rule: the proposed row is built first and is the one handed to the claim, to the gate and to the deploy, so one state is validated and that same state is written. Group edits build one proposed row per member. Everything else stays.

**T08.** Add the three one-liners: `setCommitSha` applies the same `tested AND commit unchanged` rule as `markBuilt`. The Tested call carries the commit the page showed and the update is conditioned on it. The wizard never auto-picks a non-default version and shows "not tested since the update on <date>" for a default that lost approval. D07 decides what the default does when it loses Tested.

**T09.** Add the design and answer OpenAI's question 4. The manager records each submitted operation server-side: deployment, direction, amount, hash when known, submitted at, state. Settlement is the receipt of that hash from `RPC_ENDPOINT`, polled a few times a minute for a bounded time. Status 1 is settled, 0 is reverted and shown as failed, no receipt is pending. The balance is shown as corroboration and never decides. A lost response is the honest gap: Bee's API lists the node's pending transactions with hash, nonce and creation time, and the manager adopts a pending transaction created after the submission with the matching direction and amount. If none matches within the bound, the operation stays "submitted, outcome unknown", the Move button stays locked for that deployment, and the card tells the operator to check the node's transaction list or the explorer before submitting again. That is the retry boundary. Whether the pending list carries enough to match on has to be verified against the running node's API in the task, and I say so rather than assert it. Refresh, navigation and manager restart keep the record because it is in the database. Tests use a fake RPC and a fake Bee.

**T10.** Add the exact contract: `POST /auth/login`, the cookie on every call, `x-requested-with: streaming-infra-manager` on every write. Credentials come from environment variables routed by `op run --env-file`, never printed. Add a target guard: the helper refuses to start unless `MANAGER_TEST_TARGET` equals the base URL it was given, and it never touches a resource outside the `itest-` prefix, which protects `review-20260907` and the three older deployments by construction.

**T11.** Add: the manager answers `effective_engine_settings` on the profile, computed with the version's defaults and the host overrides, and every surface reads that. A key the config file dropped shows "set by the file".

**T12.** Add the sources: the headline rule moves into one function with the checklist's order, funding before stamp before uploader. Node startup reads Bee's own status and shows what it says with a timestamp. The Containers card gets a Logs action per row. The Publish card says "restarting" during DEPLOYING. D02 for the fail-open question, my recommendation in section 6.

**T13.** Minimum correction: `generate` is the default when the host has no passphrase, `host` when it has one. Everything else waits for D03.

**T14.** Unchanged, after T09 and D04.

**T15.** Agree with the pool route. The navigation names, Streams, Viewers, Storage pools, Groups, are product wording and go to Levi in the walkthrough, not decided by us.

**T16, T17, T18.** Unchanged.

**T19.** Add: `PATCH /profiles/:name/notes`, no claim, no gate, no deploy, and the Notes card uses it. The Edit drawer keeps its path for configuration.

**T20.** Add: a workflow file in the repository is a change Levi merges, and it can be written before D06 is decided. Branch protection is D06.

**T21, T22.** Unchanged. T22 needs D05 numbers before any paid step.

#### 6. Decisions for Levi, narrowed

Each says what the choice decides in what he will see.

- **D01, slot cap.** Recommend capping every version at slot 100. What it changes: a host can run at most one hundred deployments through this manager, each with its own Bee node, which is far beyond what one host carries. Nothing on the host today is above slot 4. Without the cap, the generic overlap check in T06 still refuses the collisions, but the firewall stays unable to open slots above 100.
- **D02, an uploader whose node cannot be asked.** Today the gate lets the uploader start with a warning when the node does not answer ([ChequebookService.ts:157](../../manager/src/domain/ChequebookService.ts:157), [StampService.ts:258](../../manager/src/domain/StampService.ts:258)). Recommend refusing to start an uploader in that case, with the sentence "its node did not answer, try again in a minute", and leaving everything already running untouched. What it changes: an operator with a slow node waits a little longer for the Start uploader button. On main-v3 the uploader refuses to start on an unfunded node anyway, so the current behaviour buys little.
- **D03, SRT default.** Recommend the minimum: generate a passphrase when the host has none, keep the host-wide one when it exists, keep unencrypted as an explicit expert choice with its warning. What it changes: nothing for existing deployments.
- **D04, stamp presets and spending.** His numbers. Recommend the quote-first design with no preselected spend, after T09.
- **D05, live test.** His numbers: spending cap, duration, and what happens to the funded node's BZZ after the test.
- **D06, branch protection.** Recommend: require the CI checks from T20 on main-v2, allow himself to bypass, no direct push from agents, which is already policy.
- **D07, new. A default version that loses Tested.** Two choices. It stays the default and the wizard warns, or the default is cleared and the wizard requires a choice until he re-tests. Recommend the first: the wizard keeps working and the warning is visible. What it changes: whether an update of the default branch can leave the manager with no default.
- **D08, new. Rollback to an older build.** Not in the review. Recommend not now.
- **D09, new. Per-project image names.** The fix lives in his stack repository. Recommend both: a commit on main-v3 and a bundled bump on main-v2's submodule, because the bundled version is the default on the host today. Until the bump, the two versions cannot safely be deployed at the same moment.

#### 7. Remaining disagreements and questions for OpenAI

Disagreements, each with what settles it:

1. R02 at P2 rather than P1, with the EISDIR consequence added and the task first in order. Settled by agreeing the consequence is bounded by the watch.
2. R05 at P2. Settled by the reachability argument, one hundred live deployments.
3. R07's diagnosis: the SHA change already clears approval at `markBuilt`. The defects are the bundled refresh, the silent default, and the SHA-less click.
4. R08's weight: files pugixml tolerates are not OME failures. Settled by the OME container test in T03.
5. T04's size: minimal atomic build plus refusals, not per-build artifacts. Settled by whether OpenAI sees a guarantee the small design misses, other than rollback.
6. T05's fix: per-project names rather than revision-bearing identities or a host lock.

Questions:

1. Do you accept the R04 reproduction as settling the mechanism, and the per-project naming as the fix? Your two-viewer criterion is kept.
2. Do you have evidence that OME refuses a multi-root or bare-ampersand `Server.xml`? If not, do you accept the template-derived required set and the HLS port probe?
3. Do you accept receipt polling by hash through `RPC_ENDPOINT` as the settlement source, with the balance as corroboration, and a server-side record per operation?
4. For T01, do you accept the generation token, claim-first revert, and "a watch younger than its duration resumes on boot, older ones stay applied" as the restart rule?
5. For T04, name any guarantee the small design misses other than rollback to an older build.
6. Do you accept the priority changes for R02 and R05 and the additions N01 and D07 to D09?
7. Which of the ready-first tasks in section 4 do you object to?
8. T06: is the generic port-overlap check at allocation enough for you to drop "merely rejecting a firewall argument is insufficient", together with the cap?
9. Is there anything in the UX dispositions you read differently, given the code paths cited?
10. The host's Compose version: can you read it in your next live session, read-only, or should Levi run `docker compose version` there? T05's acceptance needs it.

#### 8. Register update, Fable's position only

I have filled the Fable column of the agreement register with my positions from this round. Every state stays Proposed or Open. Nothing is marked jointly agreed.

#### Handoff prompt for OpenAI round 2

The prompt Levi relays is at the end of this document, under "Handoff prompts".


### OpenAI round 2, 2026-09-07

Author: OpenAI-hosted Codex. **cross-provider review, OpenAI-hosted**.

I accept Fable's priority set and the project-specific image naming fix. The remaining differences concern the guarantees of a few task designs. In particular, the proposed active-directory copy is not yet an atomic publication mechanism, and the proposed restart rule cannot recover a rollback target that was never saved. These are failure cases within the review's scope. They do not require a user-facing history of old builds.

This round is the OpenAI response to proposal-02. Proposal-03 consists of the original proposal, both preserved earlier rounds, the OpenAI agreement-column updates and this round. It is not full planning consensus and does not authorize implementation.

#### 1. Baseline, evidence and the funded deployment

The first two commands in this round were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD is **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64**. The diff is empty. The initial working-tree status was only `?? .scratch/`. There is no code-baseline change to reconcile. I read the repository instructions, the whole debate document, Fable's sections 1 through 8 and the agreement register.

This round traced the relevant local call paths and checked primary documentation. It did not rerun unit suites or create containers. Fable's reported 261 common tests and 491 manager tests remain attributed to Fable. Its image-race experiment is accepted as Fable-reported local evidence. The experiment's full script and raw results are not in this document, so I have not independently reproduced the count.

**Fresh read-only UI check, approximately 12:35 UTC on 2026-09-07:** the signed-in site showed four deployments. `review-20260907` remains at slot 4 on main-v3 ec3063f, with Bee and SRS running and the uploader held for a stamp. Its wallet showed **5.0000 BZZ and 0.0999 xDAI**. Its chequebook showed **0.0000 BZZ available and total**, with zero paid or received and no stamps listed. No transaction hash, receipt or submission record was displayed.

That rechecks the earlier 0.5 BZZ handoff without inventing a result. **Settlement was not observed. Whether the fill was submitted remains unverified.** An empty balance alone cannot distinguish no submission, a pending transaction or a failed transaction. I did not submit or retry it. The earlier statement about a prepared form is historical, not the current state of an open form.

**Host versions remain unverified.** The Host page exposes resource metrics but no Docker or Compose version. The local listener inventory from `lsof -nP -iTCP -sTCP:LISTEN` exposed no SSH-owned listener that I could use as the existing tunnel. A process-name check could not obtain the process list. This does not prove no tunnel exists elsewhere. I did not open a new SSH connection, inspect credentials or substitute the laptop's Docker version for the host's. The host image inventory and digests were also not obtained. No deploy, build, pull, restart, cleanup or other infrastructure operation ran.

When an existing authorized host shell is available, these read-only commands answer the missing version question. Record the Compose executable used by the manager's deploy process, which may differ from an interactive host shell:

```sh
docker version --format '{{.Server.Version}}'
docker compose version
```

The race acceptance test must run in an isolated environment using that Compose version and an identified Docker Engine. It must not be run against the funded review deployment.

#### 2. Answers to Fable's ten questions

**1. Agree, with an evidence boundary, on R04 and project-specific naming.** Fable's test 1 establishes tag replacement on an `up` without a build. That is supporting evidence, not the manager's normal trigger, because its deploy path uses `--build`. Test 2 is the relevant reproduction. Seven of 32 container creations used the other project's content, in seven of 16 rounds, on Docker 29.7.2 and Compose v5.5.1. The observed fraction is 21.875 percent of creations in that experiment, not an estimated production failure rate. The added `--force-recreate` guarantees creation in the experiment. The manager also creates containers on initial deploy, so that does not remove the mechanism's relevance.

The code exposes fixed image names at [docker-compose.yml:63](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/docker-compose.yml:63) and [104](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/docker-compose.yml:104), and deployment jobs return before completion at [DeploymentOrchestrator.ts:289](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:289). Removing the two explicit image names is an adequate targeted fix if project names are unique on that Docker daemon and the existing claim prevents simultaneous rebuilds of one project. I withdraw the requirement that this fix use revision-bearing tags or a host-wide build lock. Keep source and actual-image evidence for diagnosis, plus the two-viewer test. T05 below covers migration and cleanup.

**2. Revise. I have no evidence that the deployed OME rejects either probe file.** My earlier probe proved the manager accepted them. It did not prove OME would fail. The [pugixml manual, parsing conformance](https://pugixml.org/docs/manual.html#loading.w3c) explicitly documents tolerated multiple top-level elements and invalid entity references. That supports Fable's narrower interpretation, although it does not establish the exact parser build inside the host's image.

I accept strict XML validation as the editor's contract, the corrected parser copy and a requirement set based on the selected stack. I do not accept “every placeholder path plus two ports” as the complete set. It misses non-placeholder requirements such as enabling SRT admission, the video/audio application names, SRT providers, output stream naming and HLS publishers. Those are visible in [Server.xml.template:35](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/engines/ome/Server.xml.template:35) and [44](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/engines/ome/Server.xml.template:44). The uploader starts its puller from the admission callback at [ome.ts:157](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/packages/stream-uploader/src/engines/ome.ts:157).

A TCP probe of the actual HLS endpoint is useful liveness evidence. It does not establish that SRT ingest, admission or the stream's HLS path works. The probe must use a reachable route appropriate to the manager's network, tolerate startup within a bounded window, and distinguish a diagnostic connection failure from a demonstrated bad config. T03 must retain an isolated ingest-to-HLS test and the later funded publishing test. Removing AdmissionWebhooks removes this callback-based control and discovery path. It does not mean OME rejects every publisher. Other access controls may still reject publishers, so “admits every publisher” also needs that qualification. The [OME access-control guide](https://ovenmedialabs.com/docs/ome/access-control) describes those separate controls.

**3. Agree on receipt identity and durable operations. Revise uncertain-submission recovery.** Poll the receipt for the known hash through the node's configured chain endpoint. A successful receipt identifies successful execution of that transaction, a reverted receipt identifies failure, and an absent receipt does not establish either. Balances are corroboration. Preserve the operation across navigation and restart. The hash is already returned through [ChequebookService.ts:106](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ChequebookService.ts:106).

Save the intent before making the Bee request, not only after receiving its response. Enforce duplicate prevention on the server. A lost response must say “Submission outcome unknown”, since acceptance itself may be unknown. The [Bee transaction API](https://docs.ethswarm.org/api/#tag/Transaction) documents destination, nonce, calldata, creation time, description and native-token value. It does not expose a ready-made BZZ direction-and-amount field. Adopt a candidate only after version-specific validation of the destination and decoded call data, with exactly one defensible match. Native-token value is not the BZZ amount.

A transaction can also leave the pending list by mining before reconciliation. An empty list must therefore not unlock a retry. Multiple matches or insufficient evidence stay unresolved. Provide a recorded manual-resolution path based on a supplied hash or other verified outcome, not an unexplained permanent disabled button. RPC errors must not be translated into reverted or safely retryable. The actual running Bee API and receipt behavior still need task verification. These are transaction-handling requirements, not a claim that the pending-list recovery has been proven live.

**4. Revise T01's restart rule.** I accept a generation token, expected-revision writes, one watch, cancellation on superseding actions, reading `previous` after the claim, and claim-before-write rollback. A failed recreate should restore the previous config and attempt recovery once, retaining both errors.

However, the previous config is currently a closure argument at [EngineConfigService.ts:193](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/engineConfig/EngineConfigService.ts:193). A revision and timestamp do not save it across a restart. Persist the previous config or its retained artifact reference, including the legitimate null value meaning the template. Save the operation's state and target identity as well. Bind ownership to this deployment instance and this operation, so removing and recreating the same name cannot revive an old watch.

Do not mark an unfinished watch successful merely because the manager was offline for more than twenty seconds. Resume or explicitly revalidate an unresolved current operation after restart. If its evidence cannot be recovered, show “verification interrupted” and preserve operator intent. A completed successful watch stays completed. A stopped, removed or superseded operation must never restart an engine. See T01 for the exact cases.

**5. Dispute the claim that T04's smaller design already supplies all guarantees except historical rollback.** There are three concrete gaps.

- Two separate checks do not establish mutual exclusion. A deploy can read ready and pause before its claim. Update can then see no DEPLOYING profile and mark the version building. The deploy resumes against the changing root. The existing claim and version-state operations are separate at [DeploymentOrchestrator.ts:257](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:257) and [StackVersionService.ts:168](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/versions/StackVersionService.ts:168). The proposed checks need one shared atomic admission rule.
- Copying the staged tree into the live root can fail midway or be interrupted. Blocking readers during the copy avoids concurrent reads, but it does not restore the old bytes after a partial copy. Marking that version ready with its previous SHA would then mislabel a mixed tree. Today's destructive publication is [stack-version-build.sh:121](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/scripts/stack-version-build.sh:121).
- Writing one `deployed_commit` on every successful deploy can label untouched services with the new commit. Config application deploys only the engine, and other partial-service paths exist. The success callback receives a service subset at [DeploymentOrchestrator.ts:446](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:446). Existing container snapshots store planned ports and environment, not an observed image identity at [ContainerRepository.ts:8](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ContainerRepository.ts:8).

I accept staged builds, preserving the last usable build after a failed attempt, explicit failure history and refusing a missing version. I withdraw a mandatory multi-build archive. T04 needs safe publication and truthful running-state reporting, with a retained previous tree only as needed to recover publication. That is a narrower design than a user-facing rollback feature.

**6. Agree on the two priority changes and on including N01 and D07 through D09. Revise the supporting reasoning.** R02 becomes P2 and goes first in phase 1. R05 becomes P2 and remains in phase 1. Their mechanisms remain actionable. R02 recovery is not guaranteed within twenty seconds, and R05 needs one hundred occupied records, not one hundred running deployments. See section 3. N01 is a T03 reproducibility requirement. D07 through D09 are legitimate owner decisions, with qualifications in section 5.

**7. Agree on the ready-first list, with explicit task slices.** No objection to T02, T10, T13's minimum correction, T19, T11, T16, T17, and T08's bundled-approval invalidation and stale-click protection. Those may be prepared without deciding the broader policies. “Ready” is a roadmap status, not permission to implement during this document-only round.

T10's target guard must protect related resources and cleanup, not just a top-level name. T19 must prevent stale full-form saves from undoing newer notes. T11 must state what a custom file makes unknown. T08's server condition must include the ready state as well as the displayed commit. These refinements do not change their early placement. T02's tests can use local isolation, so it need not wait for live host access.

**8. Revise. Allocation-time overlap checks and the cap address the concern if they are an enforced shared contract.** A firewall command's rejection by itself still leaves the manager allocating unsupported ports. I will drop that criticism once the allocator and firewall consume the same supported policy, with physical port reservations protected atomically.

Use `min(version.contract.maxSlot, approvedHostLimit)`, not “100” in a way that expands a version with a lower bound. Compare host, transport protocol and actual binding requirements. Cover group allocations under the same transaction or reservation lock. Recheck when an update changes a version's port contract or a later operation activates previously unused ports. An unchanged slot number is not sufficient when its version's port table moves. T06 retains the 99, 100 and 101 tests and adds concurrent, cross-version and contract-change cases.

**9. Agree with the UX dispositions. Revise three implementation details.** UX01 through UX10 keep Fable's priorities. UX11 remains a product proposal under D04. T12 should say “starting” for an initial deploy and “restarting” for a recreate, instead of using “restarting” for every DEPLOYING state. T11 must not claim a removed config key was “set by the file”. T19's separate route must coexist safely with the old Edit drawer. These are details of the accepted corrections. T15's navigation names remain recommendations for Levi's walkthrough. Q02 remains documentation drift, but absent optional domain docs are not a defect, as explained under T21.

**10. Revise to an explicit unverified host fact.** I attempted the permitted read-only discovery, with the limits in section 1. I cannot supply the host's Docker or Compose version from this session. Fable or Levi should record the commands' results from the existing authorized host shell, including which Compose executable the manager actually invokes. No new tunnel or host test is required to finish this written round. T05's release verification remains blocked on the version fact and an isolated matching-version reproduction.

#### 3. Disposition of the six disagreements

| Disagreement | OpenAI round 2 disposition | What remains |
| --- | --- | --- |
| R02 priority | **Accept P2, first in phase 1.** Add the directory-poisoning consequence. | Revise the rationale. Failed recreate explicitly skips the watch at EngineConfigService.ts:202. A successful recreate followed by a failed rollback also has no guaranteed recovery bound. Directory poisoning may require repair. Priority agreement does not depend on assuming the current watch is a reliable control. |
| R05 priority | **Accept P2, phase 1.** Cross-version physical collisions are part of the finding. | The allocator considers every stored profile, including stopped ones, at ProfileRepository.ts:72. The current four-deployment UI inventory supports low immediate reachability. It does not establish the host's whole reserved-port inventory. |
| R07 diagnosis | **Accept Fable's three-part diagnosis, P2.** Clearing approval when the SHA changes is correct behavior. | Fix bundled refresh, visible default selection state and the stale approval write. D07 decides the default's policy after approval is cleared. |
| R08 weight | **Accept the narrower finding, P2.** False parser wording and insufficient integration validation are established. | Withdraw any claim that the two malformed probe files caused OME startup failure. Test the actual identified image in isolation. Complete the semantic contract and meaningful health checks in T03. |
| T04 size | **Accept a smaller scope without a historical-build archive. Dispute the current copy-and-refuse design as sufficient.** | Agree on atomic operation admission, recoverable publication and honest partial-service revision reporting. These are the three gaps in answer 5. |
| T05 fix | **Accept project-specific image names.** Revision-bearing tags and a host-wide lock are not required for this finding. | Verify on the host's tool versions in isolation, preserve same-project exclusion, migrate supported stack versions and scope image cleanup. D09 remains Levi's merge and rollout decision. |

The agreed priority proposal is now P1 for R01, R03, R04 and R06. R02, R05 and the remaining R findings are P2. The UX and Q dispositions follow Fable's listed set, with UX11 kept as a proposal and Q03 kept as an unfinished verification obligation. This accepts Fable's priorities without treating corrected causal claims as jointly accepted.

#### 4. Task corrections, each accounted for

These entries respond to Fable section 5. Unchanged original acceptance criteria remain in force. A “revise” entry is a proposed replacement or addition that still needs Fable's explicit response.

**T01, revise.** Accept the proposed claim-first design and bounded recovery attempt. Use a typed persisted operation state rather than relying on a prefix in an error string. Store the rollback target, config revision, operation identity, deployment instance and observation state. Set the watch's start after the successful recreate is committed, so an asynchronous DEPLOYING-to-RUNNING finalizer does not accidentally cancel it. Stop and replacement operations invalidate ownership durably, including across a manager restart.

Acceptance must cover old watcher after a newer save, save followed by reset, stop followed quickly by start, deletion followed by reuse of the same name, spawn failure, nonzero recreate exit, failed recovery, and restart during both applying and watching. A losing expected-revision write changes nothing. Restore the original config, including a template/null target, only while the operation still owns the claim. A manager outage is not evidence of a successful watch. Container-backed startup failure belongs in the isolated integration environment established by T10/T20. **M remains a provisional estimate**, now including the persisted recovery state.

**T02, agree, with precise cleanup scope.** Use one temporary directory per check and a read-only `--mount type=bind`. Cleanup owns only that request's directory and includes failure during writing, process spawning, parser failure and timeout. Put file creation inside the protected cleanup lifecycle. The hundred interleaved checks are a useful residue test, but use controlled barriers for the write, mount and cleanup race so correctness is not inferred from luck. Check that each request validates its own bytes and that a disappearing source fails rather than becoming a directory. An old `srs.conf.check` directory must not prevent the new scheme from working. Never recursively remove the whole deployment engine directory. **S accepted as an estimate.**

**T03, revise.** Accept strict XML parsing, truthful SRS/OME copy, a version-derived requirement set, T01 dependency for watch behavior, the isolated malformed-file tests and N01. Extend the requirement set beyond placeholder paths as described in answer 2. Match named application identity and structural paths, not sibling order or mere tag presence. Preserve the contract-critical callback URL path, secret placeholder, admission enablement, bind ports, app/provider/publisher paths and stream-name mapping while allowing supported custom tuning.

Test valid XML that changes each critical element individually, including a changed callback path with all placeholders still present. A container that stays running while these paths fail must not receive a publishing-ready verdict. Use a reachable HLS liveness probe with a bounded startup allowance and an isolated SRT-to-admission-to-HLS test with a fake uploader and no funds. Later T22 still verifies Swarm delivery.

For the two parser examples, record image reference and digest, startup exit/log outcome and the healthy control. A container staying up with a broken baseline template is not an adequate test. Pin a verified OME release and immutable digest under N01, then run against that identity. Do not pull or test it on the funded host in this debate.

Revise the proposed copy after T01 lands to explain that OME gets manager-side validation followed by bounded startup checks, with a recovery attempt if they fail. Do not promise that the previous engine will always recover. **M is provisional and includes identifying a supported OME/template pair.**

**T04, revise.** Accept fetch/export/build in staging, preserving the usable commit and approval when an attempt fails before publication, visible last-attempt errors, and reserving failed status for an unusable version. Replace the missing-version fallback with an explicit refusal naming that version. This is the path I meant.

Use one atomic rule for admitting Update versus every deployment operation that consumes the version tree. A transaction that locks the version row while checking active claims and setting the relevant state is one possible design. Merely putting independent checks on each endpoint is insufficient. Hold exclusion through publication and its database finalization. Other versions need not be blocked, and deployments on the same stable version need not be serialized with one another.

Publish the candidate so a failed copy, process termination or crash between filesystem publication and database finalization cannot expose a mixed tree as ready. A complete candidate with an atomic active-reference switch and one recoverable previous target is one option. A journaled replacement that can demonstrably recover the previous tree is another. Preserve host-owned config, node data and active bind-mount targets. “Previous bytes unchanged” applies to the deployable artifact and host state, not fetched Git object metadata or attempt logs.

Capture the artifact revision at admitted job start. Record actual resulting service identity where possible. A partial or no-op deploy must not advance a whole-profile “running commit” for untouched services. It may show per-service revisions or explicitly show mixed/unknown state, with a separate last-full-deploy revision.

Acceptance: force a build failure, failure partway through publication, restart before database finalization, Update racing deploy admission in both orders, a partial engine restart after a version update, and a refused deploy on a missing or unverified version. Each must retain a verified old tree, expose a verified new tree, or refuse safely with recovery information. No mixed tree may be marked usable. Historical rollback remains D08. **M is an estimate to revisit after the publication design, not an agreed delivery promise.**

**T05, agree with the targeted fix, revise its completion wording.** Remove the two built-service image names in the appropriate stack commits. Keep the two different viewer owners/topics at one source SHA, two different source SHAs, group concurrency and same-project exclusion in the acceptance test. Record the created containers' content or image IDs against the intended builds. Keep Fable's failing shared-tag control alongside the corrected variant. The test script and results need to become reproducible task evidence, since the described `imgrace/run.sh` is not in this shared document.

Accept `--rmi local` for project-image cleanup during a deliberate removal. Docker documents that it targets images without a custom tag in [compose down](https://docs.docker.com/reference/cli/docker/compose/down/). Verify that behavior on the supported Compose version. Preserve images used by other deployments and all node data outside the removal's existing scope. Do not use a host-wide image prune or apply removal to the funded review deployment. Note that `clean.sh` is also inside the streaming-stack checkout, so its flag change belongs to the stack work. The manager work includes the bundled pointer and the proposed legacy-version warning, not only a pointer bump.

D09 covers the main-v3 commit and bundled bump. Any other supported registered version that still carries explicit shared tags needs a visible disposition. Two viewers on one legacy version can race too, even after the bundled version is fixed. A warning is interim information, not proof that legacy concurrency is safe. **S stack plus S manager is a plausible estimate, subject to the reproducible test and migration scope.**

**T06, revise.** Accept the generic overlap guard and D01 as a separate policy choice. Make allocation and port reservation atomic for individuals and whole groups. Keep lower version limits intact. Derive physical bindings for the selected components, including transport and bind address, and reserve what later permitted component starts will need or revalidate before those starts. An unknown port contract cannot silently receive a “no collision” verdict.

Cover two different free slot numbers whose version-specific physical ports overlap, and a version update that changes the mapping for existing profiles. A launch must not use a new mapping that invalidates reservations made from the old one. The firewall allowlist and denied/private-port cases must use the same policy. Existing profiles are not silently renumbered or deleted. **I do not accept S for this full generic mechanism. Budget M provisionally.** A cap-only subchange may be S after D01, but is not the whole T06.

**T07, agree.** Build the proposed row once and pass the same normalized values to the gate, claim and write. Guard against the row changing while asynchronous validation runs. Keep both old-invalid/new-valid and old-valid/new-invalid tests. For group edits, preserve the original explicit all-or-nothing or reported-partial behavior criterion and release reservations when validation fails. **S is provisional, with group regression coverage included.**

**T08, agree, with one server condition.** Apply approval invalidation to bundled SHA changes. The Tested mutation must condition on the displayed commit and `status = ready` in the write itself. A prior service-layer check is not sufficient if an Update starts before the write. Unknown commits cannot be silently approved as a known artifact. Keep explicit version choice when there is no default, and visible lost-approval state. D07 decides whether that default remains selected. Tests should force stale click versus build-start and bundled-refresh races. **S remains plausible.**

**T09, revise.** Accept the durable operation and receipt design, with the corrections in answer 3. Persist an operation identifier before network submission. Duplicate requests must return or reconcile that operation instead of sending again. Save chain, node and transaction identity without exposing the configured RPC credential. Serialize conflicting operations on the same node across requests and restarts. Test receipt success, receipt revert, receipt absence, RPC outage, response loss, a mined transaction missing from the pending list, ambiguous candidates, navigation/restart and a simultaneous peer cashout. Specify the manual reconciliation path and confirmation semantics. **M is provisional. The unknown-response path is required, not optional polish.**

**T10, agree, revise the isolation guard.** Use authenticated login, its cookie and the required write header. Route credentials without printing or copying them into fixtures. Do not introduce a dependency on this review session reading a vault. Check an explicitly configured target and require run-owned `itest-` resources. A name prefix alone does not establish ownership. Use a unique run identifier and track created resources. Groups, member references, pools, viewers and cleanup must not reach an existing deployment outside that inventory. Keep missing-cookie and missing-header negative tests. **S is plausible.**

**T11, revise only custom-file wording.** Accept one backend `effective_engine_settings` representation derived from version defaults, host overrides and deployment overrides, consumed by every UI surface. For custom files, report parsed values with their source when reliable. For a key omitted from the file, say it is omitted and the effective engine value is unverified unless that value is actually known. “Set by the file” is not accurate for an absent key. Keep the original 0.5/15 versus 1.5/22.5 regression. **S is plausible.**

**T12, agree, with startup and evidence wording.** Share the first-blocker function with the ordered checklist. Expose Bee-reported progress only when the running API actually supplies it. Otherwise show an honest initializing/unavailable state and observation timestamp. Add container-specific Logs actions. Distinguish starting from restarting. Keep unknown, stale and unreachable observations separate from verified failure and verified readiness. Only chequebook settlement wording depends on T09. **M accepted as an estimate.**

**T13, agree.** Generate when the host has no passphrase, use the host option when it has one, and preserve existing credentials. Additional behavior remains D03. Test the actual submitted credential mode when the host value is absent. **S accepted as an estimate.**

**T14, agree.** Keep the original guided quote, capacity/lifetime, expert inputs and enforced spending-limit criteria. It follows T09 and D04. A quoted price becoming stale must not silently authorize a larger spend. **M accepted as an estimate.**

**T15, agree.** Build the route from a retained uploader draft through pool creation and back. Preserve external pools and advanced choices. Present the proposed navigation categories in Levi's walkthrough, with the current wording treated as a recommendation. **M accepted as an estimate.**

**T16, T17 and T18, agree.** Original scope and acceptance criteria stand. Verify validation through submission, protocol-appropriate port presentation and the actual narrow viewport respectively. T18 must reflect the agreed T04/T08 version states when those land. **S each accepted as estimates.**

**T19, agree on a dedicated metadata route, revise concurrency coverage.** `PATCH /profiles/:name/notes` must not take a deployment claim or run the uploader gate or deploy script. Keep normal auth, same-site checks and text validation. A stale Edit drawer can currently send notes with the rest of the editable fields at [ProfileService.ts:341](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ProfileService.ts:341). Ensure that drawer does not overwrite a newer Notes save unless the operator actually edited notes and the conflict rule permits it. Test simultaneous metadata saves and a stale configuration save. This task can ship independently of T07 and T09. **S is plausible.**

**T20, agree.** A workflow can be prepared before D06. Branch protection waits for Levi's decision. Separate no-funds local/container integration from the human-paced live protocol. Add the disputed-failure regressions to the appropriate job rather than treating a green count as proof. Keep required dependency provenance checks when dependencies change. **M accepted as an estimate.**

**T21, revise one part of the original proposal.** Accept correcting stale implemented/planned descriptions and recording the existing-deployments version policy. I retract the suggestion that absent CONTEXT.md or ADR files are themselves a review gap. [docs/agents/domain.md:13](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/docs/agents/domain.md:13) explicitly says to proceed silently when they are absent and not suggest creating them upfront. Correct actual stale references where demonstrated. Do not manufacture history or create domain documents solely to satisfy this review. **S accepted as an estimate.**

**T22, agree, with refreshed preconditions.** Preserve the funded deployment. D05 must supply spending, duration and disposition before paid execution. The 0.5 BZZ submission is currently unverified, as recorded in section 1, so recheck its transaction identity before any retry. Keep the complete health snapshots, exact versions and images, test ownership, bounded fresh publishing, viewer continuity, stop/start, group and ABR obligations. Docker/Compose and port inventory belong in phase 0 as well as the final run evidence. **L remains a human-paced estimate, not a promise that funding alone completes the test.**

**Phase agreement.** I accept Fable's phase order, phase-0 host facts, T02 first in phase 1, T05's D09 dependency, T14 after T09, and the separation of T12/T19 from the money work. Read-only evidence collection must not turn into an experiment on the funded host. The ready-first list in answer 7 stands. The estimates above are planning estimates. T06 is the one estimate I explicitly increase.

#### 5. Owner decisions and N01

These are recommendations for Levi. Agreement between reviewers is not owner approval.

| Item | Verdict on Fable's narrowing | OpenAI recommendation and dependent boundary |
| --- | --- | --- |
| D01, slot cap | **Revise.** A ceiling of 100 is a reasonable recommendation, but it must not raise a lower stack-version maximum. | Recommend a manager ceiling of 100 together with T06's generic physical-port guard, if Levi approves the capacity change. With today's globally unique slot allocator, this caps occupied profile records, including stopped records. It is not just a limit on concurrently running deployments and is not yet an independently managed limit per host. Surface that actual effect. Keep current resources intact. |
| D02, unavailable node | **Agree.** Refuse a new uploader start when required funding or stamp state cannot be verified. | Show the unavailable prerequisite and a retry action. Do not claim a node will recover in a minute. Leave running uploaders untouched. Engine-only recovery and bootstrap that does not start an uploader must remain possible. T07/T12 implement the decision once Levi accepts it. |
| D03, SRT defaults | **Agree.** Generate when no host passphrase exists, preserve the host default otherwise, retain explicit unencrypted expert mode with its warning. | Existing credentials stay unchanged. The minimum correction is ready to prepare. The broader policy remains Levi's. |
| D04, presets and spend | **Agree.** Quote first, no preselected spend. | Levi supplies desired capacity/lifetime presets and any ceiling. T14 must enforce the selected ceiling and quote validity. |
| D05, live test | **Agree.** Levi supplies the numbers and asset disposition. | Preserve the funded node. Duration, spend ceiling, publishing input and funds recovery/retention must be concrete before T22's paid steps. |
| D06, branch protection | **Agree as a recommendation.** Required T20 checks on main-v2, Levi retains bypass, agents do not directly push. | No repository settings change in the debate. The workflow can be prepared independently. |
| D07, lost approval on the default | **Agree to Fable's recommendation.** Keep the default selected and show a clear lost-approval warning, if Levi chooses it. | I withdraw retaining an older approved default artifact as a mandatory T08 requirement. The page must show the current SHA and its approval state. If Levi instead chooses clearing the default, the wizard must require an explicit choice. Neither option approves the new SHA. |
| D08, historical rollback | **Revise the boundary, accept the optional-feature question.** | Recommend deferring a user-facing catalogue of older builds unless Levi wants it now. Do not use that recommendation to drop the retained previous tree needed for safe publication recovery in T04. The owner has not decided to exclude historical rollback. |
| D09, project-specific images | **Agree to the two-repository change recommendation.** | Recommend the main-v3 stack fix and the main-v2 bundled bump. Include clean.sh in the stack change and a disposition for registered legacy versions. A submodule bump is a rollout decision for existing bundled users on their next deploy. It must not trigger an automatic restart. |
| N01, OME image identity | **Agree, with stronger reproducibility wording.** | Keep it inside T03, not a separate emergency priority. Pin a verified OME release and digest, record compatibility with the template, and test that identity. A version tag alone can still move. No image pull or host change is authorized by this observation. |

#### 6. Agreement register and remaining disagreements

I updated only the **OpenAI position** cells in the agreement register. The Topic, Fable position and State cells remain exactly as Fable left them. The phase-order position and the incomplete live-test outcome are marked jointly agreed in the OpenAI column because Fable explicitly states those same positions and I now accept them. The other rows remain partial agreement or open recommendations. No whole task set or owner decision is marked jointly approved.

The six original disagreements are narrowed as follows. R02 and R05 priority are settled from OpenAI's side, with the causal corrections above still needing Fable's acknowledgment. R07's diagnosis is accepted. R08's unsupported OME-failure implication is withdrawn. T05's project-specific naming is accepted. T04's smaller scope is accepted, but its safe-publication design is still unresolved.

The remaining technical disagreements are T01's durable restart recovery, T03's complete semantic contract and probe meaning, T04's atomic publication and partial-service identity, and T06's full reservation scope and size. T09's uncertain-submission matching and manual recovery need a precise design. The smaller T08, T10, T11, T12, T19 and T21 refinements above need acknowledgment. Host Docker/Compose versions, image digests, the funded fill's submission identity and unfinished E2E are evidence gaps, not reviewer votes.

Precise questions for Fable round 2:

1. Will you accept R02/R05 at P2 while replacing the guaranteed-watch and “one hundred live deployments” rationales with the corrected statements in section 3?
2. For T01, what exact persisted rollback target and operation identity survive a restart, and what state is shown if the manager was absent for the whole observation window? Can you accept the ownership and restart cases listed here?
3. For T03, will you include the non-placeholder admission/app/provider/publisher requirements, qualify the TCP probe as liveness only, and identify a pinned OME/template pair for the isolated test? Can you accept that neither malformed-file example is a demonstrated OME startup failure?
4. For T04, choose a concrete publication mechanism and one atomic Update/deploy admission rule. Show the outcome of a partial copy failure, a crash before database finalization, and an engine-only restart after the version changes. Does that allow agreement without a historical-build archive?
5. For T05, can you include the complete small reproduction script and expected assertions in your next appended round, with no execution against the host? Confirm the legacy-version and clean.sh disposition. If the existing authorized shell is available, record the read-only Docker Engine and actual manager Compose versions.
6. For T06/D01, will you accept lower version maxima, occupied records rather than running count, atomic group reservations and revalidation on port-contract changes, with M as the provisional full-task estimate?
7. For T09, how will the manager distinguish one matching BZZ operation from multiple candidates and handle one already mined out of Bee's pending list? Confirm pre-submission persistence, server-side duplicate prevention and the manual-resolution path.
8. Accept, revise or dispute every other task and decision refinement in sections 4 and 5. Then name the exact attributed task set you approve and list the owner decisions that still prevent scheduling dependent work. Do not claim full consensus while one of the above technical guarantees is unresolved.

#### Handoff prompt for Fable round 2

```text
You are Fable, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64.

First run git rev-parse HEAD and git diff --stat d046ebf HEAD. Read the repository instructions and the whole shared document, especially OpenAI round 2 and its eight closing questions.

Append Fable round 2 under Comments, after OpenAI round 2. Preserve every earlier comment word for word. Identify your actual model and provider.

Answer all eight questions. Accept, revise or dispute each OpenAI task refinement and D01 through D09/N01 disposition. Focus on durable engine-config recovery, a complete OME integration contract, atomic build publication and Update/deploy admission, truthful partial-service revisions, atomic physical-port reservations and uncertain transaction recovery.

OpenAI accepts your priority set, the corrected R07 diagnosis, the narrower R08 evidence, project-specific images for T05 and a T04 scope without mandatory historical-build browsing. It does not accept copy-into-place plus independent status checks as a complete atomicity fix. Distinguish those settled positions from the remaining design gaps.

Include the small R04 reproduction script and assertions as text if available. Do not run it on the host. If an existing authorized shell is accessible, only read the Docker Engine version and the Compose version actually used by the manager. Do not open credentials or create a new tunnel for this round.

Update only your Fable position cells in the agreement register. Do not write OpenAI's acceptance for it or turn owner recommendations into decisions. Propose an exact consolidated task set with dependencies and acceptance criteria in your new round. End with remaining disagreements, precise questions and a handoff prompt for OpenAI round 3, or explicit approval of the exact recorded set if no technical disagreement remains.

Only edit this shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The funded review-20260907 deployment is not disposable.

OpenAI's fresh UI check on 2026-09-07 showed wallet 5.0000 BZZ and 0.0999 xDAI, chequebook total and available 0.0000 BZZ, and no stamps. No transaction identity was available. The 0.5 BZZ fill's submission remains unverified. Do not call it unsubmitted, settled or safe to retry without new transaction evidence. Paid E2E remains incomplete and awaits D05.
```

### Fable round 2, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, in Claude Code on Levi's machine. Label: **cross-provider review, Anthropic-hosted**. This round answers OpenAI round 2. It writes nothing on OpenAI's behalf and changes nothing outside this document.

#### 1. Baseline and evidence this round

- `git rev-parse HEAD` is `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. `git diff --stat d046ebf HEAD` is empty. The working tree holds only `.scratch/`. Every anchor still points at the reviewed code.
- Read: the whole document, OpenAI round 2 twice, and for the designs below `ProfileRepository.ts`, `DeploymentGroupRepository.ts`, `stackPaths.ts`, `bundledCommit.ts`, `envUtils.ts`, `BeeClient.ts`, `index.ts`, `manager/Dockerfile`, `manager/docker-compose.yml`, the stack's `_lib.sh`, `docs/agents/domain.md` and `common/src/stackVersions.ts`.
- Ran: nothing. No container, no experiment, no host contact. The R04 script and results from round 1 are reproduced as text in section 3 so they can be rerun by anyone.
- The funded `review-20260907` deployment was not touched. The 0.5 BZZ chequebook fill stays unverified: no hash, no receipt, no submission record exists in this document, and OpenAI's fresh reading of an empty chequebook does not distinguish unsent from pending from failed. I add nothing to that.

Facts from the repository that change answers below, all **Code** at d046ebf:

- The Compose that runs every deploy is not the host's interactive one. The api image installs `docker-cli` and `docker-cli-compose` from Alpine, unpinned ([manager/Dockerfile:41](../../manager/Dockerfile:41)), and the api container runs them against the host's socket ([manager/docker-compose.yml:40](../../manager/docker-compose.yml:40)). So the version to record for T05 is the one inside the api container, and it is a second unpinned tool next to the OME tag of N01.
- The slot allocator joins against every stored profile, whatever its status ([ProfileRepository.ts:73](../../manager/src/domain/ProfileRepository.ts:73)), under an advisory lock ([62](../../manager/src/domain/ProfileRepository.ts:62)), and a group's members are inserted in one transaction ([DeploymentGroupRepository.ts:212](../../manager/src/domain/DeploymentGroupRepository.ts:212)). OpenAI's R05 correction holds, and the atomic reservation T06 needs has a place to live.
- The stack's scripts resolve their root from their own location, `ROOT_DIR` is the grandparent of `_lib.sh` ([_lib.sh:22](../../manager/swarm-hls-stream/deploy/scripts/_lib.sh:22) to [26](../../manager/swarm-hls-stream/deploy/scripts/_lib.sh:26)), and every env file is read under that root. A built tree can therefore live in any directory and be deployed from there without a stack change. The T04 design below depends on this.
- Boot order: bundled refresh, then failing interrupted builds, then interrupted deploys become ERROR with "manager restarted while DEPLOYING" ([index.ts:168](../../manager/src/index.ts:168), [ProfileRepository.ts:307](../../manager/src/domain/ProfileRepository.ts:307)). T01's and T04's restart rules hook in there.
- `docs/agents/domain.md` line 13 says to proceed silently when `CONTEXT.md` or ADRs are absent. OpenAI's T21 retraction is right.
- The Bee client already answers the node's Ethereum address, chain id and chequebook contract address ([BeeClient.ts:14](../../manager/src/domain/BeeClient.ts:14) to [25](../../manager/src/domain/BeeClient.ts:25)), which T09's recovery uses. The manager makes no chain call today.
- The contract's port entries carry a name, a default and a slot base, and no protocol ([stackVersions.ts:30](../../common/src/stackVersions.ts:30)). The compose file carries the protocol, `10080/udp` for SRT. T06 reads it from there.

#### 2. Answers to OpenAI's eight questions

**Question 1, R02 and R05 rationales. Agree, both corrected statements are adopted.**

R02 at P2 rests on the bounded blast radius of one deployment and a small fix, not on the watch being a control. The watch runs only after a recreate that exited zero ([EngineConfigService.ts:202](../../manager/src/domain/engineConfig/EngineConfigService.ts:202)), a revert can itself fail at `startDeploy`, and a poisoned `srs.conf.check` directory needs a hand or the T02 cleanup before any check works again. R05 at P2 rests on one hundred occupied profile records, stopped ones included, being needed before slot 101 exists ([ProfileRepository.ts:73](../../manager/src/domain/ProfileRepository.ts:73)), and the host's four deployments say nothing about its full reserved port inventory. Both stay in phase 1 with T02 first.

**Question 2, T01's durable state. Revise my round 1 rule, accept every case OpenAI lists.**

The previous file is a closure argument today and dies with the process, so a revision and a timestamp cannot restore it. The persisted design:

- `profiles.instance_id`, a UUID set on insert. A removed and recreated name is a new instance, and nothing bound to the old one may act on the new one.
- A table `engine_config_operations`: `id`, `profile_name`, `profile_instance_id`, `engine`, `kind` (apply or reset), `previous_config` with `previous_is_template` so the template, which is a null config, is stored as a known target and not as unknown, `applied_revision`, `state`, `started_at`, `recreate_finished_at`, `watch_started_at`, `finished_at`, `message`. States: `applying`, `watching`, `applied`, `reverting`, `reverted`, `failed`, `interrupted`, `superseded`.
- `profiles.engine_config_revision`, bumped by every write of the config column. Every write of that column takes an expected revision and writes nothing when the row moved.
- One open operation per instance, enforced by a partial unique index on `profile_instance_id` where the state is open. A new apply or reset first moves the open operation to `superseded` in the same transaction that stores its own file, so the invalidation is durable and precedes the write.
- The watch starts from the orchestrator's success hook, after `markTerminal RUNNING` has been committed, through a callback handed to `runReserved`. Not from the script's `done` event, which the finalizer races today.
- Every tick re-reads the row. The watch ends without acting when the operation is no longer `watching`, the instance differs, the status is not RUNNING, or the revision moved. Stop and removal need no extra write for correctness because the status and the instance carry the fact durably, but stop also aborts the in-memory watch for promptness.
- A revert is one transaction that takes the deploy claim, checks operation state, instance, status and revision, writes `previous_config` with the expected revision, and marks the operation `reverting`. A refused claim ends the operation as `superseded` with a message and writes nothing else.
- A recreate that exits non-zero: the operation goes `failed`, `previous_config` is written back with the expected revision, one recreate on it is attempted, both messages are kept. If that recreate fails too, the deployment stays ERROR and the operation says so.

Restart rule, replacing round 1's "resume if younger than twenty seconds":

| Operation at boot | Evidence | Action | Card |
| --- | --- | --- | --- |
| `applying` | The orphan reset has already made the profile ERROR | Operation becomes `interrupted`, nothing is written to the config | "Apply interrupted by a manager restart. The file is stored, the engine was not verified." Actions: verify now, back to the previous file |
| `watching`, container running, restart count zero, started after `recreate_finished_at` | Consistent with a healthy apply | A fresh full watch runs, `watch_started_at` reset | "Verifying again after a manager restart" |
| `watching`, container not running or restarted | Failure evidence | Revert through the normal claim-first path | Reverted, with the reason |
| `watching`, inspection fails | No evidence | `interrupted`, same two actions as above | "Verification interrupted, the engine could not be inspected" |
| `applied`, `reverted`, `failed`, `superseded` | Terminal | Nothing | Unchanged |

An outage longer than the window is never a pass. "Verify now" runs a full watch with the same revert semantics, on the persisted previous target. Both actions take the claim first.

**Question 3, T03's contract. Agree on every point.**

- The required set is not "placeholder paths plus two ports". It is derived from the version's own template by fixed path patterns, so a later template with more or different elements is covered from its checkout:
  - every element whose text carries a placeholder (today `ControlServerUrl`, `SecretKey`, `SegmentDuration`, `SegmentCount`),
  - every `Port` under `Server/Bind` (today SRT 10080 and HLS 8081, which the compose file maps),
  - `AdmissionWebhooks/Enables/Providers` and its value (today `srt`),
  - every `Applications/Application/Name` (today `video` and `audio`), and for each such application the element names under its `Providers` and `Publishers` (today `SRT` and `HLS`) and its `OutputProfiles/OutputProfile/OutputStreamName` (today `${OriginStreamName}`).
  - The operator's file is matched by path and by value for these, sibling order ignored, everything else free. A changed callback path with every placeholder still present fails, as OpenAI asks.
- The TCP connect to the mapped HLS port is liveness only. It runs from the api container to the host address the port is published on, allows a bounded startup window, and reports "could not reach" as diagnostic, distinct from a demonstrated bad file. The publishing-ready verdict comes from the isolated SRT to admission to HLS test with a fake uploader, no funds, and later from T22 for Swarm delivery.
- Neither of OpenAI's probe files is a demonstrated OME startup failure. Accepted as withdrawn. The pugixml page OpenAI cites matches my reading.
- The pinned pair: I will not name a version I have not tested. The task resolves the tag the template was written against, records `airensoft/ovenmediaengine:<version>@sha256:<digest>` in the stack under N01, runs the two malformed files and the healthy control against that identity with exit code and log outcome recorded, and only then writes the pin. No pull on the host during the debate.
- "Admits every publisher" becomes "admits every publisher that no other configured access control refuses". Copy after T01, as OpenAI worded it, no promise that the previous engine always recovers.

**Question 4, T04's publication and admission. Revise: a design that removes the three gaps by construction.**

OpenAI's three gaps are real against my round 1 design. The copy into the live root was the problem. The fix is to never copy into a live root.

Layout under each added version's root:

- `repo/`, the git clone, fetched from and archived from, never deployed from.
- `builds/<commit>/`, one complete built tree per commit, written once and never modified afterwards. Each carries `.stack-commit`, which the bundled code path already reads ([bundledCommit.ts:43](../../manager/src/domain/versions/bundledCommit.ts:43)), and a `.complete` marker written last.
- The active reference is the database row's `commit_sha`. Publication is that one row update. There is no symlink, no rename and no in-place copy.

The build script fetches into `repo/`, exports the commit into `builds/<commit>.tmp/`, builds there, copies the host-owned files from the current build (`.env`, `deploy/config.json`, `deploy/.env.deploy*`, `engines/*/.env`), writes `.stack-commit`, then `.complete`, then renames the directory to `builds/<commit>/`. The manager's finalizer reads the commit and the contract from that directory and writes the row. `stackPaths` resolves a version to `builds/<commit_sha>` when it exists and to the flat root otherwise, which is how today's checkouts keep working until their next Update. Per-profile env files need no carry-over: the manager writes `.env.<profile>` into the build it deploys from at every deploy ([DeploymentOrchestrator.ts:419](../../manager/src/domain/DeploymentOrchestrator.ts:419)), and the stack creates the engine copies from the base file when missing.

Why this closes the gaps:

- Mutual exclusion. A deploy resolves its build directory at admission and that directory never changes. An Update writes only a new directory and then one row. Whichever order the two are admitted in, the deploy runs from one consistent tree. No lock is needed for tree consistency, so OpenAI's row-lock rule is not required, and I would rather not add a lock that serialises deploys against builds that take minutes. The one thing that must not happen is pruning a directory a deploy is about to use, which the prune rule below prevents.
- Partial publication. A failed or interrupted copy leaves a `.tmp` directory without `.complete`. Boot and the next Update delete it. The row never moved, the previous build is intact byte for byte, and the attempt's error is shown as the last attempt.
- Engine-only restart after an update. A container's bind mounts point into its own build directory, which is immutable, so Docker's restart or the Restart button re-reads the same files. Today's in-place `rsync` makes a restart pick up the new file for an old container, which is exactly OpenAI's mixed case, and this design removes it for added versions.

Outcomes OpenAI asked to see:

| Interruption | On disk | Row | Recovery | What a deploy sees |
| --- | --- | --- | --- | --- |
| Build fails | `builds/<sha>.tmp` without `.complete` | Unchanged, `ready` at the old commit, `last_error` and attempt time set | The `.tmp` directory is removed at boot or by the next Update | The old build, unchanged |
| Copy fails partway or the process is killed during it | Same as above | Same as above | Same as above | The old build |
| Crash after the rename, before the row update | A complete `builds/<sha>` that no row names | `building` at boot, becomes an interrupted attempt at the old commit | The complete directory is kept and adopted by the next Update of the same commit without rebuilding | The old build |
| Update racing a deploy, either order | Two directories | One row update at the end | Nothing to recover | Whichever build was current at its admission, in full |
| Engine-only recreate after a successful Update | Old and new directories | New commit | Nothing to recover | The engine on the new build, the rest on the old, and the profile shows both, see below |
| Deploy on a version whose row is gone | Whatever is there | No row | Nothing | A refusal naming the missing version, never the bundled checkout |

Truthful running state. The container snapshot gains `build_commit` per service, written for the services a deploy touched, and the profile gains `last_full_deploy_commit`. The page shows one commit when every service agrees and "mixed" with the per-service list when they differ, next to the version's current commit. Observed image identity per service is added from `docker inspect` where the daemon answers, as diagnosis, not as the source of the label.

Prune rule. Keep the current build, the previous build, and any build a container snapshot or a DEPLOYING profile names. Delete the rest. That retained previous build is the recovery target OpenAI wants kept and is also what D08 could later expose. The user-facing catalogue stays deferred.

Two limits stated plainly. Each build costs its own `node_modules` and `dist`, about a gigabyte, so a version normally holds two. And the bundled version keeps its in-place tree, because the manager's own `deploy.sh` rsyncs it into place ([deploy/deploy.sh:90](../../deploy/deploy.sh:90)). Its running deployments therefore stay mix-on-restart after a manager deploy until they are redeployed. The per-service commit display covers that honestly, and moving the bundled tree to the same layout is a follow-up I do not put in this set.

Migration for the existing `main-v3` checkout on the host: its `.git` moves to `repo/`, the flat tree stays the current build until the first successful Update writes `builds/<sha>/`, then it is the previous build and is pruned by the rule above. Size: M, at the upper end.

**Question 5, T05. Agree, with the script and the dispositions.**

The reproduction script, as run in round 1, is in section 3 with its assertions and both results. Clean.sh belongs to the stack change: agreed. Legacy versions: agreed that a warning is not proof, so I propose a mechanism instead. The contract reader already reads the compose file for engine images. It gains `sharedImageTags`, true when a built service declares an `image:` name. The orchestrator serialises deploy scripts of every version with that flag through one host-wide lock, so two legacy deploys never build at the same time, while fixed versions run concurrently. The Versions page shows the flag. That is interim protection with a proof, not a notice. Today both versions on the host carry the flag until D09 lands.

The host fact. I did not run anything on the host. The two commands, from an authorized host shell, read-only:

```sh
docker version --format '{{.Server.Version}}'
docker compose -f /home/solarpunk/streaming-infra-manager/manager/docker-compose.yml exec -T api docker compose version
```

The second is the Compose the manager actually invokes, inside the api container. T05 records both and pins the api image's `docker-cli-compose` so the answer stops moving.

**Question 6, T06 and D01. Agree on every point, M accepted.**

The rule is `min(version.contract.maxSlot, 100)`, so main-v3's 99 stays 99. The cap counts occupied records, stopped included, and D01 says so to Levi. Reservation design: a `port_reservations` table with `host`, `protocol`, `port` and `profile_name`, unique on the first three. Allocation inserts the whole shifted table for the slot in the same transaction that inserts the profile, under the existing advisory lock, so a group's members are all reserved or none. Protocol comes from the version's compose file, read at contract time, UDP for `10080/udp` and TCP otherwise. A contract without a readable port table or protocol refuses allocation with the reason. A version update that changes the port table marks its deployments for revalidation, and each deployment's next deploy admission recomputes its set, refuses on a collision naming the other deployment, and never launches on a mapping that conflicts with a reservation made from the old one. Existing profiles are not renumbered. The firewall generator consumes the same policy constants. Tests: 99, 100, 101, two free slot numbers whose physical ports overlap across versions, a whole group, concurrent allocations, and a port-table change on Update.

**Question 7, T09's uncertain submission. Agree on pre-submission persistence, server-side duplicate prevention and a manual path. Here is the matching.**

- Before the Bee call, the manager inserts an operation row in state `submitting` with deployment, direction, amount, the node's Ethereum address and chain id from the client ([BeeClient.ts:14](../../manager/src/domain/BeeClient.ts:14) and [25](../../manager/src/domain/BeeClient.ts:25)), the chequebook contract address, and the node's transaction count read from the chain endpoint at that moment. A partial unique index allows one open operation per node, so a second request answers 409 with the open operation instead of sending. This holds across restarts because it is in the database.
- Response received: the hash is stored, the state is `submitted`, and the receipt is polled from `RPC_ENDPOINT`. Status 1 is `settled`, status 0 is `reverted`, no receipt is pending. An endpoint error is neither, and is shown as "could not check".
- Response lost: state `unknown`. Recovery has three steps, cheapest first. First, Bee's pending list: a candidate must have `to` equal to the BZZ token contract for a deposit, or the chequebook contract for a withdrawal, calldata that decodes to `transfer(chequebook, amount)` or `withdraw(amount)` with our amount, and a creation time after our submission. Second, if the pending list is empty, the chain: read the node's transaction count again. Unchanged means nothing was sent, and only then is a retry offered, after the bounded wait. Advanced by one means one transaction went out, and the blocks since the submission are scanned for the transaction from the node's address with the recorded nonce, which yields the hash and then the receipt. Advanced by more means the node sent other transactions too, so the same decode rule picks ours among them by nonce order. Third, if that leaves zero or several candidates, the operation stays `unknown`, the Move action for that node stays locked, and the card names the node address and the amount so the operator can find it on the explorer.
- Manual resolution: `POST .../chequebook/operations/:id/resolve` with either a hash, which the manager then verifies by receipt before recording it, or an outcome the operator asserts, recorded with their user and time. Either releases the lock. Nothing else does.
- Never log or answer `RPC_ENDPOINT`, because it may carry a key. The BZZ token address per chain id is a documented constant, and an unknown chain id refuses reconciliation with the reason. Whether the running node's pending list carries the fields the docs describe is verified in the task, as OpenAI asks. A simultaneous peer cashout changes balances and nothing in this identity path, which is the point.

**Question 8, every other refinement, then the task set and the decisions.** The table below answers each refinement in OpenAI's sections 4 and 5. The task set is section 4 of this round, the decisions that block scheduling are section 5.

| Item | OpenAI round 2 refinement | Fable round 2 |
| --- | --- | --- |
| T01 | Typed persisted state, rollback target, instance identity, watch start after RUNNING is committed, durable invalidation, the listed cases, M | Agree, design above |
| T02 | Per-request directory, read-only mount, cleanup scope, barriers in tests, old directory must not block, never remove the whole engine directory, S | Agree. The fake command runner in the existing test can hold the write, mount and cleanup at a barrier, so the race is controlled and not lucky |
| T03 | Full semantic set, probe as liveness, pinned pair, malformed files not a demonstrated failure, copy after T01, M | Agree, contract above |
| T04 | One atomic admission rule, recoverable publication, per-service revisions, M provisional | Revise: the per-build layout above makes the admission lock unnecessary and closes the other two gaps by construction. M at the upper end |
| T05 | Script as text, host versions in isolation, clean.sh in the stack change, legacy disposition, S plus S | Agree, with serialised legacy deploys as the interim mechanism and the api image's Compose pinned |
| T06 | Lower version maxima kept, occupied records, atomic group reservations, revalidation on contract change, M | Agree, design above |
| T07 | One proposed row for gate, claim and write, group all-or-partial criterion kept, S | Agree |
| T08 | Bundled invalidation, write conditioned on the displayed commit and `status = ready`, no silent fallback, races tested, S | Agree |
| T09 | Pre-submission persistence, server-side dedupe, serialisation, the listed tests, manual path, M | Agree, design above |
| T10 | Login, cookie, header, credentials routed not printed, no vault dependency on this session, run id and tracked inventory, S | Agree. The run id goes into every created name, and cleanup deletes only what the run's inventory lists |
| T11 | Omitted key is "omitted, effective value unverified", not "set by the file", S | Agree. The running config under Logs remains the place to read the truth |
| T12 | Shared first-blocker function, Bee progress only when the API supplies it, starting versus restarting, logs per row, M | Agree |
| T13 | Minimum correction, test the submitted credential mode, S | Agree |
| T14 | After T09 and D04, stale quote never authorises a larger spend, M | Agree |
| T15 | Draft retained through pool creation, names as recommendations, M | Agree |
| T16, T17, T18 | Unchanged, S each | Agree |
| T19 | No claim, no gate, no deploy, stale drawer must not overwrite a newer note, S | Agree. The drawer sends notes only when the operator edited them, and the PATCH carries the revision it was loaded with |
| T20 | Workflow before D06, local container job separate from the live protocol, M | Agree |
| T21 | Absent CONTEXT.md or ADRs are not a gap, correct demonstrated stale references only, S | Agree, verified at domain.md line 13 |
| T22 | Preserve the funded node, D05 first, recheck the fill's identity before any retry, L | Agree |
| D01 | Ceiling is `min(version max, 100)`, caps occupied records | Agree, my section 5 says so to Levi |
| D02 | Refuse a new uploader start when unverifiable, retry action, running uploaders untouched | Agree |
| D03 | Minimum correction ready, rest is Levi's | Agree |
| D04, D05, D06 | Levi's numbers and settings | Agree |
| D07 | Keep the default with a visible lost-approval state, no older artifact requirement | Agree |
| D08 | Defer the catalogue, keep the recovery tree | Agree. The retained previous build in T04 is that tree |
| D09 | Stack commit, bundled bump, clean.sh in the stack change, legacy disposition, no automatic restart on bump | Agree. A bump changes what the next deploy of a bundled deployment runs, never a running one |
| N01 | Pin a release and digest inside T03, no pull during the debate | Agree, and T05 adds the api image's Compose to the same rule |

Nothing in OpenAI's sections 4 and 5 is disputed. One item is revised, T04, with the design above in place of the lock.

#### 3. The R04 reproduction, as text

The script, exactly as run on 2026-09-07 on Docker 29.7.2 and Compose v5.5.1. It touches only the machine it runs on.

```bash
#!/usr/bin/env bash
# Local reproduction of the shared image tag question (R04). Two compose
# projects, one image name, different build args. Nothing here touches any
# host but this machine.
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE"
docker version --format 'docker server {{.Server.Version}}'
docker compose version
for who in a b; do
  mkdir -p "$who"
  cat > "$who/Dockerfile" <<EOF
FROM alpine:3.20
ARG WHO
ARG NONCE=0
ARG DELAY=0
RUN sleep "\$DELAY" && echo "\$WHO nonce=\$NONCE" > /who
CMD ["sleep","600"]
EOF
done
compose_file() {
  local who="$1" nonce="$2" delay="$3"
  cat > "$who/compose.yml" <<EOF
services:
  app:
    image: race-shared-image
    build:
      context: .
      args:
        WHO: $who
        NONCE: "$nonce"
        DELAY: "$delay"
    command: ["sleep","600"]
EOF
}
who_of() { docker exec "$1" cat /who 2>/dev/null || echo "no container"; }
img_of() { docker inspect -f '{{.Config.Image}} {{.Image}}' "$1" 2>/dev/null | cut -c1-60; }

echo "=== Test 1: is the container created by tag name or by the built image id? ==="
compose_file a 0 0; compose_file b 0 0
docker compose -p racea -f a/compose.yml up -d --build --quiet-pull >/dev/null 2>&1
echo "after A up --build:      racea-app-1 runs [$(who_of racea-app-1)]  image=[$(img_of racea-app-1)]"
docker compose -p raceb -f b/compose.yml up -d --build >/dev/null 2>&1
echo "after B up --build:      raceb-app-1 runs [$(who_of raceb-app-1)]  image=[$(img_of raceb-app-1)]"
echo "tag now points at:       $(docker image inspect -f '{{.Id}}' race-shared-image | cut -c1-60)"
docker compose -p racea -f a/compose.yml up -d >/dev/null 2>&1
echo "after A up (no --build): racea-app-1 runs [$(who_of racea-app-1)]  image=[$(img_of racea-app-1)]"
docker compose -p racea -f a/compose.yml up -d --build >/dev/null 2>&1
echo "after A up --build:      racea-app-1 runs [$(who_of racea-app-1)]  image=[$(img_of racea-app-1)]"

echo "=== Test 2: concurrent up --build from both projects, cache busted, random build delays ==="
mismatch=0; runs=${RUNS:-16}
for i in $(seq 1 "$runs"); do
  compose_file a "$i" "$(( RANDOM % 3 ))"; compose_file b "$i" "$(( RANDOM % 3 ))"
  docker compose -p racea -f a/compose.yml up -d --build --force-recreate >/dev/null 2>&1 &
  docker compose -p raceb -f b/compose.yml up -d --build --force-recreate >/dev/null 2>&1 &
  wait
  wa=$(who_of racea-app-1); wb=$(who_of raceb-app-1)
  flag=""
  case "$wa" in a*) ;; *) flag="  <-- A runs the wrong content"; mismatch=$((mismatch+1));; esac
  case "$wb" in b*) ;; *) flag="$flag  <-- B runs the wrong content"; mismatch=$((mismatch+1));; esac
  echo "run $i: A=[$wa] B=[$wb]$flag"
done
echo "mismatches: $mismatch of $((runs*2)) container creations"
docker compose -p racea -f a/compose.yml down --rmi local >/dev/null 2>&1
docker compose -p raceb -f b/compose.yml down --rmi local >/dev/null 2>&1
docker image rm -f race-shared-image >/dev/null 2>&1 || true
echo "cleaned up"
```

Raw result of the round 1 run, unchanged:

```text
docker server 29.7.2
Docker Compose version v5.5.1
=== Test 1 ===
after A up --build:      racea-app-1 runs [a nonce=0]  image=[race-shared-image sha256:db00064d...]
after B up --build:      raceb-app-1 runs [b nonce=0]  image=[race-shared-image sha256:2192d7e9...]
tag now points at:       sha256:2192d7e9...
after A up (no --build): racea-app-1 runs [b nonce=0]  image=[race-shared-image sha256:2192d7e9...]
after A up --build:      racea-app-1 runs [a nonce=0]  image=[race-shared-image sha256:686bd274...]
=== Test 2 ===
run 1: A=[a nonce=1] B=[a nonce=1]  <-- B runs the wrong content
run 2: A=[b nonce=2] B=[b nonce=2]  <-- A runs the wrong content
run 3 to 4: correct
run 5: A=[b nonce=5] B=[b nonce=5]  <-- A runs the wrong content
run 6 to 7: correct
run 8: A=[a nonce=8] B=[a nonce=8]  <-- B runs the wrong content
run 9: A=[a nonce=9] B=[a nonce=9]  <-- B runs the wrong content
run 10 to 12: correct
run 13: A=[b nonce=13] B=[b nonce=13]  <-- A runs the wrong content
run 14: A=[a nonce=14] B=[a nonce=14]  <-- B runs the wrong content
run 15 to 16: correct
mismatches: 7 of 32 container creations
```

Assertions for the T05 acceptance test, which extends this script:

1. Control, shared tag as above, sixteen rounds: at least one mismatch is expected. Zero mismatches make the run inconclusive, not a pass, and the run is repeated with longer delays.
2. Corrected variant, the `image:` line removed from both compose files so Compose names them `racea-app` and `raceb-app`: zero mismatches in sixteen rounds, and `Config.Image` of each container is its project's own name.
3. Two viewers from one source with different build arguments, and two builds from different sources, both under the corrected variant: each container's content matches its intended input.
4. `down --rmi local` on one project removes that project's image and leaves the other's.
5. The Docker Engine and Compose versions are printed and recorded, and the run is on those the api container uses, or the difference is stated.

#### 4. Consolidated task set, Fable's proposal

Each row is the task as amended by OpenAI round 2 and this round together. "Both rounds agree" means OpenAI's round 2 refinement and my answer above say the same thing. "Design proposed" means this round put a design in front of OpenAI that it has not yet answered. No row is jointly agreed until OpenAI says so in round 3.

| Task | Depends on | Decision needed | Size | State |
| --- | --- | --- | --- | --- |
| T02 SRS check isolation | none | none | S | Both rounds agree |
| T10 authenticated test client | none | none | S | Both rounds agree |
| T13 SRT default, minimum | none | D03 only beyond the minimum | S | Both rounds agree |
| T19 notes route | none | none | S | Both rounds agree |
| T11 effective settings | none | none | S | Both rounds agree |
| T16 validation feedback | none | none | S | Both rounds agree |
| T17 endpoint rendering | none | none | S | Both rounds agree |
| T08 approval bound to a build | T04 for build identity, two parts are independent | D07 for the default's behaviour | S | Both rounds agree |
| T07 proposed-state validation | none | D02 for the unverifiable-node refusal | S | Both rounds agree |
| T01 config rollout ownership | none | none | M | Design proposed |
| T03 OME contract and copy | T01 | none | M | Design proposed |
| T04 immutable builds and running state | none | D08 only for a later catalogue | M, upper end | Design proposed |
| T05 per-project images | D09 | D09 | S stack, S manager | Both rounds agree on the fix, interim serialisation proposed |
| T06 port reservations and cap | none | D01 for the cap part | M | Design proposed |
| T09 money by transaction identity | T10 for integration coverage | none | M | Design proposed |
| T12 readiness and diagnostics | T07, T11, chequebook wording after T09 | D02 | M | Both rounds agree |
| T14 guided stamp purchase | T09 | D04 | M | Both rounds agree |
| T15 ABR prerequisites | T12 | none, names to Levi's walkthrough | M | Both rounds agree |
| T18 narrow layouts | T04, T08 for version states | none | S | Both rounds agree |
| T20 CI and merge gate | T10 | D06 for protection only | M | Both rounds agree |
| T21 documentation | the tasks it documents | none | S | Both rounds agree |
| T22 live acceptance run | T10 and the fixes it exercises | D05 | L | Both rounds agree |

Ready first, unchanged from round 1 and accepted by OpenAI: T02, T10, T13 minimum, T19, T11, T16, T17, and the two independent parts of T08. "Ready" is a roadmap state. Implementation is not authorised by this document.

#### 5. Decisions that still block scheduling

Recommendations stand as written in round 1 section 6 with OpenAI's qualifications adopted. What each blocks:

- **D01** blocks the cap part of T06 only. The reservation mechanism can be built without it.
- **D02** blocks the refusal in T07 and T12. The rest of both tasks can be built.
- **D03** blocks nothing in the set. T13's minimum correction is ready.
- **D04** blocks T14 entirely.
- **D05** blocks every paid step of T22. The read-only preflight can be prepared.
- **D06** blocks the branch protection in T20. The workflow file can be written.
- **D07** blocks the default's behaviour in T08. The bundled invalidation and the conditioned Tested write are independent of it.
- **D08** blocks nothing. The recovery tree is inside T04 either way.
- **D09** blocks T05's stack commit and bundled bump. The interim serialisation and the contract flag are manager work and do not wait for it.

#### 6. Register update

I updated only the Fable position cells. Every state stays as OpenAI left it. Nothing is marked jointly agreed by me.

#### 7. Remaining disagreements and questions for OpenAI round 3

Disagreements from my side: none of substance. One revised position awaits OpenAI's answer, T04's design in place of an admission lock.

Questions:

1. T04: does the immutable per-build layout with the row as the active reference close the three gaps to your satisfaction, without the row lock? If you still want the lock, name the interleaving it prevents that the layout does not.
2. T01: do you accept the persisted operation table, the instance id, the watch started from the success hook, and the restart table as the durable rule?
3. T03: do you accept the path-pattern derivation as the complete contract for the bundled template, and the pinned-pair procedure in place of a version I would have to guess?
4. T06: do you accept the reservation table, protocol from the compose file, and revalidation at admission after a contract change?
5. T09: do you accept the nonce and block-scan recovery for a transaction mined out of the pending list, and the decode rule for candidates?
6. T05: is serialising deploys of versions that still build shared tags an acceptable interim mechanism, and do you agree the Compose to record and pin is the api image's?
7. If the answers are yes, will you approve the task set in section 4 as the recorded set, so the document can go to Levi with section 5 as his list?

#### Handoff prompt for OpenAI round 3

The prompt Levi relays is at the end of this document, under "Handoff prompts".


### OpenAI round 3, 2026-09-07

Author: Codex, OpenAI-hosted. Model family: GPT-6, as identified by this session's instructions. The exact serving model identifier is not exposed here. Provider: OpenAI. **cross-provider review, OpenAI-hosted**.

The immutable-directory approach is a sound replacement for the long Update/deploy exclusion I proposed. I withdraw that lock requirement for immutable build contents. I cannot approve the complete recorded task set yet. Build lifetime and migration, durable stop invalidation, port handover and uncertain transaction recovery still have specific gaps. One existing inspection-adapter bug also undermines the proposed config-watch rule.

#### 1. Baseline and evidence boundary

The first commands were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD remains **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64**. The diff is empty. Initial status was only `?? .scratch/`.

I read the repository instructions and the document, including Fable round 2 sections 1 through 7, its script, consolidated task set and decision list. I also compared the earlier proposal and comments with the version read in round 2. They were unchanged. This round checks local source and primary Docker/Ethereum documentation. The counterexamples below are source or design analyses, not newly executed integration tests.

No test suite, build, container or infrastructure operation ran. The R04 script was read as text only. No new live observation is claimed. The funded deployment remains protected, and **the 0.5 BZZ fill's submission remains unverified**. Neither a retry nor a statement that it was unsent or settled follows from this round.

#### 2. Answers to Fable's seven questions

##### Question 1. T04 immutable directories and the database reference

**Revise. Accept the architecture and withdraw a build-duration admission lock. Do not yet accept the full lifecycle design.**

Resolving one complete, immutable build at admission lets a deploy use A while Update builds and publishes B. Neither operation needs to wait for the other's build. The admitted descriptor must contain the path, build identity and matching contract together. Publishing the active reference, contract and approval change must be one database operation. A deploy must not select path A and later reread contract B.

The existing code rereads the version inside `startReservedJob` at [DeploymentOrchestrator.ts:410](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:410). Its reservation currently carries no build reference at [341](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:341). T04 therefore needs an explicit captured descriptor, not merely a different path resolver.

The remaining failures and smallest tests are:

| Case | Exact failure or interleaving | Smallest decisive test and required result |
| --- | --- | --- |
| Build selected while pruning | D reads active A and pauses before recording its reference. Updates publish B and then C. A is now neither current nor previous, and no snapshot or persisted deployment claim names A. Prune deletes A. D resumes. | Pause after selection and race reference acquisition against prune with a fake artifact store. Either D obtains a retained reference before deletion, or it must reselect/refuse before starting. It must never launch from a deleted path. |
| Partial deploy survives a crash | D creates an engine from B, then the manager dies before writing the per-service snapshot. Boot changes DEPLOYING to ERROR. Later updates make B eligible for pruning, although the engine still mounts B. | Persist a job naming B, simulate container creation followed by a crash before snapshot, then run restart reconciliation and prune. B must remain protected until the actual outcome and mount references are known. ERROR alone must not release it. |
| Same SHA is built again | A complete `builds/A` already exists. Another Update resolves A and tries to rename a fresh `A.tmp` into that published path. The design does not say whether it reuses, replaces or fails. | Repeat an Update for A with deliberately different candidate bytes. Either reuse the verified A unchanged, or publish a distinct build identity. Never replace files under an existing published path. |
| New-layout artifact is missing | The row names B in the new layout, but B or its complete marker is missing. “Use the flat root otherwise” silently deploys old A while labeling it B. | Use an explicit new-layout row pointing to an absent or incomplete B, with a valid old flat root present. Launch must refuse and name the missing artifact. Flat fallback is allowed only for an explicitly unmigrated legacy row. |
| Legacy tree contains its new children | After first migration, `root/` is the old flat artifact and `root/builds/B` is the new artifact. Treating `root/` as a normal old build to prune would also delete B and `root/repo`. | Build a path-only migration fixture with the old root as an ancestor of the current build. The prune planner must never schedule that ancestor. Cleanup must distinguish legacy files from the new artifact container directory. |
| A referenced temporary build is deleted after restart | Boot or the next Update deletes every `.tmp` directory, but a surviving builder may still be writing its candidate. | Simulate manager death while a builder remains active. Restart reconciliation must fence or account for that attempt before cleaning its directory. A new attempt must not share the same scratch path. |

The fix for the first two cases is short-lived coordination between **reference acquisition and garbage collection**, plus durable job references through reconciliation. This is different from holding a lock for a minutes-long build. A database build-reference record acquired transactionally with deploy admission is one suitable approach. Retain references for unresolved jobs, stopped containers and T01 rollback targets as well as successful snapshots. Snapshot failure must preserve the job's reference. The current snapshot path catches failures and logs a warning at [DeploymentOrchestrator.ts:701](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:701), so snapshot existence is not a safe lifetime boundary.

Two more boundaries need correction before this design is called immutable:

- The proposed build still receives mutable `.env.<profile>`, engine env and deploy-override files. The manager writes a profile env at [DeploymentOrchestrator.ts:419](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:419), and the stack writes per-profile overrides at [deploy.sh:529](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/scripts/deploy.sh:529). Define immutable code/templates separately from writable deployment runtime files. Retain a consistent runtime-input snapshot for the admitted job. Copying a host file while another process updates it cannot create a half-written candidate. This can use atomic replacement or a coordinated snapshot. It does not require a global build lock.
- `.stack-commit` inside a build is a valid new manifest choice, but the cited existing helper does not read that location. [bundledCommit.ts:48](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/versions/bundledCommit.ts:48) reads the marker in the directory's parent. Update the reader and tests explicitly. Do not depend on today's helper accidentally finding the new manifest.

**Bundled scope remains open.** Fable explicitly leaves the bundled tree mutable and calls it a follow-up outside this set. I do not approve that exclusion on Levi's behalf. The existing release script overwrites it through rsync at [deploy/deploy.sh:90](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/deploy/deploy.sh:90). SRS and OME bind-mount templates and entrypoints from that tree at [docker-compose.yml:139](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/docker-compose.yml:139) and [174](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/docker-compose.yml:174). A later restart can therefore combine an old container with replacement host files. Per-service source labels cannot establish that the mount contents stayed at the labeled revision.

Include a bundled/legacy publication and migration slice in T04 that preserves existing mount targets until an explicit rollout. Alternatively, present that exact remaining risk as an owner scope decision before excluding it. D08's optional historical catalogue does not decide this question. The smallest regression is a fixture representing a bundled container mounted to A, followed by publication of B and a restart: it must retain a consistent A or move through an explicit consistent B rollout. No host execution is needed to specify that test.

Per-service revisions and a last-full-deploy revision are accepted. Distinguish the artifact intended by the job from observed container and mount identity. A no-op or failed partial deploy must not label untouched services with B. The provisional M estimate must be revisited after the bundled migration and reference-lifetime work are sized.

##### Question 2. T01 persisted operation and restart rule

**Revise. Accept the operation table, instance UUID, expected revision and success-hook watch start. Dispute the claim that current status makes Stop durably sufficient.**

The persisted rollback target and template flag solve the lost-closure problem. Starting the watch after committed RUNNING also resolves the original finalizer race. The remaining rules need these changes:

| Case | Exact failure | Smallest decisive test and correction |
| --- | --- | --- |
| Stop, start and manager restart | A is persisted as watching at revision r. Stop aborts its in-memory watch and reaches STOPPED. Start reaches RUNNING with the same instance and r. The manager restarts. A still says watching, so boot can revive it and later revert the operator's new start. | Drive Stop and Start without changing the config revision, reconstruct the service from the stored rows, then supply a failed inspection. A must remain superseded and perform no config write or recreate. Persist invalidation in the accepted Stop transaction, or use an equally durable intent generation. |
| Healthy container predates recreate completion | The container starts at t=5, Compose completes at t=8, and the watch begins at t=9. At boot it is healthy with StartedAt=5. It does not satisfy “started after recreate_finished_at=8”, and none of the other table rows describes that healthy case. | Give the reconciler these three timestamps and a matching container identity. It must recognize the expected container. Save and compare the observed container ID/spec, with timestamps as supporting evidence. Do not require start after completion. |
| Recovery is interrupted | The operation has entered reverting and the previous config was stored. The manager stops before recovery completion. The boot table omits reverting. Marking failed before attempting recovery can also release the open-operation guard while recovery still acts. | Restart once before recovery spawn and once after the recovery container starts but before completion is persisted. Keep the operation nonterminal while recovery is unresolved. Reconcile it, or show interrupted recovery with explicit actions. Never silently strand it or repeat an unbounded recovery attempt. |
| Failure callback loses ownership | A's recreate fails. Before its recovery write/claim, B or Stop takes ownership. A's failure handler still attempts its saved recovery. | Pause A's failure callback, accept B or Stop, then resume A. A must fail its operation/instance/revision/intent checks before any write or launch. Use the same owned recovery transaction for failure recovery as for watch-triggered revert. |
| Terminal success survives newer intent | A's final healthy tick is in flight while B supersedes A. An unconditional completion write would relabel A applied after it lost ownership. | Pause the final tick, supersede A, then finish the tick. The completion transition must be conditional on A still owning the operation and revision. |

The restart table also needs a deliberate row for `interrupted`, so it is clear whether it retains an open-operation constraint and which action supersedes it. Every boot path must check the persisted operator intent before interpreting unhealthy containers as permission to recover. A stopped deployment must stay stopped. An old action's button must not apply to a new instance with the same name.

**Additional code evidence within R01/T01:** the Docker inspection adapter currently reads the restart count from the wrong object. [ContainerControl.ts:228](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ContainerControl.ts:228) uses `info.State.RestartCount ?? 0`. The declared interface puts it under State as well. Docker's inspect response puts `RestartCount` beside `State`, as shown in the [Moby Engine API type](https://github.com/moby/moby/blob/v27.5.1/api/types/types.go#L225). A container that restarted and is running again between polls can therefore be reported as running with zero restarts.

The smallest regression passes a realistic inspect response with top-level `RestartCount: 2` and `State.Status: "running"` through the actual adapter, then through the watch. It must produce restart count 2 and the failure/recovery path. Add this to T01. The existing service test supplies an already-normalized restart count, so it does not verify the Docker response mapping. This is source-confirmed adapter evidence, not a claim that the live node was inspected during this round.

##### Question 3. T03 path-pattern contract and pinned pair

**Revise one contract rule. Agree with the pinned-pair procedure and the liveness boundary.**

The named-app/path approach is a suitable way to derive required integration elements from the selected template. It covers the missing admission enablement, provider/publisher paths and stream-name mapping identified in round 2. I accept sibling-order independence and the requirement to test a real, identified image/template pair instead of guessing a release. If the historical image cannot be recovered, record a newly verified compatible pair and that limit.

However, comparing the exact template text for **every** placeholder-bearing element also freezes ordinary tuning fields. For example, replacing `SEGMENT_DURATION_PLACEHOLDER` with a supported literal duration would be rejected despite preserving the stream integration. The current editor explicitly supports choosing where template substitution applies at [EngineConfigDialog.tsx:39](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/frontend/src/forms/EngineConfigDialog.tsx:39). [engineConfig.ts:89](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/common/src/engineConfig.ts:89) reports settings whose placeholders the custom file omitted. This is an existing capability, not a new feature request.

Separate required integration values from tunable settings. Keep the callback path, compatible bind ports, admission secret substitution and stream-discovery mapping protected. Permit supported numeric literals for segment duration/count, validate them, and report their source through T11. Do not silently remove that editing capability.

**Smallest test:** start from the bundled OME template and replace only its segment-duration placeholder with a valid literal. The structural contract should accept it and the UI should identify the setting as controlled by the file. Then change only the callback route while retaining all its placeholders. That must be refused. Include the healthy pinned-container control in later isolated validation.

I accept the proposed TCP probe as diagnostic liveness only and the no-funds SRT-to-admission-to-HLS test as the integration gate. Passing that release test must not turn every live “TCP reachable” observation into “publishing verified”. Unknown or unreachable remains visible. N01 stays in T03, with a tested release and immutable digest.

##### Question 4. T06 port reservation table

**Revise the handover rule. Accept the table, atomic allocation and protocol-aware approach.**

A uniqueness rule on canonical host, transport and port is a good conservative reservation mechanism. Insert profile/group and reservations in one transaction. Keep the lower version maximum and D01's separate cap decision. Parse both supported short and long Compose port forms, including explicit protocols and the TCP default. These are separate fields in [Docker's port mapping specification](https://docs.docker.com/reference/compose-file/services/#ports). Unknown mappings must refuse safely.

Admission-time revalidation needs an explicit rule for **old bindings that remain active while new ones are being deployed**. A slot's newly requested ports do not replace the ports still held by existing services merely because admission succeeded.

| Case | Exact failure or missing boundary | Smallest decisive test and correction |
| --- | --- | --- |
| Port handover fails midway | A currently binds TCP p. Its new contract requests q. If admission replaces reservation p with q, B may reserve p while A's old container is still running. A's recreate then fails, leaving p active and unreserved. | Pause A after new admission but before old-container removal. Try allocating p to B and then fail A's recreate. B must be refused. Retain the union of old active/rollback bindings and new reservations until actual release is verified. |
| Partial deploy preserves old services | Only A's engine moves to a new contract. Its uploader remains on old ports. Replacing A's entire set with the new contract releases ports still used by that uploader. | Move one service only. Assert old reservations remain for untouched services, even when the profile is marked RUNNING. |
| Contract changes between check and launch | A validates/reserves contract X. Update publishes Y before the deploy resolver reads its inputs. Launch uses Y without Y's reservation. | Publish Y after A's reservation. The admitted job must use pinned X throughout, or reacquire all validation/reservations before using Y. This must share T04's captured build descriptor. |
| Migration begins with an empty reservation table | Existing deployments already bind ports, but new allocations start before those bindings are reserved. | Seed an existing profile/container, run the migration and race a new allocation for its port. Allocation stays gated until the existing inventory is represented or a conflict is reported. No existing deployment is renumbered or stopped. |

Use a canonical physical host/daemon identity for `host`, not an arbitrary public hostname spelling. If all bindings on that host are reserved conservatively, say so. A host alias must not create a second reservation namespace for the same Docker daemon. Deduplicate a profile's own overlapping planned/active reservations while preserving their service/build reasons.

The prune-equivalent rule is simple: absence of a successful deploy snapshot is not proof that a port is unused. Retain reservations through failed and interrupted operations until reconciliation proves release. Stopped profile records still keep the reservations required for their permitted future starts.

M remains a provisional estimate. T06 can begin independently, but final admission and contract-change acceptance must integrate with T04. The consolidated row should state that dependency.

##### Question 5. T09 nonce and block-scan recovery

**Dispute the unchanged-nonce retry rule. Accept nonce/block scanning as evidence collection, with stronger identity and resolution conditions.**

The pre-submission row, one open operation per node, receipt polling and candidate decoding are the right components. A node key must include chain ID and its stable Ethereum identity, so two deployment records referring to the same node cannot bypass the guard. An idempotent repeated request must return the existing operation or its conflict reference without sending again.

The critical correction is that **unchanged transaction count does not mean nothing was sent**. The count is queried at a specified block state, and latest differs from pending. A receipt can be absent while a transaction is pending. Those are the [Ethereum JSON-RPC semantics](https://ethereum.org/developers/docs/apis/json-rpc/#eth_gettransactioncount). Pending/queued transaction inspection is also node-local evidence, with possible same-nonce replacement candidates, as documented by [Geth's transaction-pool API](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-txpool).

Exact counterexamples and tests:

| Case | Exact failure | Smallest decisive test and required result |
| --- | --- | --- |
| Accepted but not yet mined | Initial latest nonce is n. Bee submits n and its HTTP response is lost. No block includes it during the bounded wait, so latest nonce remains n. The proposed rule offers a second submission. | Fake Bee records one accepted transfer then drops the response. RPC keeps latest nonce at n with no receipt. Expire the wait and repeat the request. Submission count must remain one and the operation must stay unknown/pending. |
| Pending observer has not seen it | Bee's backend has accepted a transaction, but the RPC backend queried for pending state does not report it yet, or Bee is still completing the timed-out submission. Both nonce and pending-list evidence look unchanged. | Use separate fake submission and observation backends. Delay visibility beyond the reconciliation window. No automatic retry or unlock is allowed. Changing the tag to pending does not fix the inference. |
| Another transaction consumes the sampled nonce | The manager reads n. Bee or another authorized actor sends an unrelated transaction at n before this transfer is assigned n+1. Finding a successful receipt at n does not identify this operation. | Scan a block containing an unrelated transaction at n and the intended transfer at n+1. Match sender, chain, destination, decoded recipient/amount and the operation's evidence bounds. Never adopt n solely because it was sampled. |
| An unrelated pending transaction hides a mined one | The intended transfer has mined out of Bee's list, but a different pending transaction remains. The described second step runs only when the list is empty. | Return a nonempty list with no matching candidate and a matching mined transfer. Chain recovery must still run. Trigger it on absence of a unique matching candidate, not only an empty list. |
| Manual resolution names the wrong transfer | The operator supplies a successful hash for a different sender, amount or recipient. Receipt success alone would release the lock for this operation. | Supply an unrelated successful receipt, then a matching pending hash. Neither resolves the operation as settled or releases it as safely retryable. Require the complete transaction identity and a verified terminal outcome. |

A nonce read before calling Bee is an observation bound, not a reserved nonce. It narrows a search but cannot identify the transfer by itself. The decode rules for token transfer to this chequebook and withdrawal of the requested amount are reasonable candidates, subject to verification against the deployed Bee/token/chequebook ABI. Keep unknown-chain refusal. Check the sender and chain in all recovered and manually supplied transactions. A single superficially matching candidate is insufficient if other evidence permits several indistinguishable operations.

Persist a scan starting block number/hash before submission, the explicit nonce-query tag and the reconciliation cursor. Bound scan work and continue it across restarts. An incomplete scan, RPC outage, replacement or a changed canonical chain remains unresolved until the chosen receipt-confirmation rule is met. No scan result proves global absence of a submission. If pending candidates disappear, continue reconciliation instead of inferring failure.

The manual route remains useful for supplying transaction evidence. **An operator assertion must be recorded as an assertion, not silently converted into a verified outcome that enables a duplicate.** A matching pending hash remains pending and protected. If Levi wants an explicit override despite unresolved submission, that is a separate product decision with the duplicate-spend consequence stated. It is not implied by D04/D05 and is not an implementation shortcut approved here.

The amount and direction must never be inferred from a balance delta. No hash recovery or receipt rule in this proposal changes the present status of the funded 0.5 BZZ fill.

##### Question 6. T05 interim serialization and the api image's Compose

**Agree with the mechanism and tool identity. Revise its acceptance boundary and scheduling row.**

Serializing legacy shared-tag build-and-create operations per Docker daemon is a sufficient interim approach if every competing manager deployment path participates and the lock remains effective through actual Compose completion. Fixed project-specific images can still build concurrently. I accept adding the contract flag and identifying the Compose executable in the api image. [manager/Dockerfile:39](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/Dockerfile:39) installs the CLI packages without exact versions, and [manager/docker-compose.yml:40](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/docker-compose.yml:40) connects that client to the host daemon. Record and pin the tested api toolchain identity. Do not invent the currently deployed version.

The task needs one durability assertion: if the manager dies while an earlier legacy deploy still builds or creates containers, its replacement must not start a conflicting legacy deploy just because an in-memory mutex disappeared. Define process-owned exclusion or restart reconciliation that prevents this overlap. **Smallest test:** hold legacy job A between build and create, simulate manager replacement, request B, and assert B cannot enter the conflicting section until A is completed or safely reconciled. Also cover group/initial deploy paths and contract classification failure. Unknown classification cannot silently mean “safe to run concurrently”.

I read the R04 script and accept its historical role as Fable's local reproduction. It was not run here. For the acceptance harness, verify both subprocess exit codes and exact expected content including the nonce. Missing containers and failed builds must be reported separately from wrong-content outcomes. A fixed number of clean runs is evidence, not the whole proof of exclusion. Keep a controlled interleaving test and a bounded shared-tag control. Cleanup must be confined to uniquely owned local test resources.

The consolidated row currently lists D09 as a dependency for all of T05, while section 5 correctly allows the manager's interim mechanism before D09. Split the row into manager interim protection/toolchain evidence and stack image naming/bundled rollout. Only the latter waits for D09. No change to the accepted project-specific naming fix.

##### Question 7. Approval of the recorded set

**Revise. Approve the unaffected rows and the owner-decision list below. Do not approve the whole task set yet.**

The changes are now about exact acceptance boundaries, not the finding priorities or overall phase order. The following table is my row-by-row disposition of **Fable round 2 section 4, as amended by the earlier attributed rounds**. “Approve” is planning agreement with Fable's recorded scope, dependencies and provisional size. It is not implementation authorization.

#### 3. Consolidated task set, OpenAI row-by-row disposition

| Fable section 4 row | OpenAI round 3 | Dependency, size or scope change |
| --- | --- | --- |
| T02 SRS check isolation | **Approve.** | None. Per-request ownership, cleanup and controlled race coverage are agreed. |
| T10 authenticated test client | **Approve.** | None. Run-owned inventory and authenticated negative tests remain required. |
| T13 SRT default, minimum | **Approve.** | None. Broader policy remains outside the minimum correction. |
| T19 notes route | **Approve.** | None. Conditional notes writes and stale-drawer protection remain part of acceptance. |
| T11 effective settings | **Approve.** | None. Reliable file-derived values and explicit unknowns are agreed. A Logs view is evidence when available, not a substitute for unknown handling. |
| T16 validation feedback | **Approve.** | None. |
| T17 endpoint rendering | **Approve.** | The initial correction is independent. Integration with T06's richer contract remains required where that contract supplies endpoint metadata. |
| T08 approval bound to a build | **Approve.** | Keep its T04 identity dependency, two independent fixes and D07 policy gate. If T04 allows distinct rebuilt artifacts at the same SHA, approval must identify that artifact rather than migrate between them by SHA alone. This follows the recorded artifact-approval criterion. |
| T07 proposed-state validation | **Approve.** | None. D02 gates only unverifiable-node policy. |
| T01 config rollout ownership | **Revise.** | Add durable Stop invalidation, complete restart/recovery transitions, conditional completion and the Docker restart-count adapter regression from answer 2. M stays provisional. |
| T03 OME contract and copy | **Revise.** | Preserve supported literal tuning while protecting integration values. Accept the pinned-pair procedure and T01 dependency. M stays provisional. |
| T04 immutable builds and running state | **Revise.** | Accept database publication of immutable artifacts and no build-duration lock. Add atomic reference acquisition versus prune, unresolved-job retention, explicit migration state, consistent runtime inputs and bundled/legacy scope. Re-estimate after those slices are explicit. D08 is only the catalogue question. |
| T05 per-project images | **Revise acceptance and scheduling.** | The image fix and legacy serialization principle are accepted. Separate independent manager work from the D09 stack/bundled work. Add crash-safe exclusion and reliable test outcome classification. S plus S is provisional for that full scope. |
| T06 port reservations and cap | **Revise.** | Add old/new reservation handover and migration gating. Coordinate final admission tests with T04's pinned contract. M remains provisional. D01 gates only the cap. |
| T09 money by transaction identity | **Revise.** | Remove nonce-based absence/retry inference. Specify bounded resumable scanning, full candidate identity and evidence-based manual resolution. Keep T10 dependency. M remains provisional. |
| T12 readiness and diagnostics | **Approve.** | Keep T07/T11 dependencies, only settlement wording after T09, and D02 for the refusal policy. |
| T14 guided stamp purchase | **Approve.** | Keep T09 and D04. A guided quote does not override unresolved submission handling. |
| T15 ABR prerequisites | **Approve.** | Keep T12 and the naming walkthrough. |
| T18 narrow layouts | **Approve.** | Keep T04/T08 for final version states. |
| T20 CI and merge gate | **Approve.** | Keep T10 and D06 for protection only. Add the agreed implementation regressions to their relevant jobs as they land. |
| T21 documentation | **Approve.** | Keep its dependency on the implemented tasks and the absent-domain-doc retraction. |
| T22 live acceptance run | **Approve.** | Keep T10, the relevant fixes and D05. The fill's submission identity and all unfinished E2E remain unverified. |

Six rows need a revised recorded design or acceptance boundary: **T01, T03, T04, T05, T06 and T09**. The other sixteen are approved on the basis stated above. The ready-first set remains T02, T10, T13 minimum, T19, T11, T16, T17 and T08's two independent corrections.

I accept the broad phase order. Phase 0 records the host Engine and the api container's actual Compose version, with no experiment on the funded host. T02 remains first in phase 1. The T05 manager slice may proceed before the D09 stack/bundled slice once separately authorized.

#### 4. Decision list, OpenAI disposition of Fable section 5

I approve **D01 through D09 as the recorded recommendations and scheduling gates**, with the qualifications already adopted by Fable. These remain decisions for Levi. Approval here does not mean Levi has chosen their outcomes.

| Decision | Disposition | What it blocks |
| --- | --- | --- |
| D01 | **Agree.** | The optional 100-record ceiling in T06, always respecting a lower stack maximum. Physical reservation correctness can be built independently. |
| D02 | **Agree.** | The proposed unverifiable-node refusal in T07/T12. Other validation and diagnostic work can be built. Running streams stay untouched. |
| D03 | **Agree.** | Nothing in T13's minimum correction. Existing credentials and explicitly available modes remain governed by the recorded policy. |
| D04 | **Agree.** | T14's guided spending behavior until Levi supplies the choices and limits. |
| D05 | **Agree.** | Paid T22 steps. Preflight design can be prepared. Funded assets and submission identity remain protected. |
| D06 | **Agree.** | Branch protection, not preparation of T20's workflow. |
| D07 | **Agree.** | The default's behavior after approval is cleared. Bundled invalidation and the conditioned Tested write are independent. |
| D08 | **Agree.** | No recovery work in T04. A user-facing historical-build catalogue is the optional decision. It does not authorize dropping bundled build consistency. |
| D09 | **Agree.** | T05's stack image-name change and bundled bump. The manager's interim protection and contract flag can be prepared first. No automatic running-deployment restart is authorized. |

N01's tested OME release/digest pair remains agreed inside T03. The api toolchain identity belongs in T05's verification and reproducibility work. Neither observation authorizes a pull, build or deployment during this round.

Two exclusions are **not** owner decisions already made: leaving bundled consistency outside this set, and unlocking an uncertain transfer on an unverified operator assertion. My recommendation is to correct the design within T04/T09. If Fable proposes retaining either exception, it must become an explicit, fully explained decision for Levi. Do not imply that one of D01 through D09 already approves it.

#### 5. Agreement register and remaining disagreements

Only the **OpenAI position** cells in the agreement register were changed. The Topic, Fable position and State cells are preserved. The document revision/state metadata was advanced, and this round was appended. Every earlier comment is preserved word for word.

I mark these positions jointly agreed because Fable round 2 explicitly states them and I accept them:

- The existing 25 finding dispositions and accepted priorities, including the R02/R05 rationale corrections, the narrower R08 evidence and N01's placement.
- The broad phase order and phase-0 tool-version evidence, with T05's D09 gate applying to its stack/bundled slice.
- D01 through D09 as recommendations and scheduling gates, with owner choices still open.
- The incomplete live E2E outcome and unverified 0.5 BZZ submission.

The **T01 through T22 row remains partial agreement**. The sixteen approved rows above are technical planning agreement. I do not label the other six designs complete, and I do not label the whole roadmap ready for implementation. The new inspection-adapter evidence is proposed within T01 and still needs Fable's acknowledgment.

Precise questions for Fable round 3:

1. **T04 lifetime and migration:** will you keep the immutable architecture while adding a captured build/contract descriptor, atomic reference acquisition versus prune, unresolved-job references, explicit legacy-layout state and a safe legacy-root cleanup rule? Choose reuse or distinct identity for same-SHA rebuilds. Identify how runtime files remain consistent. Can you include bundled publication consistency, or will you put its exact exclusion to Levi?
2. **T01 recovery:** do you accept durable Stop invalidation, identity-based startup verification, boot handling for reverting/interrupted, nonterminal recovery ownership and conditional completion? Confirm the top-level Docker RestartCount correction and the adapter-to-watch regression.
3. **T03 contract:** will you distinguish protected integration values from supported literal tuning, with the two config tests above, while retaining the pinned-pair procedure?
4. **T06 handover:** will you retain active/rollback ports until verified release, including failed and partial deployments, gate the initial migration and pin the validated contract to the job?
5. **T09 submission:** will you remove unchanged-nonce retry permission completely, recover after no unique match even when the pending list is nonempty, persist a bounded scan cursor, and require full transaction evidence for manual resolution? If you propose a manual uncertainty override, specify the separate owner decision instead of treating it as verified reconciliation.
6. **T05 exclusion:** specify the lifetime of the legacy lock across manager replacement and the controlled test that proves it. Confirm the independent manager slice, D09 stack slice and exact-content/exit-code assertions.
7. **Recorded set:** accept or revise the six changed rows, confirm the sixteen approved rows and D01 through D09, and publish one exact attributed task set for final approval. Keep owner exceptions and unverified runtime facts visibly separate from technical agreement.

#### Handoff prompt for Fable round 3

```text
You are Fable, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64.

First run git rev-parse HEAD and git diff --stat d046ebf HEAD. Read repository instructions and the whole document, especially OpenAI round 3 and its seven closing questions.

Append Fable round 3 under Comments after OpenAI round 3. Preserve every earlier comment word for word. Identify your actual model and provider. Update only your Fable position cells in the agreement register.

OpenAI accepts immutable artifacts with database publication and withdraws a build-duration admission lock. It still requires safe build-reference acquisition/pruning, unresolved-job retention, explicit migration and a decision on bundled consistency. It found the current Docker adapter reads State.RestartCount although Docker supplies RestartCount at the top level.

Answer every closing question and accept, revise or dispute each changed task row. For any disputed correction, give the exact counterexample and smallest decisive test. Remove the inference that an unchanged nonce proves no transaction was sent, or supply evidence that actually establishes that conclusion for the proposed path.

Six rows remain open: T01, T03, T04, T05 acceptance/scheduling, T06 and T09. Sixteen other task rows are approved as recorded in OpenAI round 3. D01 through D09 are agreed recommendations and scheduling gates, still awaiting Levi's choices. Produce one exact attributed task set for final approval. End with remaining disagreements and an OpenAI round 4 prompt, or explicit approval of the exact set if all technical differences are resolved.

Only edit this shared document. No fixes, issues, settings changes, builds, pulls, deployments or infrastructure operations. Do not run the R04 script on the host. The funded review-20260907 deployment is not disposable. The 0.5 BZZ fill's submission remains unverified. Do not call it unsent, settled or safe to retry without transaction evidence.
```

### Fable round 3, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, in Claude Code on Levi's machine. Label: **cross-provider review, Anthropic-hosted**. This round answers OpenAI round 3. It writes nothing on OpenAI's behalf and changes nothing outside this document.

#### 1. Baseline and evidence this round

- `git rev-parse HEAD` is `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. `git diff --stat d046ebf HEAD` is empty. The working tree holds only `.scratch/`.
- Read: the whole document and OpenAI round 3 twice, and for the answers below `ContainerControl.ts`, `test/support/fakeDocker.ts`, `envUtils.ts`, `ScriptRunner.ts`, the stack's `deploy.sh` around its override file, `common/src/stackVersions.ts`, `common/src/engineSettings.ts`, `common/src/engineConfig.ts` and `EngineConfigDialog.tsx`.
- Ran: nothing on the host, no container created, no experiment. One read-only `docker inspect` of an unrelated container already present on my own machine, to check where Docker puts the restart count. The funded `review-20260907` deployment was not touched, and the 0.5 BZZ fill stays unverified with no transaction identity in this document.

**OpenAI's adapter finding is confirmed, Code and Local.** The adapter reads `info.State.RestartCount` ([ContainerControl.ts:228](../../manager/src/domain/ContainerControl.ts:228)). Docker answers `RestartCount` beside `State`, not inside it: the local inspect printed a top-level `RestartCount` and no such key under `State`, which matches the Moby type OpenAI cites. So the watch's restart count is always zero today, and only a container that is not `running` at the moment of a tick triggers a revert. A container that crashed and came back between two ticks is reported healthy. The test double mirrors the wrong shape ([fakeDocker.ts:126](../../manager/test/support/fakeDocker.ts:126)), which is why the suite passes. I wrote both on 2026-09-07. This is a bug in shipped code, independent of every design below, and I propose it as its own ready-first item, T01a.

Three more facts used below:

- The manager writes `.env.<profile>` with a plain `writeFileSync` ([envUtils.ts:399](../../manager/src/utils/envUtils.ts:399)), and the stack writes one override file per profile, `deploy/.env.deploy.<profile>` ([deploy.sh:529](../../manager/swarm-hls-stream/deploy/scripts/deploy.sh:529)). Both are per profile, so two profiles never touch one file, and one profile's deploys are serialised by the claim.
- A version name holds lower case letters, digits and dashes only ([stackVersions.ts:128](../../common/src/stackVersions.ts:128)). A directory name with a dot in it can never collide with a version's root, which is where the migration layout below lives.
- Every tuning placeholder is already mapped to an engine settings field ([engineSettings.ts:197](../../common/src/engineSettings.ts:197) and [209](../../common/src/engineSettings.ts:209) for OME), and `settingsNotInConfig` already reports a dropped one ([engineConfig.ts:89](../../common/src/engineConfig.ts:89)). T03's split between protected and tunable placeholders is therefore derivable, not a new table.

#### 2. Answers to OpenAI's seven questions

##### Question 1, T04. Agree with all six cases and both boundaries. Bundled consistency is included as T04b.

The architecture stays: one immutable directory per build, the database row as the active reference, no build-duration lock. What the six cases add:

**A captured descriptor.** The deploy claim records, in the same transaction that moves the profile to DEPLOYING, the build it will run: `profiles.job_build` (build id), the commit and a hash of the contract. `startReservedJob` reads the descriptor from the reservation, never the version row again, so a deploy cannot select path A and later read contract B. The existing reread at [DeploymentOrchestrator.ts:410](../../manager/src/domain/DeploymentOrchestrator.ts:410) goes.

**Reference acquisition versus prune.** Three operations touch a version's build set and all three lock the version row. The deploy claim takes `SELECT ... FOR SHARE` on the row inside its claim transaction and writes `job_build` before commit. Publication takes `FOR UPDATE` for its one-row update. Prune takes `FOR UPDATE`, reads every reference, deletes directories, then commits. A claim that committed before prune's read is visible to it. A claim that arrives while prune holds the row waits, then reads the commit that is current after the deletion. So D can never launch from a deleted path. The lock is held for the deletion or the row update only, seconds at most, never for a build.

**What prune protects.** The version's current build, its previous build, every `profiles.job_build`, every container snapshot's `build_id`, every open `engine_config_operations` row's build, and every T01 rollback target. `job_build` is cleared only when a later success hook writes the per-service snapshot, when boot reconciliation inspects the containers and writes snapshots from their observed mounts, or when the deployment is removed. The orphan reset that marks a crashed job ERROR does not clear it. Snapshot failure keeps it, which is what makes the warning at [DeploymentOrchestrator.ts:701](../../manager/src/domain/DeploymentOrchestrator.ts:701) survivable.

**Same commit built again.** Reuse. An Update that resolves a commit already published as a complete build adopts it without rebuilding, and says so. A forced rebuild is a separate explicit action and yields a distinct identity, `<commit>-r<n>`, under its own directory. Files under a published path are never replaced. The row carries `build_id` and `commit_sha` separately, and T08's approval keys on `build_id`, which answers OpenAI's note on T08.

**Explicit layout state.** `stack_versions.layout` is `legacy` or `builds`. A `legacy` row deploys from its flat root. A `builds` row whose `builds/<id>/.complete` is missing refuses every deploy naming the missing artifact. The flat fallback exists only for a `legacy` row. The first successful publication flips the row to `builds` in the same transaction.

**Legacy root and new children.** The new directories are siblings, not children: `<versions>/<name>.repo/` and `<versions>/<name>.builds/<id>/`. A dot cannot appear in a version name, so nothing collides, and the legacy root `<versions>/<name>/` is never an ancestor of a build. The prune planner may schedule the legacy root only as a whole, only once the row is `builds`, and only when no reference names it. Migration moves the existing `.git` to `<name>.repo/.git` and touches nothing else in the flat tree, so running containers keep their mounts.

**Surviving builders.** The api process dies with its container, and the build script is its child ([ScriptRunner.ts:67](../../manager/src/domain/ScriptRunner.ts:67)), but the `docker run` it started keeps writing into its staging directory on the host. So each attempt gets its own directory, `<name>.builds/tmp-<attempt id>`, and its build container gets `--name stack-build-<attempt id>`. Boot marks the attempt interrupted and deletes a `tmp-` directory only when no container of that name exists any more. A new attempt never shares a path.

**Immutable code, writable runtime files.** A build directory is immutable except for a named runtime set: `.env.<profile>`, `engines/<engine>/.env.<profile>` and `deploy/.env.deploy.<profile>`, each per profile, each written by exactly one deploy at a time because the claim serialises a profile's deploys. The manager's write becomes temp-and-rename. The host-owned base files are copied into a candidate after the build from an in-memory read, and the job records the hashes of the base env and of the profile env it wrote, so what a job ran with is attributable afterwards. No global lock.

**The manifest reader.** Each build carries `.stack-manifest.json` with commit, build id, built-at and toolchain identity. A new reader with its own tests reads it. The parent-directory helper at [bundledCommit.ts:48](../../manager/src/domain/versions/bundledCommit.ts:48) is not relied on.

**Bundled consistency, T04b, included.** The manager's own `deploy.sh` currently rsyncs the bundled stack over the mounted tree ([deploy/deploy.sh:90](../../deploy/deploy.sh:90)), and the engines bind-mount templates and entrypoints from that tree, so a restart after a manager deploy mixes an old container with new files. T04b: the manager's deploy publishes each bundled stack into `<versions>/bundled.builds/<commit>/` as a fresh directory with a manifest, never over an existing one, and the api resolves the bundled root from `manager/.stack-commit` to that directory. `SHLS_ROOT` remains the fallback for an unmigrated host, and the Versions page says which is in use. The same prune rule applies. Smallest regression, as OpenAI wrote it: a fixture with a bundled container mounted from A, publication of B, a restart, and the assertion that the container still reads A until an explicit rollout moves it to B. Sizes: T04a M at the upper end, T04b S to M. Deferring T04b would be a scope choice for Levi and is shown as a separable row in section 3, not hidden.

Per-service revisions and last-full-deploy revision: unchanged from round 2, with the job's intended build kept separate from the observed container and mount identity.

##### Question 2, T01. Agree with all five cases, the interrupted row, and the adapter correction.

- **Durable Stop.** Every operator action on a deployment bumps `profiles.intent_revision` in its own transaction: apply, reset, stop, start, edit, remove. An operation captures the value at creation, and every conditional write checks state, instance, config revision and intent revision together. Stop's transaction also moves any open operation to `superseded` explicitly, so the fact is durable and readable, and the in-memory abort remains for promptness. OpenAI's Stop, Start, restart sequence then fails A's checks at boot on the intent revision alone.
- **Identity-based startup verification.** At watch start, after RUNNING is committed, the operation records the container id and its `StartedAt`. At boot the reconciler compares ids. Same id, running, restart count zero: a fresh full watch. Same id but restarted or not running: failure evidence, revert through the owned path. Different id: someone recreated it, the operation is `superseded`. Inspection impossible: `interrupted`. Timestamps are supporting evidence only. "Started after completion" is gone.
- **Interrupted recovery.** `reverting` is nonterminal. At boot, with the profile already ERROR from the orphan reset, the operation stays open and the card says "Recovery interrupted. The previous file is stored, the engine was not verified." with two actions: recreate on the previous file, or verify now. Both are new operations that supersede the old one in their first transaction. No unbounded automatic retry.
- **Failure callback ownership.** The non-zero-exit handler runs the same owned recovery transaction as a watch-triggered revert. If B or Stop took ownership meanwhile, the checks fail and A ends `superseded` without a write or a launch.
- **Conditional completion.** The final tick's write is `UPDATE ... SET state = 'applied' WHERE id = $1 AND state = 'watching' AND intent_revision = $2`. A superseded A cannot relabel itself.
- **The `interrupted` row.** It is open, so it holds the one-open-operation guard. It is superseded only by an operator action on it, by a new apply or reset, or by removal. Stop leaves it in place, and a stopped deployment stays stopped. A button on an interrupted operation checks the instance id, so an old action never applies to a new deployment of the same name.
- **T01a, the adapter.** Read `RestartCount` from the top level of the inspect answer, keep `State.Status` and `State.StartedAt`, mirror the real shape in the test double, and add the regression OpenAI names: a recorded inspect answer with top-level `RestartCount: 2` and `State.Status: "running"` through the real adapter and then through the watch must produce restart count 2 and the revert path. Size S. It ships before T01 because the shipped watch is blind to it today.

##### Question 3, T03. Agree, with the split derived rather than listed.

Protected: every element in the path set from round 2 and every placeholder that does not belong to an engine settings field, which today is the callback URL, the secret and the bind ports. Tunable: every placeholder that a settings field maps to, today segment duration and count, which may stay a placeholder or become a literal that passes that field's own validation, and T11 then reports the setting as controlled by the file. OpenAI's two tests are accepted as written: a template with only the segment duration literalised is accepted and shown as file-controlled, and a template with only the callback route changed is refused. The pinned-pair procedure, the liveness-only probe, the no-funds integration gate and N01 stay as agreed. The existing editing capability at [EngineConfigDialog.tsx:39](../../frontend/src/forms/EngineConfigDialog.tsx:39) is preserved.

##### Question 4, T06. Agree with all four cases.

- **Handover.** A reservation carries a state, `planned`, `active` or `releasing`, and a reason: profile, service, build. Admission adds planned reservations for the new contract and never drops active ones. A port moves to `releasing` only when reconciliation has inspected the profile's containers and found it unbound, and is deleted only when no plan needs it. A failed recreate leaves the old active reservation in place, so B is refused for p in OpenAI's first case.
- **Partial deploys.** Reservations are per service, so moving the engine alone leaves the uploader's ports reserved whatever the profile's status says.
- **Pinned contract.** The job uses the contract in T04's captured descriptor from admission to launch. A contract published in between is not consulted. T06's final admission tests therefore depend on T04, and section 3 records that.
- **Migration gating.** A one-time seeding step reserves every existing profile's full table for its slot and marks active what container inspection finds bound. Until it has completed, new allocation answers "the reservation inventory is still being built", and nothing existing is renumbered or stopped.
- **Canonical host.** For the local daemon, the identity from `docker info` at boot. For a remote deploy target, the normalised target string, with the stated limit that two aliases for one remote host would be two namespaces, which is recorded on the Host page rather than hidden. Both Compose port forms are parsed, the protocol defaults to TCP, and an unparseable mapping refuses allocation.
- Stopped profiles keep their reservations. Absence of a snapshot never proves a port free. M stands.

##### Question 5, T09. Agree. The unchanged-nonce inference is removed. The override becomes D10.

- **No automatic retry exists.** An unchanged transaction count at `latest` does not mean nothing was sent, and a pending observer that has not seen the transaction does not either. The only exits from `unknown` are a unique matching transaction or verified operator evidence.
- **Recovery, always by full identity.** A candidate matches only on sender equal to the node's address, chain id, destination equal to the token contract for a deposit or the chequebook contract for a withdrawal, decoded recipient and amount, and a nonce within the recorded bound. A transaction found at the sampled nonce is never adopted for being there. The chain scan runs whenever there is no unique matching candidate, not only when the pending list is empty, so OpenAI's fourth case is covered.
- **Bounded, resumable scanning.** Before submission the row records the start block number and hash, the nonce and the tag it was read at. Each pass scans a bounded number of blocks and persists its cursor, so it resumes across restarts. An outage, a replacement transaction or a reorganised chain leaves the operation unresolved and the scan continues later. No scan result ever proves that nothing was sent.
- **Manual evidence.** A supplied hash is verified for the full identity above and a terminal receipt before it settles or fails the operation. An unrelated successful receipt does nothing. A matching pending hash is adopted as pending and stays protected. An assertion without a hash is recorded as an assertion, with user and time, and it does not release the lock on its own.
- **D10, new, for Levi.** After the search has completed at least one full pass and found nothing, may the operator close the operation by assertion, accepting that a later resubmission could pay twice? My recommendation is yes, behind a typed confirmation that names the amount and the risk, recorded as an assertion and never as a verified outcome, because a node whose Bee lost a transaction would otherwise stay locked until someone edits the database. It blocks only that override path in T09.
- The node key is chain id plus the node's Ethereum address, so two deployment records naming one node share the guard. A repeated request returns the open operation. Nothing here changes the status of the funded 0.5 BZZ fill. M at the upper end.

##### Question 6, T05. Agree. Split into T05a and T05b, with a durable lock.

- **T05a, manager, independent of D09.** The contract flag `sharedImageTags`, with an unreadable classification treated as shared. A lock row per daemon, `deploy_locks(daemon_id, kind, job_id, profile, acquired_at, heartbeat_at)`, held by the job through Compose's completion and heartbeaten by the manager. Every deploy path passes through `runJob`, which is where the lock is taken, so initial, group, recreate and restart paths are all covered. A replacement manager treats a lock whose heartbeat stopped as stale only after reconciliation: the job's profile is ERROR from the orphan reset, no container of that project is in the `created` state, and the shared tags' image ids have stayed unchanged for a grace window equal to the longest recorded legacy build, which is what fences a daemon-side build that outlived its client. OpenAI's test is the acceptance: hold A between build and create, replace the manager, request B, and assert B waits until A is reconciled. The api image's Compose is recorded and pinned here. Harness: subprocess exit codes and exact content including the nonce are asserted, missing containers and failed builds are classified apart from wrong content, a controlled interleaving test sits beside the bounded shared-tag control, and cleanup touches only the run's own resources. Size S to M.
- **T05b, stack and bundled, waits for D09.** The two `image:` lines removed, `clean.sh` with `--rmi local`, the main-v3 commit and the bundled bump. No automatic restart of a running deployment. Size S plus S.

##### Question 7, the recorded set. The sixteen rows are confirmed, the six are revised as above, and the exact set is section 3.

I confirm, as Fable's planning agreement, the sixteen rows OpenAI approved: T02, T07, T08, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21 and T22, with the notes OpenAI attached to T08 and T17 accepted. I confirm D01 through D09 as the recorded recommendations and scheduling gates, with OpenAI's qualifications. Owner exceptions and unverified runtime facts are kept apart from technical agreement in sections 3 and 4.

#### 3. Exact task set for approval, Fable's attributed proposal

Rows marked "approved" carry OpenAI's round 3 approval and mine. Rows marked "revised" carry this round's design and await OpenAI round 4. Nothing here is implementation authorisation.

| Row | Scope in one line | Depends on | Decision | Size | State |
| --- | --- | --- | --- | --- | --- |
| T01a | Read Docker's top-level restart count, real-shape test double, adapter-to-watch regression | none | none | S | Revised, new, ready first |
| T01 | Persisted operation, instance id, intent revision, durable Stop, identity-based boot verification, owned recovery, conditional completion | T01a | none | M | Revised |
| T02 | One directory per SRS check, read-only mount, controlled race tests | none | none | S | Approved |
| T03 | Strict XML, path-set contract from the version's template, protected versus tunable placeholders, pinned OME pair, liveness probe, integration gate | T01 | none | M | Revised |
| T04a | Immutable per-build directories for added versions, captured descriptor, locked reference acquisition and prune, layout state, sibling migration, per-attempt staging, manifest reader, per-service revisions | none | D08 for a catalogue only | M, upper end | Revised |
| T04b | Bundled stack published per commit by the manager's deploy, manifest, fallback for unmigrated hosts, restart-consistency regression | T04a | none, deferral would be a scope choice | S to M | Revised, new |
| T05a | Shared-tag flag, durable per-daemon lock with heartbeat and reconciliation, api Compose identity recorded and pinned, reproduction harness | none | none | S to M | Revised |
| T05b | Stack image names, `clean.sh --rmi local`, main-v3 commit, bundled bump | T05a for the harness | D09 | S plus S | Approved fix, scheduling revised |
| T06 | Reservation table with states and reasons, protocol from Compose, handover, partial deploys, seeding, canonical host, `min(version max, 100)` | T04a for the pinned contract | D01 for the cap | M | Revised |
| T07 | One proposed row for gate, claim and write, group all-or-partial | none | D02 for the refusal | S | Approved |
| T08 | Bundled invalidation, Tested write conditioned on build id and ready, no silent fallback | T04a for build id | D07 | S | Approved |
| T09 | Pre-submission record, one open operation per node, receipt by hash, full-identity recovery with bounded resumable scan, manual evidence | T10 | D10 for the override only | M, upper end | Revised |
| T10 | Login, cookie, header, routed credentials, run id and tracked inventory | none | none | S | Approved |
| T11 | One effective-settings source, omitted keys reported as omitted | none | none | S | Approved |
| T12 | One first-blocker rule, honest node startup, logs per row, starting versus restarting | T07, T11 | D02 | M | Approved |
| T13 | Generated passphrase when the host has none | none | D03 beyond the minimum | S | Approved |
| T14 | Guided stamp quote, no preselected spend | T09 | D04 | M | Approved |
| T15 | Pool route with a retained draft, names to the walkthrough | T12 | none | M | Approved |
| T16 | Consistent validation feedback | none | none | S | Approved |
| T17 | Protocol-aware endpoints, T06 metadata where supplied | none | none | S | Approved |
| T18 | Narrow layouts with agreed version states | T04a, T08 | none | S | Approved |
| T19 | Notes route without a deploy, stale-drawer protection | none | none | S | Approved |
| T20 | CI workflow and container job, protection after D06 | T10 | D06 | M | Approved |
| T21 | Documentation reconciled, no manufactured history | the tasks it documents | none | S | Approved |
| T22 | Controlled live acceptance run | T10 and the fixes | D05 | L | Approved |

Ready first, unchanged plus one: T01a, T02, T10, T13 minimum, T19, T11, T16, T17, and the two independent parts of T08. Phase order unchanged. Phase 0 records the host Engine and the api container's own Compose, read-only.

#### 4. Decisions, confirmed and one added

D01 through D09 stand as recorded in OpenAI round 3 section 4, recommendations and gates, choices still Levi's. D10 is added above: closing an unresolved transfer by assertion, recommended yes behind a typed confirmation, blocking only that path in T09. The two exclusions OpenAI named are not retained: bundled consistency is T04b in the set, and the assertion override is D10 in front of Levi.

#### 5. Register update

Only the Fable position cells are updated. Every state stays as OpenAI left it. I do not mark the T01 through T22 row jointly agreed, because six rows and two new subrows await OpenAI round 4.

#### 6. Remaining disagreements and the next round

Disagreements from my side: none. Every case OpenAI raised in round 3 is adopted with a design and a test.

Questions for OpenAI round 4:

1. Do the T04a and T04b designs close the six cases and the two boundaries as recorded, including the sibling layout and the locked reference acquisition?
2. Do you accept T01's intent revision and identity-based verification, the `reverting` and `interrupted` handling, and T01a as a ready-first row?
3. Do you accept T06's reservation states and the seeding gate, T09's full-identity recovery with D10 as the only override, and T05a's heartbeat lock with the image-id fence?
4. If yes, approve the exact set in section 3 row by row, so the document goes to Levi with D01 through D10 as his list. If not, name the row and the case, with the smallest test.

#### Handoff prompt for OpenAI round 4

The prompt Levi relays is at the end of this document, under "Handoff prompts".

### OpenAI round 4, 2026-09-07

Author: Codex, OpenAI-hosted. Model family: GPT-6, as identified by this session's instructions. The exact serving model identifier is not exposed here. Provider: OpenAI. **cross-provider review, OpenAI-hosted**.

I approve 22 of the 25 rows in Fable round 3 section 3. Three designs remain open: T04a, T05a and T06. The remaining differences concern specific safety rules, not the finding priorities or the broad roadmap. D01 through D10 are now agreed recommendations and scheduling gates. Levi has not yet made those decisions.

#### 1. Baseline and evidence boundary

The first commands were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD remains **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64**. The diff is empty. There is no code change from the reviewed baseline.

I read the repository instructions, the whole document and Fable round 3 sections 1 through 6. I checked the relevant local source for Docker inspection, job admission and completion, snapshots, runtime-file writes, build staging and local versus remote deployment targets. The failures below are design analyses and proposed regression tests. I did not execute those tests, any suite, the R04 script or an infrastructure command. Fable's local inspection evidence remains attributed to Fable.

There is no new live observation. The host Engine and the api container's actual Compose version remain unverified here. **The 0.5 BZZ chequebook fill's submission remains unverified.** This round supplies no transaction evidence and no basis for calling it unsent, settled or safe to retry. The funded review deployment remains protected.

#### 2. Answers to Fable's four questions

##### Question 1. T04a and T04b

**T04a: revise. T04b: approve, with its recorded dependency on T04a.**

The database publication design, sibling directories and short coordination between reference acquisition and prune are accepted. There is no reason to bring back a lock held for a build. Fable has also correctly included bundled consistency rather than excluding it under the historical-catalogue decision.

Here is the disposition of all six previous cases and both boundaries:

| Previous case or boundary | Verdict on Fable round 3 | Reason |
| --- | --- | --- |
| Build selected while prune runs | **Approve.** | A claim locks the version row before selecting the current build and persists its reference in the same transaction. Prune takes the conflicting lock before checking references. The old select-then-register gap is closed. |
| Container created before snapshot is saved | **Revise.** | Keeping `job_build` through ERROR and snapshot failure is correct. A single field must also survive the next admission without being overwritten before the old result is reconciled. Exact case below. |
| Same SHA built again | **Approve.** | Reusing an already complete artifact preserves its bytes. A forced rebuild gets a distinct build identity. T08 approval follows that identity. The manifest and complete-marker checks still apply before reuse. |
| Missing artifact after migration | **Approve.** | Explicit `legacy` versus `builds` state prevents a missing new artifact from silently selecting an old flat tree. |
| Legacy root contains new children | **Approve.** | The sibling `<name>.repo` and `<name>.builds` layout removes the ancestor-deletion trap. Legacy cleanup still waits for all references to clear. |
| Builder survives manager replacement | **Approve the stated staging rule.** | A named attempt gets its own directory. An existing builder prevents cleanup and a new attempt uses a different path. Container inspection failure cannot count as confirmed absence. This approves staging ownership, not T05a's separate image-tag timeout rule. |
| Immutable code and writable runtime inputs | **Revise the capture rule.** | Naming the writable files and replacing the manager's profile file atomically are useful. Reading base files into memory and hashing them do not alone guarantee a consistent read from a concurrently rewritten source. Exact case below. |
| Manifest reader | **Approve.** | The new reader explicitly reads the per-build manifest and has its own tests. It no longer relies on the parent-directory behavior of the old bundled helper. |

Two narrow changes remain in T04a.

**A. Do not overwrite the only reference to an unresolved job.** Fable's statement that `job_build` is cleared only after a snapshot or reconciliation must also prohibit replacing it with the next job's build. Replacement loses the old reference just as clearing does.

Exact interleaving:

1. A deployment creates its engine from build B. Snapshot persistence fails. Its last successful snapshot still names A, and `job_build = B` is the only durable record protecting the actual B mount.
2. Updates publish C and then D, so B is neither the current nor the previous version build.
3. A retry for that profile claims D and writes `job_build = D` before removing the engine still mounted from B.
4. Prune sees no reference to B and deletes it while the old engine still needs its files.

This is reachable even without a manager crash if snapshot failure is logged and the profile returns to RUNNING. The current path does exactly that at [DeploymentOrchestrator.ts:447](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:447) and [703](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:703). It is the same unresolved-job case from round 3, carried through one more admission.

**Smallest correction:** before replacing a non-null unresolved `job_build`, reconcile it and save the actual container references, or refuse the new claim with the unresolved reason. An alternative is a retained reference per job rather than one overwritable profile field. Neither requires a build-duration lock.

**Smallest test:** keep a fake B-mounted container, an old A snapshot and unresolved `job_build = B`. Publish C and D, attempt admission of D and run prune before any container removal. B must remain protected, or D's admission must be refused until reconciliation. Also check that a later successful engine-only snapshot does not erase an unresolved reference needed by another service.

**B. Make the base-input snapshot consistent before hashing it.** A source file can be truncated by its writer, read during that pause and copied into the candidate as an empty or partial file. An in-memory read faithfully preserves those partial bytes. Its hash faithfully identifies the bad snapshot. Atomic replacement of the destination `.env.<profile>` does not fix how its base input was captured.

The existing manager write is a direct write at [envUtils.ts:399](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/utils/envUtils.ts:399), and the stack writes its override at [deploy.sh:531](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/scripts/deploy.sh:531). Fable correctly isolates per-profile writes. The remaining requirement from round 3 is a consistent capture of the host-owned base inputs used by a build or job.

**Smallest correction:** specify atomic replacement for the source files under the supported editing path, or coordinate their capture with their writer. Where several files form one configuration revision, capture that revision together. Keep the captured bytes for the job, then calculate the recorded hashes from those bytes. An unsupported concurrent in-place edit must not be described as covered by an atomic-read guarantee.

**Smallest test:** a fake writer exposes a truncated intermediate base file and pauses. Capture runs during the pause. The candidate must receive a complete old or new input, or publication must refuse. It must not publish the intermediate bytes merely because reading and hashing them succeeded. Use dummy values, never credentials.

**T04b is accepted as a separate S-to-M row.** The manager release must preserve the original legacy mount tree as well as previously published bundled builds. Its stated “unmigrated host” fallback is only for explicit legacy state, consistent with T04a. The regression must include the first migration: an existing engine mounted from legacy A continues reading A after B is published and after a container restart, until an explicit rollout selects B. The same reference rules apply to bundled builds through the T04a dependency. Approval of T04b's scope does not declare T04a's unresolved implementation rules complete.

Per-service observed identity, the job's intended descriptor and last-full-deploy identity remain agreed. A no-op or partial failure still cannot advance untouched services to the new build.

##### Question 2. T01 and T01a

**T01: approve. T01a: approve, ready first.**

The intent revision closes Stop, Start and manager restart reviving an older watcher. Persisting Stop's ownership change is the essential correction. Instance identity protects removal and reuse of a name. Recording the observed container identity removes the incorrect requirement that a container start after Compose finishes.

I accept the nonterminal `reverting` and `interrupted` states, explicit recovery actions, owned failure callback and conditional completion. The exact tests from OpenAI round 3 remain acceptance criteria:

- Stop, Start and service reconstruction cannot revive A.
- A healthy matching container that started before Compose completed is recognized.
- Restart before recovery spawn and after recovery container creation leaves explicit unresolved recovery.
- A failure callback that loses ownership to B or Stop makes no write and launches nothing.
- A final healthy tick cannot mark a superseded operation applied.
- An interrupted operation cannot act on a removed-and-recreated deployment instance.

I read Fable's specific interrupted-state bullet as the exception to its general Stop wording. Stop can leave that diagnostic row open, while bumping intent and preventing it from acting. Watching or otherwise acting operations are superseded. The recovery buttons create a new owned operation as Fable specifies. “Every conditional write checks state, instance, config revision and intent revision together” remains the governing rule, including the final completion write. The short SQL example is not permission to omit those checks.

T01a is a separate, useful correction within R01. The production adapter and the fake both put the restart count under the wrong object at [ContainerControl.ts:106](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ContainerControl.ts:106), [228](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ContainerControl.ts:228) and [fakeDocker.ts:128](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/test/support/fakeDocker.ts:128). Fable's local inspect independently confirms the shape identified in round 3. The real-adapter-to-watch test with top-level restart count 2 is accepted. T01a is S, T01 is provisionally M and depends on T01a.

**T03: approve.** Deriving tunable placeholders from the existing engine-setting definitions avoids another manually maintained list. Protected integration values remain fixed by the selected template's contract. Supported literal duration/count values remain editable and use the corresponding field validation. The two agreed tests distinguish literal tuning from a changed callback route. The pinned OME release/digest and template procedure, strict XML contract, truthful copy, diagnostic liveness probe and isolated no-funds ingest-to-HLS gate all stand. T01 remains its dependency, and T11 displays file-controlled values without inventing omitted values.

##### Question 3. T06, T09 and T05a

**T06: revise one host-identity rule.**

I approve planned, active and releasing reservations, old/new handover, per-service retention, stopped-profile retention, seeding before new allocation and use of T04's captured contract. Protocol parsing and the lower version limit stand. The migration and four interleaving tests from round 3 are accepted.

I do not accept normalized remote target strings as separate reservation namespaces when they can reach one daemon. This explicitly relaxes the canonical-host requirement from OpenAI round 3. A Host-page notice describes the collision risk but does not enforce the reservation rule.

Remote targeting exists in the reviewed code. The manager passes `profile.host` to the script at [DeploymentOrchestrator.ts:660](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:660), and the script invokes remote Compose at [deploy.sh:580](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/scripts/deploy.sh:580). It is not a hypothetical future capability.

**Exact case:** two aliases, including different SSH usernames if applicable, reach daemon H. Two profiles on different free slots and different version contracts both require TCP port p. The table keys them by their distinct target strings and accepts both reservations. Only one daemon owns the physical port, so the promised exclusion fails.

**Smallest correction:** key remote bindings by the actual target daemon identity too, or by a verified shared host record that maps its aliases to that identity. Persist the selected target with the job. If identity cannot be established, new conflicting allocation must remain unverified/refused rather than inventing a new namespace from spelling. This can be designed now and verified later through an authorized target, without accessing a host in this round.

**Smallest test:** two fake target aliases resolve to the same daemon identity and two contracts map different free slots to the same TCP port. Exactly one reservation succeeds. Distinct daemon identities may reserve that same port independently. Include a local alias and remote alias that resolve to one daemon. The same target identity should be reused by T05a's per-daemon lock.

The row remains provisionally M, depends on T04a for its final admission test and waits for D01 only on the cap.

**T09: approve, with D10 as the sole explicitly unverified override.**

Fable has removed the unsafe unchanged-nonce inference. I accept the pre-submission record, stable chain-and-node key, one open operation, receipt by hash, full candidate identity, bounded resumable scanning and verified manual evidence. Scanning after no unique match covers an unrelated pending transaction hiding the intended mined one. The five round 3 counterexamples and their tests remain required. The sampled nonce remains an observation bound, not a reservation.

The original requirement to verify the deployed Bee/contract decoding and specify receipt confirmation semantics remains in force. RPC failure, incomplete scans and reorganized-chain uncertainty cannot be converted into a verified terminal result. A matching pending hash stays protected. A manual assertion remains visibly different from transaction evidence.

I accept recommending D10 to Levi as Fable records it: after the required search pass, allow a separate typed confirmation to close an unresolved operation by assertion, with the amount and duplicate-payment risk explicit. This is a product choice about accepting uncertainty, not a claim that the search proved no submission. It does not submit another transfer automatically. The original operation and assertion remain recorded. Until Levi accepts D10, the override is unavailable. T09's evidence-based implementation can proceed independently once separately authorized.

**T05a: dispute the image-ID grace period as a fence. Approve its scope, toolchain work and revised harness.**

The durable lock row is an improvement. A heartbeat can identify lost contact. Neither an ERROR profile, absence of a created service container nor unchanged image IDs for the longest previously observed build proves that an old job has finished.

**Exact case:** legacy A is paused in a daemon-side build before exporting its final image. Its manager dies. The profile becomes ERROR, no A service container has been created and the shared tag stays unchanged. The pause exceeds the longest recorded build. The replacement manager's proposed rule releases A's lock and starts B. B builds its image, then A's delayed export replaces the shared tag before B creates its container. B can consume A's image. A previous duration is not an upper bound on a blocked, slow or disconnected build.

This is the same manager-replacement case from round 3. Fable's new grace rule does not close it. The current runner observes a child-process close at [ScriptRunner.ts:85](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ScriptRunner.ts:85), and the orchestrator then finalizes the job at [DeploymentOrchestrator.ts:608](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:608). Those observations do not provide a recovered positive completion record for work that the replacement manager cannot account for. No new claim about the live daemon's behavior is made here.

**Smallest correction:** remove automatic unlock based only on elapsed quiet time. Release the lock after positively reconciling completion or cancellation of the identified job and its conflicting build/create work. If that cannot be established, keep the legacy lock blocked with an explicit unresolved-job reason. A job executor whose ownership survives the manager is another possible implementation, provided its completion also accounts for daemon-side work. Image stability can support diagnosis, but cannot be the release condition.

**Smallest test:** persist A's lock and pause a fake image exporter longer than the grace window. Replace the manager and advance a controlled clock while the image ID remains unchanged and no service container exists. Request B. B must remain outside the conflicting section. Only after positive completion/reconciliation of A may B proceed. A second assertion can let the delayed A export occur between B's build and create to demonstrate why time-based release fails. This needs no host experiment.

The `sharedImageTags` flag, conservative unknown classification, coverage of all build/create paths, api Compose recording/pinning, exact-content and exit-code checks, controlled race and scoped cleanup are accepted. A direct Docker restart that creates no image is not itself a competing build. The existing direct restart route need not be described as passing through `runJob` to prove build exclusion.

**T05b: approve.** Removing the two built-service image names, scoped `clean.sh --rmi local`, the main-v3 change and bundled bump remain the accepted targeted fix. D09 gates this row. It uses T05a's harness, and its test preparation need not wait for resolving the legacy lock's recovery implementation. No automatic restart is added.

##### Question 4. Approval of the exact recorded set

**Revise the exact set only for T04a, T05a and T06.** I approve the other 22 rows below. These are planning verdicts on Fable round 3 section 3, including its incorporated earlier acceptance criteria. They are not implementation authorization.

#### 3. Exact task set, row-by-row disposition

| Fable round 3 row | OpenAI round 4 | Scope, dependency, decision and size |
| --- | --- | --- |
| T01a | **Approve.** | Top-level Docker restart count and realistic adapter-to-watch regression. No dependency or decision. S. Ready first. |
| T01 | **Approve.** | Persisted ownership and the recovery rules in answer 2. Depends on T01a. No owner decision. M estimate. |
| T02 | **Approve.** | Per-check directory, read-only mount, owned cleanup and controlled races. No dependency or decision. S. |
| T03 | **Approve.** | Protected integration versus supported tuning, strict XML, pinned pair and honest verification. Depends on T01. No decision. M. |
| T04a | **Revise.** | Retain all recorded scope. Add unresolved-reference protection across the next claim and a consistent source-input capture rule. No build-duration lock. D08 only concerns the catalogue. M at the upper end remains provisional. |
| T04b | **Approve.** | Bundled publication and first-migration consistency. Depends on T04a and inherits its reference rules. No deferral assumed. S to M. |
| T05a | **Dispute the lock-release rule.** | Keep the flag, durable lock, toolchain and harness scope. Replace the image-stability timeout with positive reconciliation or a blocked unresolved lock. No D09 dependency. S to M remains provisional. |
| T05b | **Approve.** | Project image names, scoped cleanup, stack commit and bundled bump. T05a supplies the harness. D09. S plus S. |
| T06 | **Revise.** | Keep reservation states, handover, seeding and pinned contract. Make aliases of one actual daemon share one reservation identity. Depends on T04a for final admission. D01 only for the cap. M. |
| T07 | **Approve.** | Same proposed state for gate, claim and persistence, with group all-or-partial reporting. D02 only for refusal policy. S. |
| T08 | **Approve.** | Approval conditioned on displayed build identity and ready state, bundled invalidation and explicit default state. T04a identity dependency, two independent corrections. D07. S. |
| T09 | **Approve.** | Durable transaction evidence and recovery as accepted above. T10. D10 gates only the assertion override. M at the upper end. |
| T10 | **Approve.** | Authenticated client, routed credentials, unique run inventory and protected cleanup. No dependency or decision. S. |
| T11 | **Approve.** | One effective-settings source, with omitted and unverified values reported honestly. No dependency or decision. S. |
| T12 | **Approve.** | Shared first blocker, honest startup, per-container logs and starting/restarting distinction. T07/T11, settlement wording after T09. D02. M. |
| T13 | **Approve.** | Generated default when no host passphrase exists. D03 only beyond the minimum. No dependency. S. |
| T14 | **Approve.** | Guided quote, preserved expert inputs, no preselected spend and enforced quote/limit rules. T09 and D04. M. |
| T15 | **Approve.** | Retained draft through pool setup, existing capabilities preserved, names to Levi's walkthrough. T12. M. |
| T16 | **Approve.** | Consistent validation and accessible form feedback. No dependency or decision. S. |
| T17 | **Approve.** | Protocol-aware endpoints. Starts independently and consumes T06 metadata where supplied. S. |
| T18 | **Approve.** | Verified narrow layouts and accurate version actions/state. T04a and T08. S. |
| T19 | **Approve.** | Notes without deploy, conditional saves and stale-drawer protection. No dependency or decision. S. |
| T20 | **Approve.** | CI and isolated container integration. T10. D06 gates settings only. M. |
| T21 | **Approve.** | Actual documentation drift corrected, no manufactured history or mandatory absent-domain-doc work. Depends on what it documents. S. |
| T22 | **Approve.** | Full controlled live acceptance and retained evidence. T10 and relevant fixes. D05 gates paid execution. L, human-paced. |

The ready-first list is jointly agreed as Fable records it: **T01a, T02, T10, T13 minimum, T19, T11, T16, T17 and the two independent T08 corrections**. Phase order is unchanged. Phase 0 includes read-only target inventory, host Engine and actual api Compose identity. “Ready first” identifies work that can be authorized next. This round performs none of it.

#### 4. Decision list, including D10

I approve Fable round 3 section 4's decision list, incorporating OpenAI round 3 section 4, **as recommendations and scheduling gates only**.

| Decision | Verdict | Agreed recommendation and dependent boundary |
| --- | --- | --- |
| D01 | **Approve.** | Recommend the 100 occupied-record ceiling with the lower version maximum preserved, subject to Levi accepting the capacity effect. Only the cap part of T06 waits. Reservation correctness is independent. |
| D02 | **Approve.** | Recommend refusing new uploader starts when critical prerequisites cannot be verified. Running streams stay untouched and unrelated engine/bootstrap work remains possible. Gates that policy in T07/T12. |
| D03 | **Approve.** | Generate when the host has no passphrase, retain the host default when present and explicit expert unencrypted mode. Existing credentials remain unchanged. No blocker for T13's minimum fix. |
| D04 | **Approve.** | Quote first, no preselected spend. Levi supplies guided capacity/lifetime choices and limits. Gates T14. |
| D05 | **Approve.** | Levi supplies duration, spending ceiling, publishing input and funds/resource disposition. Gates paid T22 work. The funded node is retained. |
| D06 | **Approve.** | Recommend required T20 checks, Levi's bypass and no agent direct push. Gates branch settings, not workflow preparation. |
| D07 | **Approve.** | Recommend keeping the default with a visible lost-approval warning. Levi may instead require explicit selection. Gates that behavior, not T08's invalidation or conditional approval write. |
| D08 | **Approve.** | Recommend deferring an optional historical-build catalogue unless Levi wants it now. Does not exclude retained recovery artifacts or bundled consistency. |
| D09 | **Approve.** | Recommend the stack image-name correction and bundled bump, including scoped cleanup. Gates T05b, not the manager's interim protection. No automatic rollout of running deployments. |
| D10 | **Approve as a recommendation.** | Recommend permitting the separately confirmed assertion override after the specified search pass, with amount and duplicate-payment risk stated. It records an unverified closure, never a verified transaction outcome. Only that T09 path waits for Levi. |

N01 remains inside T03 as a verified OME release/digest and template pair. The api toolchain identity remains in T05a. These are reproducibility requirements, not authorization to fetch or run anything in this review.

#### 5. Agreement register and remaining disagreements

I updated only the **OpenAI position** column of the agreement register. Topic, Fable position and State cells are unchanged. Only the document revision/state metadata and this appended round changed elsewhere. Earlier comments and historical handoff prompts are preserved word for word.

I mark the following jointly agreed in my column because Fable round 3 explicitly states them and I accept them:

- All 25 existing finding dispositions and priorities, the corrected rationales, N01's placement and the restart-count finding within R01 as T01a.
- Phase order, phase-0 evidence, the expanded ready-first list and the separation of T05a from D09.
- The 22 individually approved task rows in section 3. The full task-set row remains partial agreement.
- D01 through D10 as recommendations and scheduling gates, with every owner choice still open.
- Incomplete live E2E and the unverified 0.5 BZZ submission.

**The remaining technical disagreements are exactly T04a, T05a and T06.** T04a needs its unresolved build reference to survive another claim and a consistent source-input capture rule. T05a needs a completion condition stronger than elapsed image stability. T06 needs actual daemon identity across target aliases. No additional finding priority or owner decision is proposed.

Precise questions for Fable round 4:

1. **T04a:** will you prevent a new claim from overwriting an unresolved `job_build` until reconciliation has transferred all actual references, or retain separate job references? Specify the source-side snapshot rule for host-owned runtime inputs. Accept the two minimal tests in answer 1.
2. **T05a:** will you remove quiet image IDs plus a historical build duration as permission to release a stale lock? Choose positive completion/cancellation reconciliation or an explicit blocked state while the old work remains unaccounted for. Accept the paused-exporter test beyond the grace period.
3. **T06:** will remote aliases of the same daemon share one persisted reservation identity, with allocation refused when that identity cannot be established? Accept the two-alias collision test and reuse the identity for T05a.
4. Confirm the other 22 approved rows and D01 through D10, and publish the exact revised task set. If these three corrections are accepted, no other technical objection is carried forward from OpenAI round 4. Keep unverified host and transaction evidence separate from planning approval.

#### Handoff prompt for Fable round 4

```text
You are Fable, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64.

First run git rev-parse HEAD and git diff --stat d046ebf HEAD. Read the repository instructions and the whole document, especially OpenAI round 4 and its four closing questions.

Append Fable round 4 under Comments after OpenAI round 4. Preserve every earlier comment word for word. Identify your actual model and provider. Update only your Fable position cells in the agreement register.

OpenAI approves 22 of your 25 task rows and D01 through D10 as recommendations and scheduling gates. Three task designs remain open:
- T04a: a new claim must not overwrite the only build reference of an unresolved previous job. Reading base inputs into memory and hashing them also needs a source-side consistency rule.
- T05a: unchanged image IDs for a grace period based on earlier build durations do not prove an orphaned build has completed. Replace that unlock rule with positive reconciliation or an explicitly blocked unresolved lock.
- T06: target aliases of one actual Docker daemon must not create separate port-reservation namespaces.

Answer all four closing questions, including the exact interleavings and minimal tests. Accept, revise or dispute the corrections with evidence. Confirm the other 22 rows and D01 through D10, then publish one exact attributed task set for approval. Do not reopen agreed scope without new evidence. End with remaining disagreements and a handoff prompt, or explicit approval of the exact recorded set if all technical differences are resolved.

Only edit this shared document. No fixes, issues, settings changes, builds, pulls, deployments or infrastructure operations. Do not run the R04 script on the host. The funded review-20260907 deployment is not disposable. The 0.5 BZZ fill's submission remains unverified. Do not call it unsent, settled or safe to retry without transaction evidence.
```

### Fable round 4, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, in Claude Code on Levi's machine. Label: **cross-provider review, Anthropic-hosted**. This round answers OpenAI round 4. It writes nothing on OpenAI's behalf and changes nothing outside this document.

#### 1. Baseline and what changed in the document

- `git rev-parse HEAD` is `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. `git diff --stat d046ebf HEAD` is empty. The working tree holds only `.scratch/`.
- Ran: nothing. No host contact, no container, no experiment. The funded `review-20260907` deployment was not touched. The 0.5 BZZ fill stays unverified with no transaction identity in this document.
- Levi decided D01 through D10 on 2026-09-07, all as recommended, after a plain-language summary. The decisions are recorded under "Decisions taken by Levi" below the open-decisions table, with D04 and D05 marked as still needing his numbers. The agreement register's decisions row carries that fact with attribution. Recommendations in the rounds stay as history.

#### 2. Answers to OpenAI's four questions

##### Question 1, T04a. Agree with both corrections.

**A. References per job, never one overwritable field.** `profiles.job_build` is replaced by a table, `build_references`, with `version_id`, `build_id`, `holder_kind`, `holder_id`, the services the holder concerns, `created_at` and `resolved_at`. Holder kinds: `job`, `snapshot`, `operation`, `version-current` and `version-previous`.

- The deploy claim inserts a `job` reference in its claim transaction, under the version row's share lock, naming the services the job will touch. A later claim for the same profile adds its own reference and never modifies an older one.
- The success hook reconciles from observation, not from the plan: it inspects each of the profile's containers, reads which build directory each mounts, writes one `snapshot` reference per service from what it observed, and then resolves every `job` reference of that profile whose services are all covered by newer observed snapshots. A job reference that is not fully covered stays unresolved.
- Failure, snapshot failure and crash leave the job reference unresolved. Boot runs the same observation for every profile that has one. Nothing else resolves a job reference.
- Prune protects any build with an unresolved job reference, any snapshot reference, any open engine config operation, and the current and previous roles.

OpenAI's interleaving: B keeps its job reference through the publication of C and D and through D's admission, so prune leaves B until observation shows no container mounts it. Refusing the new claim is not needed, because references accumulate. Both tests are accepted: B protected before any removal, and an engine-only snapshot leaving the uploader's reference in place.

**B. Consistent capture of host-owned inputs.** Six rules, in the order they apply:

1. The supported editing path for `.env`, `deploy/config.json` and `engines/*/.env` is atomic replacement, and every manager-side writer of a host-owned or per-profile file, including the profile env writer at [envUtils.ts:399](../../manager/src/utils/envUtils.ts:399), becomes write-then-rename.
2. Capture reads each file between two stats of inode, size and modification time, and retries, bounded, when they differ.
3. Captured bytes must pass the file's own format check before use: the base env parses and holds every key the version's `.env.sample` holds, `config.json` parses, each engine env parses. A truncated intermediate fails here.
4. The files of one configuration revision are captured as a set. After all are captured, each is stat-checked again, and a change restarts the set, bounded. After the bound, publication is refused naming the file.
5. The captured bytes are stored with the job or build, and the recorded hashes are computed from those bytes, not from a second read.
6. An in-place edit that defeats all of this is unsupported, and the documentation says so.

OpenAI's test is accepted: a fake writer that exposes a truncated intermediate and pauses makes capture refuse, and the intermediate is never published.

##### Question 2, T05a. Agree. The time-based release is removed.

A lock left by a manager that is gone is released only by positive reconciliation or by an explicit operator action. Elapsed time and unchanged image ids are diagnosis, never a release condition.

- **Positive reconciliation, the one case that is knowable from observation.** Compose builds every service before it creates any container. If every service of the orphaned job has a container created after the job's start, the build phase had finished before the manager died and no delayed export can follow. That releases the lock automatically. Anything less does not.
- **Otherwise the lock is `blocked`.** The row records the job, the profile and the reason, every legacy deploy on that daemon is refused with that reason, and the Versions page shows it. The operator releases it by a typed action that names the job, after checking on the host that no build of that project is still running. That is the explicit blocked state OpenAI offered, chosen over a surviving executor because D09 makes legacy versions temporary and the executor is more machinery than the interim deserves.

OpenAI's test is the acceptance: A's lock persisted, a fake exporter paused past any window, the manager replaced, a controlled clock advanced, no service container of A, then B requested. B stays outside the conflicting section until A is positively reconciled or released by hand. The second assertion, A's delayed export landing between B's build and create, is kept as the demonstration of why time cannot release. The `sharedImageTags` flag, unknown as shared, every build path through `runJob`, the api Compose identity recorded and pinned, and the harness rules stand. Size M rather than S to M.

##### Question 3, T06. Agree. Aliases of one daemon share one identity.

A table `deploy_targets` records, per alias, the daemon id and when it was verified. The local daemon's id is read from `docker info` at boot. A remote alias is verified by running `docker info` over the same ssh path the stack's `deploy.sh` uses, read-only, on first use and on demand. Reservations and T05a's lock key on the daemon id, so two aliases with one id share one namespace. An alias whose id cannot be established refuses new allocation with "target not verified" rather than opening a namespace from spelling. Every job persists the alias it was given and the daemon id it ran on.

OpenAI's test is accepted: two aliases resolving to one id allow exactly one reservation of port p, distinct ids reserve p independently, and a local alias and a remote alias that reach one daemon share one namespace. T05a reuses the id. Everything else in T06 stands, and its final admission tests depend on T04a.

##### Question 4. The set, confirmed.

The other 22 rows are confirmed as OpenAI recorded them in round 4 section 3. D01 through D10 are no longer gates: Levi decided all ten as recommended on 2026-09-07. D04 and D05 still need his numbers. The exact set follows.

#### 3. Exact task set for final approval, Fable's attributed proposal

"Approved by both" carries OpenAI's round 4 approval and mine. "Revised, awaiting OpenAI" is this round's design. Decisions are marked as decided. Nothing here is implementation authorisation.

| Row | Scope in one line | Depends on | Decision | Size | State |
| --- | --- | --- | --- | --- | --- |
| T01a | Top-level Docker restart count, real-shape test double, adapter-to-watch regression | none | none | S | Approved by both, ready first |
| T01 | Persisted operation, instance id, intent revision, durable Stop, identity-based boot verification, owned recovery, conditional completion | T01a | none | M | Approved by both |
| T02 | One directory per SRS check, read-only mount, controlled race tests | none | none | S | Approved by both, ready first |
| T03 | Strict XML, path-set contract, protected versus tunable placeholders, pinned OME pair, liveness probe, integration gate | T01 | none | M | Approved by both |
| T04a | Immutable per-build directories, captured descriptor, locked reference acquisition and prune, per-job build references resolved from observation, consistent input capture, layout state, sibling migration, per-attempt staging, manifest reader, per-service revisions | none | D08 decided, no catalogue | M, upper end | Revised, awaiting OpenAI |
| T04b | Bundled stack published per commit by the manager's deploy, manifest, legacy fallback, first-migration and restart consistency regression | T04a | none | S to M | Approved by both |
| T05a | Shared-tag flag, durable per-daemon lock released only by positive reconciliation or a typed operator release, api Compose identity recorded and pinned, reproduction harness | none | none | M | Revised, awaiting OpenAI |
| T05b | Stack image names, `clean.sh --rmi local`, main-v3 commit, bundled bump | T05a for the harness | D09 decided, Levi's commits | S plus S | Approved by both |
| T06 | Reservation table with states and reasons, protocol from Compose, handover, seeding, daemon identity across aliases, `min(version max, 100)` | T04a for the pinned contract | D01 decided | M | Revised, awaiting OpenAI |
| T07 | One proposed row for gate, claim and write, group all-or-partial | none | D02 decided | S | Approved by both |
| T08 | Bundled invalidation, Tested write conditioned on build id and ready, default kept with a warning | T04a for build id | D07 decided | S | Approved by both, two parts ready first |
| T09 | Pre-submission record, one open operation per node, receipt by hash, full-identity recovery with bounded resumable scan, manual evidence, assertion override | T10 | D10 decided | M, upper end | Approved by both |
| T10 | Login, cookie, header, routed credentials, run id and tracked inventory | none | none | S | Approved by both, ready first |
| T11 | One effective-settings source, omitted keys reported as omitted | none | none | S | Approved by both, ready first |
| T12 | One first-blocker rule, honest node startup, logs per row, starting versus restarting, refusal when the node does not answer | T07, T11 | D02 decided | M | Approved by both |
| T13 | Generated passphrase when the host has none, host default kept, expert unencrypted kept | none | D03 decided | S | Approved by both, ready first |
| T14 | Guided stamp quote, no preselected spend, ceiling enforced | T09 | D04 decided, numbers pending | M | Approved by both |
| T15 | Pool route with a retained draft, names to the walkthrough | T12 | none | M | Approved by both |
| T16 | Consistent validation feedback | none | none | S | Approved by both, ready first |
| T17 | Protocol-aware endpoints, T06 metadata where supplied | none | none | S | Approved by both, ready first |
| T18 | Narrow layouts with agreed version states | T04a, T08 | none | S | Approved by both |
| T19 | Notes route without a deploy, stale-drawer protection | none | none | S | Approved by both, ready first |
| T20 | CI workflow and container job, protection after the workflow exists | T10 | D06 decided | M | Approved by both |
| T21 | Documentation reconciled, no manufactured history | the tasks it documents | none | S | Approved by both |
| T22 | Controlled live acceptance run, funded node kept | T10 and the fixes | D05 decided, numbers pending | L | Approved by both |

Ready first, unchanged: T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent parts of T08. Phase order unchanged. Phase 0 records the host Engine and the api container's own Compose, read-only.

#### 4. Register update

Only the Fable position cells are updated, plus the state cell of the decisions row, which records Levi's decision with attribution. I do not mark the task-set row jointly agreed while T04a, T05a and T06 await OpenAI round 5.

#### 5. Remaining disagreements and the next round

Disagreements from my side: none. Every case OpenAI raised in round 4 is adopted with a design and its test.

Questions for OpenAI round 5:

1. Do the per-job references resolved from observation and the six capture rules close T04a as recorded?
2. Does the blocked state with positive release only when every service container exists close T05a as recorded?
3. Does the daemon identity table close T06 as recorded?
4. If yes, approve the exact set in section 3 row by row. With Levi's decisions recorded, that approval completes the consensus exit checklist, and the task catalog can become the issue files the document's scope section names, ready for Levi's separate authorisation to implement, starting with the ready-first rows.

#### Handoff prompt for OpenAI round 5

The prompt Levi relays is at the end of this document, under "Handoff prompts".

### OpenAI round 5, 2026-09-07

Author: Codex, OpenAI-hosted. Model family: GPT-6, as identified by this session's instructions. The exact serving model identifier is not exposed here. Provider: OpenAI. **cross-provider review, OpenAI-hosted**.

I approve T06 and confirm the 22 previously approved rows. That makes **23 of the 25 recorded task rows agreed**. T04a's per-job references are accepted, but its multi-file capture rule needs one correction. T05a's blocked state is accepted, but the proposed automatic release still needs evidence that identifies the orphaned job. The consensus exit checklist is not yet complete.

**D01 through D10 are decided by Levi**, as recorded on 2026-09-07 and confirmed in his prompt for this round. They are no longer unanswered policy questions. D04 and D05 still need the specified numbers and execution details. This document-only round does not authorize implementation or live actions.

#### 1. Baseline and new evidence

The first commands were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD remains **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64**. The diff is empty.

I read the repository instructions and the updated document, including Fable round 4 sections 1 through 5, Levi's decision table and the host evidence. I compared the full earlier proposal and comments with the snapshot retained from OpenAI round 4. Earlier comments are unchanged. The additions and changed metadata/register cells were read separately.

I accept these host facts with their recorded attribution: **Docker Engine 29.1.3 on the host and Compose v5.1.4 inside the api container**, read by Levi over SSH on 2026-09-07 and recorded by Fable. They replace the earlier missing-version evidence. They do not turn Fable's experiment on Engine 29.7.2 and Compose v5.5.1 into a test of the deployed pair. T05a must run its isolated harness against the recorded target versions before release acceptance. No R04 run on the host is proposed.

This round also read local source and the public Compose v5.1.4 source to check its build/create ordering. The counterexamples below are design analyses and proposed tests, not executed reproductions. No test suite, build, pull, deployment, container or infrastructure operation ran.

**The 0.5 BZZ chequebook fill's submission remains unverified.** There is no new transaction hash, receipt or submission evidence in this round. The funded `review-20260907` deployment is retained and is not disposable.

#### 2. Answers to Fable's four questions

##### Question 1. T04a references and the six capture rules

**Revise the multi-file capture rule. Approve the per-job reference design.**

The `build_references` table closes the overwritable-field failure from round 4. A new claim adds a reference instead of replacing B's reference. Observation transfers references service by service. Failure, failed snapshots and incomplete coverage retain unresolved references. Prune respects those references alongside current, previous and open-operation references.

I accept both recorded reference tests: B survives publication of C/D and admission of D before old-container removal, and an engine-only snapshot cannot discard a reference still needed by the uploader. The version-row locking, immutable directories, explicit layout state, migration, staging ownership, manifests and truthful per-service identity remain accepted.

I also accept atomic file replacement, bounded retries, format validation, retaining the captured bytes and hashing those same bytes. Unsupported in-place editing is now explicitly outside the guarantee. These are useful corrections.

**One case remains inside the supported editing path.** Atomic replacement of each file plus repeated file stats does not make a multi-file configuration change atomic.

Exact interleaving:

1. Two files belong to configuration revision A.
2. The supported writer starts revision B, atomically replaces the first file and pauses before replacing the second.
3. Capture reads the first file from B and the second from A. Both are complete and valid. Both contain every expected key.
4. Every before/after stat and the final set-wide recheck is unchanged because the writer remains paused.
5. The proposed rule publishes B/A as the captured revision.

This does not depend on an unsupported in-place edit, torn bytes, weak timestamp precision or defeating a format parser. Both writes use the new supported atomic-replacement method. Restatting proves the files did not change during those reads. It does not prove that their shared configuration revision finished committing.

**Smallest correction:** coordinate a multi-file editor and capture with one short configuration-revision lock, or publish a complete input revision through one atomic reference. Another valid implementation is a generation protocol that marks an edit in progress before any file changes and commits it only after the whole set is ready. Capture must reject an in-progress generation and verify the same committed generation around its read. An end-only revision bump would miss the pause above. This coordinates editing and capture, not the subsequent build.

**Smallest test:** use two dummy files with revision markers and valid complete formats. Pause a supported multi-file edit after replacing only the first file, then capture. The result must be all A, all B or a bounded refusal. It must never be B/A. Resume the edit and verify that a complete B revision can be captured. No real configuration or secret values are needed.

The single-file truncated-write test remains useful and is accepted. It does not exercise this remaining set-consistency requirement from OpenAI round 4. T04a stays provisionally M at the upper end. D08 is decided: no historical-build catalogue now, with recovery references retained.

##### Question 2. T05a blocked state and automatic positive release

**Dispute the timestamp-only automatic inference. Approve the blocked-state mechanism, manual verification path and M estimate.**

The time-based image-stability release is gone, which closes the previously disputed timer rule. The replacement's build-order premise is supported for the recorded Compose version. In v5.1.4, `create` calls `ensureImagesExists` before container convergence, and `ensureImagesExists` waits for the build call to return. Source read on 2026-09-07: [Compose v5.1.4 create.go](https://github.com/docker/compose/blob/v5.1.4/pkg/compose/create.go#L63), [Compose v5.1.4 build.go](https://github.com/docker/compose/blob/v5.1.4/pkg/compose/build.go#L101).

That supports a conclusion about containers actually created by this Compose invocation. **A container timestamp later than the stored job timestamp does not by itself identify that invocation.**

Exact case permitted by the recorded design:

1. A remote deployment already has all its service containers. Their creation timestamps come from the remote daemon's clock.
2. The manager records a new job's start using its own clock. The remote clock is ahead, so the old containers' creation timestamps compare later than the new job's start.
3. The new job's build is paused before export, and the manager dies.
4. Recovery finds every service and every timestamp satisfies the proposed comparison. It releases the lock even though these are the old containers and the new build remains unresolved.

This is a design counterexample, not a claim that the funded host's clock is wrong. Remote deployment is an existing path: the manager forwards the selected host at [DeploymentOrchestrator.ts:660](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:660), and the stack runs Compose on that target at [deploy.sh:580](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/swarm-hls-stream/deploy/scripts/deploy.sh:580). No shared-clock requirement or attempt-identity check appears in the proposed release rule. Local wall-clock changes can also make a time comparison unreliable.

**Smallest correction:** automatic release requires persisted or observed evidence tied to the specific job/attempt on the verified daemon. For example, identify its created containers by an attempt identifier, or retain a durable completion record for the conflicting work. Old container IDs cannot become positive completion evidence because their timestamps happen to compare later. If the implementation cannot identify completion of that attempt, use Fable's already proposed blocked state and verified operator release. It does not need a surviving executor merely to remain blocked.

**Smallest test:** give the reconciler an unresolved job starting at time 100, old container IDs with creation time 200 from an ahead remote clock, and a paused exporter for that job. All required services exist. The lock must remain blocked. Then supply genuine completion evidence for that attempt and verify that release succeeds. Keep the existing paused-exporter test with no service containers. The two tests cover different ways that incomplete evidence could unlock B.

I accept a typed operator release naming the job **after the operator has checked that its conflicting work is no longer running**, as Fable specifies. That is a human verification path. It is not an automatic assertion that absence of recent image changes proves completion, and D10's separate money-handling override does not change this rule.

The contract flag, conservative classification, all competing build paths, exact-content/exit-code harness and api toolchain pin remain accepted. The host facts now identify the test target as Engine 29.1.3 and api Compose v5.1.4. M is accepted as the revised planning estimate. D09 is decided, so T05b is no longer waiting for that policy choice.

##### Question 3. T06 daemon identity table

**Approve.**

The `deploy_targets` table supplies the shared identity missing from round 3. Two verified aliases for one daemon use the same port-reservation namespace and T05a lock key. An unverified alias refuses new allocation instead of receiving its own namespace by spelling. Persisting the alias and the daemon the job runs on preserves the relationship for diagnosis.

I accept the three recorded tests: same-daemon aliases permit only one reservation of the conflicting port, distinct daemons can reserve it independently, and local/remote aliases of one daemon collide correctly. The handover, partial-service, stopped-profile, seeding and captured-contract criteria remain in force.

T06 remains M and depends on T04a for final admission integration. **D01 is decided.** Implement `min(version maximum, 100)`, counting occupied profile records and preserving existing resources as recorded. There is no remaining OpenAI design objection to this row.

##### Question 4. Exact-set approval and the exit checklist

**Approve 23 rows. Revise T04a and T05a as above.**

Fable's other 22 rows remain approved without a new scope change, and T06 joins them. The exact row-by-row disposition follows. Owner decisions are treated as taken. Only D04/D05's outstanding inputs remain policy-related prerequisites. The two remaining technical corrections prevent full task-set approval and therefore prevent declaring the consensus exit checklist complete this round.

#### 3. Exact task set, row-by-row disposition

This table responds to **Fable round 4 section 3 in proposal-08**, including the earlier acceptance criteria it incorporates. Sizes remain planning estimates.

| Row | OpenAI round 5 | Recorded scope and dependency disposition |
| --- | --- | --- |
| T01a | **Approve.** | Docker restart-count mapping, realistic fake and adapter-to-watch test. S. Ready first. |
| T01 | **Approve.** | Persisted ownership, intent revision, durable Stop and bounded recovery. Depends on T01a. M. |
| T02 | **Approve.** | Per-request SRS check isolation and controlled cleanup/race coverage. S. Ready first. |
| T03 | **Approve.** | Strict XML, protected integration values, supported tuning, pinned pair and honest checks. Depends on T01. M. |
| T04a | **Revise.** | Per-job references and all other recorded scope accepted. Add one committed-revision rule for multi-file input capture. No build-duration lock. M, upper end. D08 is decided. |
| T04b | **Approve.** | Bundled publication, legacy preservation and first-migration/restart regression. Depends on T04a. S to M. |
| T05a | **Dispute the automatic release inference.** | Durable blocked lock and verified operator release accepted. Automatic evidence must identify this attempt, not just later timestamps. Harness and toolchain work accepted. M. |
| T05b | **Approve.** | Project-specific image names, scoped cleanup and bundled bump. Uses T05a's harness. S plus S. D09 is decided, with Levi's recorded commit/merge role. |
| T06 | **Approve.** | Daemon identity, reservations, handover, seeding and cap. Depends on T04a's captured contract. M. D01 is decided. |
| T07 | **Approve.** | One proposed state for gate, claim and write, with group outcome coverage. S. D02's refusal policy is decided. |
| T08 | **Approve.** | Build-specific approval, bundled invalidation and default retained with a warning. T04a for identity, two independent corrections ready first. S. D07 is decided. |
| T09 | **Approve.** | Durable transaction evidence, bounded recovery, verified manual evidence and explicit assertion override. Depends on T10. M, upper end. D10 is decided. |
| T10 | **Approve.** | Authenticated test client, routed credentials and run-owned inventory. S. Ready first. |
| T11 | **Approve.** | One effective-settings source with omitted and unknown values represented honestly. S. Ready first. |
| T12 | **Approve.** | Shared first blocker, truthful startup, direct logs and starting/restarting distinction. T07/T11, settlement wording after T09. M. D02 is decided. |
| T13 | **Approve.** | Generated default without a host passphrase, host default otherwise and explicit unencrypted expert mode. S. Ready first. D03 is decided. |
| T14 | **Approve, inputs pending.** | Quote first, no preselected spend, expert inputs retained and ceiling enforced. T09. M. D04 is decided, preset capacities/lifetimes and ceiling still needed. |
| T15 | **Approve.** | Retained draft through pool creation, existing capabilities preserved and names to the walkthrough. T12. M. |
| T16 | **Approve.** | Consistent, accessible validation feedback. S. Ready first. |
| T17 | **Approve.** | Protocol-aware endpoints, consuming T06 metadata where supplied. S. Ready first. |
| T18 | **Approve.** | Verified narrow layouts with accurate version states/actions. T04a/T08. S. |
| T19 | **Approve.** | Notes without deploy, conditional saves and stale-drawer protection. S. Ready first. |
| T20 | **Approve.** | CI workflow and isolated container integration. T10. M. D06 is decided, with settings changed by Levi after the workflow exists. |
| T21 | **Approve.** | Actual documentation drift corrected, no manufactured history. Depends on the tasks documented. S. |
| T22 | **Approve, inputs pending.** | Controlled live acceptance, complete evidence and funded-node retention. T10 and relevant fixes. L. D05 is decided, execution inputs still needed. |

The ready-first list remains **T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent T08 corrections**. The broad phase order is unchanged. Host-version discovery is now recorded evidence, while matching-version harness execution remains future verification work.

#### 4. Decisions taken and outstanding inputs

The following is acknowledgment of Levi's decisions, not another request for approval.

| Decision | Current disposition |
| --- | --- |
| D01 | **Decided.** The cap and lower-version maximum apply to all stored deployment records as recorded. |
| D02 | **Decided.** Refuse an unverified new uploader start, with retry guidance. Running uploaders and engine-only work retain the recorded boundary. |
| D03 | **Decided.** Generate when no host passphrase exists, retain the host default otherwise and retain explicit expert unencrypted mode. |
| D04 | **Policy decided, numbers pending.** Quote first, expert inputs retained, no preselected spend and an enforced ceiling. Levi still supplies preset capacities, lifetimes and the ceiling. |
| D05 | **Policy decided, execution details pending.** Keep and reuse the funded node. Levi still supplies the spending cap, duration, publishing input and disposition of funds after the test. |
| D06 | **Decided.** Required T20 checks, Levi's bypass and no agent direct push. Workflow first, settings change by Levi. |
| D07 | **Decided.** Keep the default with a visible lost-approval warning. No silent alternative selection. |
| D08 | **Decided.** No historical-build catalogue now. Recovery artifacts remain retained. |
| D09 | **Decided.** Stack correction and bundled bump, scoped cleanup, Levi's commit/merge role and no automatic restart. |
| D10 | **Decided.** Explicit typed assertion closure after the search pass, with amount and duplicate-payment risk stated. An assertion remains unverified evidence and does not itself submit another transfer. |

Neither D10 nor an empty balance resolves the historical 0.5 BZZ fill. Transaction evidence is still required before describing its submission or outcome. Paid live acceptance remains unfinished. These are execution facts to preserve, not reasons to reopen Levi's chosen policies.

#### 5. Agreement register and remaining disagreements

I updated only the **OpenAI position** cells in the agreement register. Topic, Fable position and State cells are unchanged, including Fable's attributed record of Levi's decisions. The document revision/state metadata was advanced and this round appended. Every earlier comment and historical handoff prompt is preserved word for word.

I mark the following jointly agreed in my column because Fable round 4 states them and I now accept them:

- The finding dispositions and priorities, including T01a within R01 and N01 within T03.
- The phase order, ready-first list and newly recorded host/api tool versions with attribution to Levi.
- The 23 individually approved task rows, including T06. T04a's per-job reference mechanism is accepted separately within that still-open row.
- D01 through D10 as decisions already taken by Levi, with D04/D05's specified inputs outstanding.
- Incomplete live acceptance and the unverified 0.5 BZZ submission.

The task-set row remains partial agreement. **Two technical disagreements remain: T04a's multi-file revision capture and T05a's attribution of automatic completion evidence to the orphaned attempt.** Both are narrower than the previous round. No owner policy is reopened.

Precise questions for Fable round 5:

1. **T04a:** which single committed-revision mechanism coordinates a supported multi-file edit with capture? Accept the test that pauses between two valid atomic replacements. Per-file stats and format checks must not accept a B/A revision.
2. **T05a:** can you replace timestamp-only attribution with evidence identifying the job/attempt, or retain the blocked state whenever that evidence is unavailable? Accept the ahead-clock test where all containers predate the job despite later timestamps. The Compose build-before-create premise is accepted for v5.1.4.
3. Confirm the other 23 task rows and the settled D01–D10 policies. Publish the exact revised set, keeping D04/D05 inputs and the 0.5 BZZ evidence gap explicit. If the two corrections above are accepted, no other technical objection is carried forward from this round.

#### Handoff prompt for Fable round 5

```text
You are Fable, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64.

First run git rev-parse HEAD and git diff --stat d046ebf HEAD. Read the repository instructions and the whole document, especially OpenAI round 5 and its three closing questions.

Append Fable round 5 under Comments after OpenAI round 5. Preserve every earlier comment word for word. Identify your actual model and provider. Update only your Fable position cells in the agreement register.

OpenAI approves 23 of your 25 task rows. T06 is now accepted. T04a's per-job reference mechanism is also accepted. Two precise corrections remain:
- T04a: a supported multi-file edit can pause between two valid atomic replacements. Per-file stats, parsing and a final recheck then accept a mixed B/A revision. Specify one committed-revision mechanism shared by editing and capture, with the minimal test in OpenAI round 5.
- T05a: Compose v5.1.4's build-before-create order is source-confirmed, but container timestamps later than a job start do not identify that job. An ahead remote clock makes old containers satisfy that rule. Use attempt-specific completion evidence, or keep the lock blocked when that evidence is missing. Accept the old-container/ahead-clock regression.

Answer the three closing questions and confirm the other 23 task rows. Treat D01 through D10 as decided by Levi, with only D04/D05's specified numbers and execution details pending. Host Engine 29.1.3 and api Compose v5.1.4 are recorded facts from Levi's read-only checks, not a matching-version R04 test result.

Publish one exact attributed task set for final approval. Do not reopen agreed scope without new evidence. End with remaining disagreements and a handoff prompt, or explicit approval of the exact set if no technical disagreement remains.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure actions. Do not run the R04 script on the host. The funded review-20260907 deployment is not disposable. The 0.5 BZZ fill's submission remains unverified. Do not call it unsent, settled or safe to retry without transaction evidence.
```

### Fable round 5, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, in Claude Code on Levi's machine. Label: **cross-provider review, Anthropic-hosted**. This round answers OpenAI round 5. It writes nothing on OpenAI's behalf and changes nothing outside this document.

#### 1. Baseline and evidence

- `git rev-parse HEAD` is `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. `git diff --stat d046ebf HEAD` is empty. The working tree holds only `.scratch/`.
- Ran: nothing. No host contact, no container, no experiment. The funded `review-20260907` deployment was not touched. The 0.5 BZZ fill stays unverified with no transaction identity in this document.
- Host Engine 29.1.3 and api container Compose v5.1.4 stand as Levi's read-only readings of 2026-09-07. They are not a matching-version R04 result, and T05a's harness runs against them before release acceptance, as OpenAI records.
- D01 through D10 are decided. Only D04 and D05 wait for Levi's numbers and execution details.

#### 2. Answers to OpenAI's three questions

##### Question 1, T04a. Agree. One committed revision, shared by editing and capture.

OpenAI's interleaving is real: two atomic single-file replacements with a pause between them give capture a valid B and a valid A, and no per-file check can see that they belong to different revisions. The correction adds one mechanism that both the supported editor and capture use:

- **A revision manifest as the commit.** Each version root, and the bundled root, carries `.config-revision.json`: a generation number and the hash of every host-owned file in the set, today `.env`, `deploy/config.json` and every `engines/<engine>/.env`. It is written last, by atomic rename. A revision exists only when its manifest does.
- **One advisory lock around the whole edit.** The supported editing path is a small manager-provided script in the checkout, `deploy/scripts/stack-config-edit.sh`, which takes `flock` on `<root>/.config.lock`, opens the operator's editor or applies the given changes, replaces each file atomically, writes the manifest, and releases. Capture takes the same lock with a bounded wait. Both processes run on one kernel, the api container's bind mount included, so the lock holds across them. The manager's own writers of host-owned files, including the sample bootstrap, go through the same script.
- **Capture verifies the commit, not the files.** Under the lock, capture reads the manifest, reads each listed file with the per-file rules from round 4, and compares every hash to the manifest. Any mismatch refuses publication and names the file. A file present in the set but missing from the manifest refuses too. The captured bytes and the generation are stored with the build or job.
- **Three ways to be wrong, all refused.** An editor paused inside the lock makes capture wait and then refuse with "the host configuration is being edited". An editor that died between two replacements leaves files that do not match the manifest, refused by hash until the operator commits again with the script. An edit outside the script is unsupported, is refused by hash as well, and the documentation says how to commit it.
- **Migration.** A root without a manifest gets generation 1 from its current bytes at the manager's first boot after the change, recorded as such, because nothing older exists to compare against.

OpenAI's test is accepted as written: two dummy files with revision markers, a supported edit paused after the first replacement, capture yields all A, all B or a bounded refusal and never B/A, and after the edit resumes a complete B is captured. The single-file truncation test stays. The mechanism coordinates editing with capture only, never with a build, so no build-duration lock returns. M at the upper end stands.

##### Question 2, T05a. Agree. Attempt identity from container ids, no clocks.

Timestamps compare clocks, and a remote daemon's clock is not the manager's. The evidence that identifies the attempt is the set of container ids that existed before it started:

- **Before spawning a legacy job**, the manager lists the project's containers on the verified daemon, all states, and persists their ids in the lock row as the pre-job set, together with the services the job will touch.
- **Automatic release** needs, for every service the job touched, a container whose id is not in the pre-job set. Only this job creates containers in that project while the claim holds, so a new id is this attempt's work, and Compose v5.1.4 creates nothing before every build has returned, which OpenAI confirmed from source. A new id for every touched service therefore proves the build phase finished before the manager died, whatever any clock says.
- **Anything less stays blocked.** Old ids with later timestamps are in the pre-job set and prove nothing. A job whose `up --build` recreated nothing, because the configuration was unchanged, leaves the same ids and stays blocked too. That is safe and it is said on the Versions page, and the typed operator release after checking the host remains the way out.
- Docker's own restart keeps a container's id, so a restarted old container cannot pose as new.

OpenAI's two tests are accepted: an unresolved job with old container ids carrying later creation times from an ahead clock and a paused exporter stays blocked, and genuine new ids for every touched service release it. The paused-exporter test with no service containers stays. Blocked state, typed release, the shared-tag flag, unknown as shared, every build path through `runJob`, the harness against Engine 29.1.3 and Compose v5.1.4, and the api image pin are unchanged. M stands.

##### Question 3. The set, confirmed.

The other 23 rows are confirmed as OpenAI recorded them in round 5 section 3. D01 through D10 are treated as decided. The exact set follows, and it keeps D04 and D05's pending inputs and the 0.5 BZZ evidence gap visible.

#### 3. Exact task set for final approval, Fable's attributed proposal

"Approved by both" carries OpenAI's round 5 approval and mine. "Revised, awaiting OpenAI" is this round's design for the two remaining corrections. Nothing here is implementation authorisation.

| Row | Scope in one line | Depends on | Decision | Size | State |
| --- | --- | --- | --- | --- | --- |
| T01a | Top-level Docker restart count, real-shape test double, adapter-to-watch regression | none | none | S | Approved by both, ready first |
| T01 | Persisted operation, instance id, intent revision, durable Stop, identity-based boot verification, owned recovery, conditional completion | T01a | none | M | Approved by both |
| T02 | One directory per SRS check, read-only mount, controlled race tests | none | none | S | Approved by both, ready first |
| T03 | Strict XML, path-set contract, protected versus tunable placeholders, pinned OME pair, liveness probe, integration gate | T01 | none | M | Approved by both |
| T04a | Immutable per-build directories, captured descriptor, locked reference acquisition and prune, per-job build references resolved from observation, committed-revision capture of host-owned inputs under one lock and manifest, layout state, sibling migration, per-attempt staging, manifest reader, per-service revisions | none | D08 decided | M, upper end | Revised, awaiting OpenAI |
| T04b | Bundled stack published per commit by the manager's deploy, manifest, legacy fallback, first-migration and restart consistency regression | T04a | none | S to M | Approved by both |
| T05a | Shared-tag flag, durable per-daemon lock with a persisted pre-job container set, automatic release only on new ids for every touched service, typed operator release otherwise, api Compose identity recorded and pinned, harness against Engine 29.1.3 and Compose v5.1.4 | none | none | M | Revised, awaiting OpenAI |
| T05b | Stack image names, `clean.sh --rmi local`, main-v3 commit, bundled bump | T05a for the harness | D09 decided, Levi's commits | S plus S | Approved by both |
| T06 | Reservation table with states and reasons, protocol from Compose, handover, seeding, daemon identity across aliases, `min(version max, 100)` | T04a for the pinned contract | D01 decided | M | Approved by both |
| T07 | One proposed row for gate, claim and write, group all-or-partial | none | D02 decided | S | Approved by both |
| T08 | Bundled invalidation, Tested write conditioned on build id and ready, default kept with a warning | T04a for build id | D07 decided | S | Approved by both, two parts ready first |
| T09 | Pre-submission record, one open operation per node, receipt by hash, full-identity recovery with bounded resumable scan, manual evidence, assertion override | T10 | D10 decided | M, upper end | Approved by both |
| T10 | Login, cookie, header, routed credentials, run id and tracked inventory | none | none | S | Approved by both, ready first |
| T11 | One effective-settings source, omitted keys reported as omitted | none | none | S | Approved by both, ready first |
| T12 | One first-blocker rule, honest node startup, logs per row, starting versus restarting, refusal when the node does not answer | T07, T11 | D02 decided | M | Approved by both |
| T13 | Generated passphrase when the host has none, host default kept, expert unencrypted kept | none | D03 decided | S | Approved by both, ready first |
| T14 | Guided stamp quote, no preselected spend, ceiling enforced | T09 | D04 decided, numbers pending | M | Approved by both, inputs pending |
| T15 | Pool route with a retained draft, names to the walkthrough | T12 | none | M | Approved by both |
| T16 | Consistent validation feedback | none | none | S | Approved by both, ready first |
| T17 | Protocol-aware endpoints, T06 metadata where supplied | none | none | S | Approved by both, ready first |
| T18 | Narrow layouts with agreed version states | T04a, T08 | none | S | Approved by both |
| T19 | Notes route without a deploy, stale-drawer protection | none | none | S | Approved by both, ready first |
| T20 | CI workflow and container job, protection after the workflow exists | T10 | D06 decided | M | Approved by both |
| T21 | Documentation reconciled, no manufactured history | the tasks it documents | none | S | Approved by both |
| T22 | Controlled live acceptance run, funded node kept | T10 and the fixes | D05 decided, inputs pending | L | Approved by both, inputs pending |

Ready first, unchanged: T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent parts of T08. Phase order unchanged. Still open outside the task set: Levi's numbers for D04 and D05, and the 0.5 BZZ fill's transaction identity.

#### 4. Register update

Only the Fable position cells are updated. I do not mark the task-set row jointly agreed while T04a and T05a await OpenAI round 6.

#### 5. Remaining disagreements and the next round

Disagreements from my side: none. Both round 5 cases are adopted with a mechanism and the tests OpenAI wrote.

Questions for OpenAI round 6:

1. Does the lock-and-manifest committed revision close T04a's multi-file capture as recorded?
2. Does the persisted pre-job container set, with release only on new ids for every touched service, close T05a as recorded?
3. If yes, approve the exact set in section 3 row by row and state that the consensus exit checklist is complete, naming what stays open outside it: Levi's D04 and D05 inputs and the 0.5 BZZ fill's evidence. The task catalog can then become the issue files the scope section names, ready for Levi's separate authorisation to implement, starting with the ready-first rows.

#### Handoff prompt for OpenAI round 6

The prompt Levi relays is at the end of this document, under "Handoff prompts".

### OpenAI round 6, 2026-09-07

Author: Codex, OpenAI-hosted. Model family: GPT-6, as identified by this session's instructions. The exact serving model identifier is not exposed here. Provider: OpenAI. **cross-provider review, OpenAI-hosted**.

I approve T04a and confirm the other 23 approved rows. **24 of the 25 task rows are now agreed.** T05a has one remaining ownership gap: a container absent from the pre-job set can belong to a later job if the orphaned project's admission claim was released on restart. The smallest correction is to retain exclusive container-creation admission for that project until the orphaned attempt is resolved.

D01 through D10 remain decided by Levi. D04/D05 inputs, the 0.5 BZZ fill's evidence and the matching-version harness run remain outstanding. The consensus exit checklist is not yet complete because of the single T05a correction below.

#### 1. Baseline and evidence boundary

The first commands were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD remains **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64**. The diff is empty. The working-tree status remains only `?? .scratch/`.

I read the repository instructions and Fable round 5 sections 1 through 5, its exact task set and the updated register. I compared the retained full document from round 5 with the current document. The earlier comments, proposal, decision record and host evidence are unchanged apart from the stated metadata/register updates and new round/handoff. The new material was read in full.

The source checks this round were local, read-only checks of deployment admission and restart recovery. The case below is a design analysis and proposed regression, not a newly executed experiment. No tests, containers, builds, pulls, deployments or infrastructure operations ran.

Host **Engine 29.1.3** and api **Compose v5.1.4** remain Levi's recorded read-only observations. T05a's harness has not yet verified that pair. **The 0.5 BZZ fill's submission remains unverified.** Nothing in this round establishes that it was unsent, settled or safe to retry. The funded review deployment remains retained and protected.

#### 2. Answers to Fable's three questions

##### Question 1. T04a committed-revision capture

**Approve.**

The shared edit/capture lock closes the supported multi-file edit interleaving. Capture cannot enter while an editor has replaced B's first file but has not committed the complete revision. The manifest written last supplies the commit boundary. Hash verification after obtaining the lock detects an editor that died partway through replacement.

I accept the recorded outcomes:

- A supported editor paused inside the lock causes bounded waiting and then refusal, not a B/A capture.
- A crash before the manifest commit leaves a mismatch that refuses publication until the configuration is committed again.
- A completed edit lets capture retain one complete revision, its generation and the exact bytes used for the recorded hashes.
- Changes outside the supported editing path are detected against the manifest and receive explicit corrective guidance.

The two-file pause test and the existing truncated-input test remain acceptance criteria. The lock covers editing and capture only. It does not extend across the build. Generation 1 records the bytes adopted at migration, without claiming that an older revision was verified.

The already accepted per-job references, service-specific observation, prune coordination, immutable artifacts, explicit layout, sibling migration, staging ownership and manifests stand. T04a's M-at-the-upper-end estimate and T04b's dependency are accepted. D08 is decided: no historical-build catalogue now, with required recovery artifacts retained.

##### Question 2. T05a pre-job container identities

**Revise. The clock comparison is fixed. The exclusive-creator premise still needs a durable admission rule.**

Persisting the pre-job IDs on the verified daemon eliminates the ahead-clock counterexample. A restart of an old container keeps it in that set. A no-op recreate remains conservatively blocked, as Fable now states. I accept those corrections and the existing three recovery tests.

The inference from “not in the pre-job set” to “created by this attempt” depends on the sentence that only this job creates containers in the project while its claim holds. That premise must continue to hold during orphan recovery. The recorded design does not currently establish it.

The reviewed restart path changes DEPLOYING to ERROR at [ProfileRepository.ts:307](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/ProfileRepository.ts:307). ERROR permits another deployment claim at [DeploymentOrchestrator.ts:102](/Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/manager/src/domain/DeploymentOrchestrator.ts:102). Fable round 4's T04a design explicitly allows another claim while older build references remain unresolved. T05a's recorded daemon lock serializes shared-tag jobs while allowing fixed project-image jobs to run concurrently.

**Exact interleaving, using only manager-controlled jobs:**

1. Legacy attempt A starts for project P. Its persisted pre-job set contains P's old container IDs. A is paused before exporting a shared image.
2. The manager restarts. P becomes ERROR, while A's daemon lock and unresolved work remain.
3. The selected version publishes the D09 correction and now uses project-specific images. This changes the next admitted job's artifact, not A's captured artifact.
4. A new attempt B for the same project P passes the ERROR admission check. It uses the fixed-image path, which does not wait for the legacy daemon lock, and creates new IDs for all the services A touched. B may fail after creation and leave P in ERROR again.
5. Reconciliation of A sees IDs absent from A's pre-job set and releases A's lock. Those IDs belong to B. A's original export is still unresolved.
6. Another legacy project can now enter the shared-tag build/create section while A can still export to that tag. The original image race is possible again.

This does not require an external operator bypassing the manager, a clock error or a Docker ID being reused. The IDs identify new containers, but without exclusive admission they do not identify which attempt created them.

**Smallest correction:** an unresolved legacy attempt retains a durable container-creation guard for its **daemon and Compose project**, regardless of the next version's `sharedImageTags` value. Check that guard atomically before admitting any new creating/recreating job for P, including after restart and name reuse. Install the guard before capturing A's pre-job IDs and keep it until A is resolved. Fixed-image work for other projects can still run concurrently.

With that guard, Fable's new-ID proof works within the manager's stated exclusive-creator model. An alternative is explicit attempt-specific completion evidence, but a surviving executor is not required just to enforce this project guard. Unresolved evidence still uses the blocked state and the recorded verified operator-release path.

**Smallest regression:** persist A's pre-job set and unresolved export, simulate restart to ERROR, then publish a fixed-image version and request B for the same project. B must be refused or wait until A is resolved, even though B uses project-specific images. A fixed-image job for another project must remain allowed. After A resolves, B may proceed. A reconciler fixture with new IDs explicitly belonging to B must never count them as completion of A.

The Compose v5.1.4 build-before-create premise remains accepted from the source check in round 5. This round disputes only attribution of the new containers to A. The durable lock, conservative classification, clock-free comparison, blocked/no-op behavior, typed verified release, M estimate, toolchain pin and matching-version harness are otherwise accepted.

##### Question 3. Exact-set approval and the exit checklist

**Approve 24 rows. T05a alone needs the admission correction above.**

No other task scope or owner policy is reopened. The row-by-row record follows. Full approval and the consensus exit declaration wait only for the T05a ownership rule to be recorded explicitly.

#### 3. Exact task set, row-by-row disposition

This table responds to **Fable round 5 section 3 in proposal-10**, including the earlier scope and acceptance criteria incorporated there.

| Row | OpenAI round 6 | Recorded scope, dependency and size |
| --- | --- | --- |
| T01a | **Approve.** | Top-level Docker restart count, realistic fake and adapter-to-watch test. S. Ready first. |
| T01 | **Approve.** | Persisted ownership, intent revision, durable Stop and bounded recovery. T01a. M. |
| T02 | **Approve.** | Per-request SRS check isolation and controlled cleanup/race coverage. S. Ready first. |
| T03 | **Approve.** | Strict XML, integration contract, supported tuning, pinned pair and honest checks. T01. M. |
| T04a | **Approve.** | Immutable builds, per-job references and committed input revision under the shared lock and manifest. All prior migration/prune criteria stand. M, upper end. D08 decided. |
| T04b | **Approve.** | Bundled publication, legacy preservation and first-migration/restart regression. T04a. S to M. |
| T05a | **Revise.** | All recorded scope accepted except the missing durable exclusive-creator guard for an orphaned project's recovery. Add the same-project fixed-image retry regression. M. |
| T05b | **Approve.** | Project-specific image names, scoped cleanup and bundled bump. T05a's harness. S plus S. D09 decided, with Levi's recorded commit/merge role. |
| T06 | **Approve.** | Daemon identity, reservations, handover, seeding and cap. T04a's captured contract. M. D01 decided. |
| T07 | **Approve.** | One proposed state for validation, admission and persistence, with group outcome coverage. S. D02 decided. |
| T08 | **Approve.** | Build-specific approval, bundled invalidation and retained default with a warning. T04a for identity, two independent fixes ready first. S. D07 decided. |
| T09 | **Approve.** | Durable transaction evidence, bounded recovery, manual evidence and explicit assertion override. T10. M, upper end. D10 decided. |
| T10 | **Approve.** | Authenticated test client, routed credentials and run-owned inventory. S. Ready first. |
| T11 | **Approve.** | One effective-settings source with omitted and unknown values represented honestly. S. Ready first. |
| T12 | **Approve.** | Shared first blocker, truthful startup, direct logs and starting/restarting distinction. T07/T11, settlement wording after T09. M. D02 decided. |
| T13 | **Approve.** | Generated default without a host passphrase, host default otherwise and explicit unencrypted expert mode. S. Ready first. D03 decided. |
| T14 | **Approve, inputs pending.** | Quote first, expert inputs retained and ceiling enforced. T09. M. D04 policy decided, numerical inputs pending. |
| T15 | **Approve.** | Retained draft through pool creation and names to the walkthrough. T12. M. |
| T16 | **Approve.** | Consistent, accessible validation feedback. S. Ready first. |
| T17 | **Approve.** | Protocol-aware endpoints, consuming T06 metadata where supplied. S. Ready first. |
| T18 | **Approve.** | Verified narrow layouts with accurate version states/actions. T04a/T08. S. |
| T19 | **Approve.** | Notes without deploy, conditional saves and stale-drawer protection. S. Ready first. |
| T20 | **Approve.** | CI workflow and isolated container integration. T10. M. D06 decided, settings changed by Levi after the workflow exists. |
| T21 | **Approve.** | Actual documentation drift corrected without manufactured history. Depends on the tasks documented. S. |
| T22 | **Approve, inputs pending.** | Controlled live acceptance, complete evidence and funded-node retention. T10 and relevant fixes. L. D05 policy decided, execution inputs pending. |

The ready-first list remains **T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent T08 corrections**. Phase order and estimates are unchanged. Approval here is planning agreement, not permission to create issues, implement, change settings or operate infrastructure in this round.

#### 4. Decisions and execution items that remain open

D01 through D10 stand as Levi decided them on 2026-09-07. They are not reopened or presented as unanswered policy gates.

The following stay open outside the technical planning dispute:

- **D04 inputs:** preset capacities, lifetimes and spending ceiling for guided stamp purchase.
- **D05 inputs:** test spending cap, duration, publishing input and the disposition of funds after the test. The funded node is kept and reused.
- **The 0.5 BZZ fill:** its submission and outcome require transaction evidence. D10 does not supply that evidence.
- **T05a's matching-version harness:** future isolated execution against Engine 29.1.3 and api Compose v5.1.4. Fable's earlier experiment on different versions remains attributed evidence, not this acceptance run.
- Implementation and the full controlled live acceptance run remain future work under the agreed task set and separate authorization.

#### 5. Agreement register and remaining disagreement

Only the **OpenAI position** cells were changed in the agreement register. Topic, Fable position and State cells remain unchanged. The document revision/state metadata was advanced and this round appended. Earlier comments and historical handoff prompts are preserved word for word.

I mark these positions jointly agreed because Fable round 5 states them and I accept them:

- The finding dispositions and priorities, T01a within R01 and N01 within T03.
- The phase order, ready-first list and host-version evidence boundary.
- All 24 individually approved task rows, now including T04a's complete recorded design.
- D01 through D10 as decided, with D04/D05 inputs outstanding.
- Incomplete live acceptance, the unverified fill and the future matching-version harness obligation.

**T05a is the only remaining technical disagreement.** A pre-job set proves attempt identity only while no later job can create containers for that same project. That exclusivity must survive orphan recovery and apply even when the later job uses fixed project images. The consensus exit checklist remains incomplete until this rule is agreed.

Precise questions for Fable round 6:

1. Will you retain the unresolved attempt's durable exclusive container-creation guard for the same daemon/project across restart, applying it to both shared-tag and fixed-image attempts, and accept the fixed-image retry regression in answer 2? Alternatively, specify attempt-specific completion evidence that cannot mistake B's containers for A's.
2. Confirm the other 24 rows and publish the exact final set with this one correction. Keep the settled D01–D10 policies, D04/D05 inputs, fill evidence and later matching-version harness explicitly separated. No other technical objection is carried forward from OpenAI round 6.

#### Handoff prompt for Fable round 6

```text
You are Fable, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64.

First run git rev-parse HEAD and git diff --stat d046ebf HEAD. Read the repository instructions and the whole document, especially OpenAI round 6 and its two closing questions.

Append Fable round 6 under Comments after OpenAI round 6. Preserve every earlier comment word for word. Identify your actual model and provider. Update only your Fable position cells in the agreement register.

OpenAI approves 24 of your 25 task rows. T04a's lock-and-manifest design is accepted. T05a alone remains open:
A persisted pre-job container set identifies the orphaned attempt only if no later job can create containers in that same project. Restart changes DEPLOYING to ERROR. A later attempt using a newly fixed version can bypass the legacy shared-tag lock and create new IDs, which would then falsely resolve the old attempt while its export is still outstanding.

The smallest proposed correction is a durable exclusive container-creation guard for the unresolved attempt's daemon and Compose project, checked before every new same-project admission regardless of sharedImageTags. Other projects with fixed images may continue. Accept the regression in OpenAI round 6 or supply an alternative attempt-specific proof.

Answer both closing questions. Confirm the other 24 rows and publish the exact set. D01 through D10 remain decided. D04/D05 inputs, the 0.5 BZZ fill's evidence and the later isolated harness on Engine 29.1.3 and Compose v5.1.4 remain outstanding. End with remaining disagreements and a handoff, or explicit approval of the recorded set if no technical disagreement remains.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure operations. Do not run the R04 script on the host. The funded review-20260907 deployment is not disposable. The 0.5 BZZ fill's submission remains unverified. Do not call it unsent, settled or safe to retry without transaction evidence.
```

### Fable round 6, 2026-09-07

Author: Fable 5.1, Anthropic model `claude-fable-5-1`, in Claude Code on Levi's machine. Label: **cross-provider review, Anthropic-hosted**. This round answers OpenAI round 6 and closes the last open row from Fable's side. Levi asked on 2026-09-07 for a decision now, and this round is it.

#### 1. Baseline and evidence

- `git rev-parse HEAD` is `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. `git diff --stat d046ebf HEAD` is empty. The working tree holds only `.scratch/`.
- Ran: nothing. No host contact, no container, no experiment. The funded `review-20260907` deployment was not touched. The 0.5 BZZ fill stays unverified with no transaction identity in this document.

#### 2. Answers to OpenAI's two questions

##### Question 1, T05a. Agree. The guard is adopted, and extended to every attempt.

OpenAI's interleaving holds: after a restart the profile is ERROR, ERROR admits a new claim, and a retry on a version that no longer builds shared tags does not touch the legacy lock, so its new container ids would be mistaken for the orphaned attempt's work. The pre-job set proves identity only while nothing else can create containers in that project.

The rule, as recorded from OpenAI round 6 with one extension:

- **A durable creation guard per daemon and Compose project.** Every deploy attempt, legacy or fixed-image, takes the guard for its daemon and project in the same transaction that captures its pre-job container set, before anything is spawned. The guard names the attempt.
- **Checked at every admission for that project**, whatever the version's `sharedImageTags` says, including after a restart and after a name is reused, because the guard is keyed by daemon and project, not by the profile row's status. ERROR alone does not clear it.
- **Released only when the attempt resolves**: automatically, by a new container id for every service the attempt touched, which the guard now makes attributable to that attempt alone, or by the typed operator release after checking the host. Unresolved stays blocked, and the Versions page and the deployment page say which attempt holds it.
- **Other projects are unaffected.** Fixed-image jobs for other projects run concurrently. Legacy jobs for other projects still queue on the daemon lock as before.

The extension: OpenAI scoped the guard to an unresolved legacy attempt. I apply it to every attempt, because the same-project variant of the race exists without shared tags. A fixed-image attempt A paused before its export, a retry B for the same project that builds and then creates, and A's delayed export landing between B's build and B's create put A's image under B's container. One guard per project, held by any unresolved attempt, closes both. The cost is that a deployment whose deploy was cut short by a restart must be resolved, automatically or by the typed release, before it can be retried, which is the truthful state.

OpenAI's regression is accepted as written: A's pre-job set and unresolved export persisted, a restart to ERROR, a fixed-image version published, B requested for the same project and refused or held until A resolves, a fixed-image job for another project allowed, B allowed after A resolves, and a reconciler fixture where ids belonging to B are never counted as A's completion. One assertion is added for the extension: the same sequence with A on a fixed-image version, with the same outcome.

Everything else in T05a stands: the durable daemon lock for shared tags, unknown classification as shared, the clock-free comparison, the blocked state, the typed release, the harness against Engine 29.1.3 and Compose v5.1.4, the api image pin, and M.

##### Question 2. The set, published as final from Fable's side.

The other 24 rows are confirmed exactly as OpenAI recorded them in round 6 section 3. With the guard above, Fable has no open technical point on any row. The exact set follows, and Fable approves it as the recorded task set, subject only to OpenAI confirming its own round 6 guard as recorded here.

#### 3. Exact task set, final from Fable's side

Nothing here is implementation authorisation. Levi's separate word starts work, beginning with the ready-first rows.

| Row | Scope in one line | Depends on | Decision | Size | State |
| --- | --- | --- | --- | --- | --- |
| T01a | Top-level Docker restart count, real-shape test double, adapter-to-watch regression | none | none | S | Approved by both, ready first |
| T01 | Persisted operation, instance id, intent revision, durable Stop, identity-based boot verification, owned recovery, conditional completion | T01a | none | M | Approved by both |
| T02 | One directory per SRS check, read-only mount, controlled race tests | none | none | S | Approved by both, ready first |
| T03 | Strict XML, path-set contract, protected versus tunable placeholders, pinned OME pair, liveness probe, integration gate | T01 | none | M | Approved by both |
| T04a | Immutable per-build directories, captured descriptor, locked reference acquisition and prune, per-job build references resolved from observation, committed-revision capture under one lock and manifest, layout state, sibling migration, per-attempt staging, manifest reader, per-service revisions | none | D08 decided | M, upper end | Approved by both |
| T04b | Bundled stack published per commit by the manager's deploy, manifest, legacy fallback, first-migration and restart consistency regression | T04a | none | S to M | Approved by both |
| T05a | Shared-tag flag, durable per-daemon lock, per-project creation guard held by every unresolved attempt, persisted pre-job container set, automatic release only on new ids for every touched service, typed operator release otherwise, api Compose identity recorded and pinned, harness against Engine 29.1.3 and Compose v5.1.4 | none | none | M | Approved by Fable with OpenAI's round 6 guard, awaiting OpenAI's confirmation |
| T05b | Stack image names, `clean.sh --rmi local`, main-v3 commit, bundled bump | T05a for the harness | D09 decided, Levi's commits | S plus S | Approved by both |
| T06 | Reservation table with states and reasons, protocol from Compose, handover, seeding, daemon identity across aliases, `min(version max, 100)` | T04a for the pinned contract | D01 decided | M | Approved by both |
| T07 | One proposed row for gate, claim and write, group all-or-partial | none | D02 decided | S | Approved by both |
| T08 | Bundled invalidation, Tested write conditioned on build id and ready, default kept with a warning | T04a for build id | D07 decided | S | Approved by both, two parts ready first |
| T09 | Pre-submission record, one open operation per node, receipt by hash, full-identity recovery with bounded resumable scan, manual evidence, assertion override | T10 | D10 decided | M, upper end | Approved by both |
| T10 | Login, cookie, header, routed credentials, run id and tracked inventory | none | none | S | Approved by both, ready first |
| T11 | One effective-settings source, omitted keys reported as omitted | none | none | S | Approved by both, ready first |
| T12 | One first-blocker rule, honest node startup, logs per row, starting versus restarting, refusal when the node does not answer | T07, T11 | D02 decided | M | Approved by both |
| T13 | Generated passphrase when the host has none, host default kept, expert unencrypted kept | none | D03 decided | S | Approved by both, ready first |
| T14 | Guided stamp quote, no preselected spend, ceiling enforced | T09 | D04 decided, numbers pending | M | Approved by both, inputs pending |
| T15 | Pool route with a retained draft, names to the walkthrough | T12 | none | M | Approved by both |
| T16 | Consistent validation feedback | none | none | S | Approved by both, ready first |
| T17 | Protocol-aware endpoints, T06 metadata where supplied | none | none | S | Approved by both, ready first |
| T18 | Narrow layouts with agreed version states | T04a, T08 | none | S | Approved by both |
| T19 | Notes route without a deploy, stale-drawer protection | none | none | S | Approved by both, ready first |
| T20 | CI workflow and container job, protection after the workflow exists | T10 | D06 decided | M | Approved by both |
| T21 | Documentation reconciled, no manufactured history | the tasks it documents | none | S | Approved by both |
| T22 | Controlled live acceptance run, funded node kept | T10 and the fixes | D05 decided, inputs pending | L | Approved by both, inputs pending |

Ready first: T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent parts of T08. Phase order unchanged.

Open outside the task set, unchanged: Levi's numbers and execution details for D04 and D05, the 0.5 BZZ fill's transaction identity, and the matching-version harness run that T05a performs later on Engine 29.1.3 and Compose v5.1.4.

#### 4. Register update

Only the Fable position cells are updated. Fable's position on the task-set row is now final approval of the set above. The state cell stays as it is until OpenAI confirms, because the rules let neither reviewer mark the other's acceptance.

#### 5. Remaining disagreements and the next round

Disagreements from my side: none. Every case OpenAI raised in six rounds is adopted with a mechanism and a test, and Fable approves the exact recorded set.

One question for OpenAI round 7: do you confirm T05a with your round 6 guard as recorded here, extended to every attempt, and with that declare the consensus exit checklist complete, naming the three open items outside the set? If yes, the debate ends and the task catalog becomes the issue files the scope section names, awaiting Levi's separate authorisation to implement.

#### Handoff prompt for OpenAI round 7

The prompt Levi relays is at the end of this document, under "Handoff prompts".

### OpenAI round 7, 2026-09-07

Author: Codex, OpenAI-hosted. Model family: GPT-6, as identified by this session's instructions. Exact serving model identifier not exposed. Provider: OpenAI. **cross-provider review, OpenAI-hosted**.

The first commands were `git rev-parse HEAD` and `git diff --stat d046ebf HEAD`. HEAD remains **d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64** and the diff is empty. I read the repository instructions and Fable round 6, and verified that the earlier proposal and comments are unchanged. No infrastructure operation or test ran.

**T05a: approve as recorded, including the extension to every attempt.** The durable daemon/project guard prevents a later attempt from supplying container IDs that falsely resolve the orphaned attempt. Applying it to fixed-image attempts also closes the same-project tag race. I accept the added regression assertion, the pre-job set, blocked recovery, verified operator release, unrelated-project concurrency and M estimate. No technical disagreement remains.

I approve **the exact task set in Fable round 6 section 3 of proposal-12**, without amendment. Each row below includes its recorded scope, dependencies, decided policies, estimates and incorporated acceptance criteria.

| Row | OpenAI round 7 |
| --- | --- |
| T01a | Approve |
| T01 | Approve |
| T02 | Approve |
| T03 | Approve |
| T04a | Approve |
| T04b | Approve |
| T05a | Approve |
| T05b | Approve |
| T06 | Approve |
| T07 | Approve |
| T08 | Approve |
| T09 | Approve |
| T10 | Approve |
| T11 | Approve |
| T12 | Approve |
| T13 | Approve |
| T14 | Approve, D04 inputs pending |
| T15 | Approve |
| T16 | Approve |
| T17 | Approve |
| T18 | Approve |
| T19 | Approve |
| T20 | Approve |
| T21 | Approve |
| T22 | Approve, D05 inputs pending |

Only the OpenAI column of the agreement register was updated. I mark the finding dispositions, phase order, all 25 task rows, settled D01–D10 policies and recorded evidence limits jointly agreed because Fable round 6 explicitly accepts those same positions. Fable's cells, State cells and all earlier comments remain unchanged. The revision/state metadata records this completion.

The ready-first set remains **T01a, T02, T10, T13, T19, T11, T16, T17 and the two independent T08 corrections**. This is planning approval. Issue creation, implementation and live execution remain separate work and were not performed here.

**I explicitly approve the exact recorded set. The consensus exit checklist is complete.** These three items remain open outside planning consensus:

1. **Levi's D04/D05 inputs:** stamp presets and spending ceiling, plus test cap, duration, publishing input and disposition of funds.
2. **The 0.5 BZZ fill's evidence:** submission remains unverified. No conclusion that it was unsent, settled or safe to retry is supported. The funded review node remains retained and is not disposable.
3. **T05a's later isolated harness run on Engine 29.1.3 and Compose v5.1.4:** the recorded versions do not establish a passing run. The R04 script must not run on the host.

## Handoff prompts

### For OpenAI round 2, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Fable round 1 is complete. Read the repository instructions, then the whole document, then Fable's round under "Comments / Fable round 1", sections 1 to 8, and the updated agreement register.

Write "OpenAI round 2" under Comments, after Fable round 1. Preserve every earlier comment word for word.

Your job:
1. Answer Fable's ten questions in its section 7, each with agree, revise or dispute and the evidence.
2. Settle or narrow the six listed disagreements: R02 priority, R05 priority, R07 diagnosis, R08 weight, T04 size, T05 fix.
3. Re-examine R04 against the local reproduction in Fable's section 3. If you can read the host's Docker and Compose versions read-only over the existing tunnel, record them. Do not deploy, build, pull or change anything on the host.
4. Accept, revise or dispute each task correction in section 5 and each narrowed decision in section 6, including the new D07, D08, D09 and the observation N01.
5. Update only the OpenAI column of the agreement register. Mark a row jointly agreed only where Fable's round states the same position and you now accept it, and say so in your round.
6. End with your remaining disagreements, precise questions for Fable, and a handoff prompt for Fable round 2.

Only edit the shared document. Do not implement fixes, publish issues, change repository settings or operate the live infrastructure. The review-20260907 deployment holds funded assets and is not disposable. Recheck whether the 0.5 BZZ chequebook fill was submitted before saying anything about it.
```

### For OpenAI round 3, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Fable round 2 is complete. Read the repository instructions, the whole document, and Fable round 2 under Comments, sections 1 to 7.

Write "OpenAI round 3" under Comments, after Fable round 2. Preserve every earlier comment word for word. Identify your model and provider.

Your job:
1. Answer Fable's seven questions in its section 7 with agree, revise or dispute and the evidence. The five designs are T01 (persisted operation table and restart rule), T03 (path-pattern contract and pinned pair procedure), T04 (immutable per-build directories with the database row as the active reference, no admission lock), T06 (port reservation table) and T09 (pre-submission record, receipt by hash, nonce and block-scan recovery).
2. For any design you dispute, name the exact interleaving or failure it misses and the smallest test that would show it.
3. Review the consolidated task set in Fable's section 4 and the decision list in section 5. Approve the exact recorded set row by row, or list the rows you change and why.
4. Update only the OpenAI column of the agreement register. Mark a row jointly agreed only where Fable's round 2 states the same position and you now accept it, and say so in your round.
5. End with remaining disagreements, precise questions for Fable, and a handoff prompt for Fable round 3. If no technical disagreement remains, end instead with an explicit approval of the recorded task set and decision list, so Levi can take the decisions.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The review-20260907 deployment holds funded assets and is not disposable. The 0.5 BZZ chequebook fill's submission remains unverified: do not call it unsent, settled or safe to retry without transaction evidence. Do not run the R04 script on the host.
```

### For OpenAI round 4, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Fable round 3 is complete. Read the repository instructions, the whole document, and Fable round 3 under Comments, sections 1 to 6.

Write "OpenAI round 4" under Comments, after Fable round 3. Preserve every earlier comment word for word. Identify your model and provider.

Your job:
1. Answer Fable's four questions in its section 6. Every case you raised in round 3 has a design and a test in Fable's section 2. For each of T01a, T01, T03, T04a, T04b, T05a, T05b, T06 and T09, say approve, revise or dispute. For a dispute, name the exact case it misses and the smallest test that shows it.
2. Confirm or amend the exact task set in Fable's section 3, row by row, and the decision list with the new D10.
3. Update only the OpenAI column of the agreement register. Mark a row jointly agreed only where Fable's round 3 states the same position and you now accept it, and say so in your round.
4. If no technical disagreement remains, end with an explicit approval of the exact recorded set and decision list, so Levi can take D01 through D10. Otherwise end with the remaining disagreements, precise questions, and a handoff prompt for Fable round 4.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The review-20260907 deployment holds funded assets and is not disposable. The 0.5 BZZ chequebook fill's submission remains unverified: do not call it unsent, settled or safe to retry without transaction evidence. Do not run the R04 script on the host.
```

### For OpenAI round 5, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Three things changed since your round 4. Levi decided D01 through D10, all as recommended, on 2026-09-07. They are recorded under "Decisions taken by Levi" below the open-decisions table, with D04 and D05 still needing his numbers. Fable round 4 is complete under Comments, sections 1 to 5. And the host facts are recorded in the evidence section: Docker Engine 29.1.3 on the host and Compose v5.1.4 inside the api container, read by Levi over ssh on 2026-09-07.

Write "OpenAI round 5" under Comments, after Fable round 4. Preserve every earlier comment word for word. Identify your model and provider.

Your job:
1. Answer Fable's four questions in its section 5. For T04a, T05a and T06 say approve, revise or dispute. For a dispute, name the exact case it misses and the smallest test that shows it.
2. Confirm or amend the exact task set in Fable's section 3, row by row. Treat D01 through D10 as decided, not as gates, except that D04 and D05 still wait for numbers.
3. Update only the OpenAI column of the agreement register. Mark a row jointly agreed only where Fable's round 4 states the same position and you now accept it, and say so in your round.
4. If no technical disagreement remains, end with an explicit approval of the exact recorded set and a statement that the consensus exit checklist is complete, naming anything still open (the 0.5 BZZ fill, Levi's numbers for D04 and D05). Otherwise end with the remaining disagreements, precise questions, and a handoff prompt for Fable round 5.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The review-20260907 deployment holds funded assets and is not disposable. The 0.5 BZZ chequebook fill's submission remains unverified: do not call it unsent, settled or safe to retry without transaction evidence. Do not run the R04 script on the host.
```

### For OpenAI round 6, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Fable round 5 is complete under Comments, sections 1 to 5. It adopts both of your round 5 corrections: T04a captures host-owned inputs as one committed revision under a shared advisory lock with a hash manifest written last, and T05a identifies an orphaned attempt's work by container ids absent from a persisted pre-job set, with no clock comparison and a blocked state otherwise.

Write "OpenAI round 6" under Comments, after Fable round 5. Preserve every earlier comment word for word. Identify your model and provider.

Your job:
1. Answer Fable's three questions in its section 5. For T04a and T05a say approve, revise or dispute. For a dispute, name the exact case it misses and the smallest test that shows it.
2. Confirm the exact task set in Fable's section 3, row by row. Treat D01 through D10 as decided, with D04 and D05's inputs still pending.
3. Update only the OpenAI column of the agreement register. Mark a row jointly agreed only where Fable's round 5 states the same position and you now accept it, and say so in your round.
4. If no technical disagreement remains, end with an explicit approval of the exact recorded set and a statement that the consensus exit checklist is complete, naming what stays open outside it: Levi's D04 and D05 inputs, the 0.5 BZZ fill's evidence, and the matching-version harness run that T05a performs later. Otherwise end with the remaining disagreements, precise questions, and a handoff prompt for Fable round 6.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The review-20260907 deployment holds funded assets and is not disposable. The 0.5 BZZ chequebook fill's submission remains unverified: do not call it unsent, settled or safe to retry without transaction evidence. Do not run the R04 script on the host.
```

### For OpenAI round 7, written by Fable, relayed by Levi

```text
You are OpenAI-hosted Codex, continuing the main-v2 review consensus for streaming-infra-manager.

Repository: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager
Shared debate document: /Users/kisslevente/Documents/git/SolarPunk/streaming-infra-manager/.scratch/main-v2-review-consensus/PRD.md
Reviewed baseline: main-v2 at d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64. Run `git rev-parse HEAD` and `git diff --stat d046ebf HEAD` first and record any change.

Fable round 6 is complete under Comments, sections 1 to 5. It adopts your round 6 T05a correction as recorded: a durable creation guard per daemon and Compose project, taken by every deploy attempt with its pre-job container set, checked at every admission for that project regardless of sharedImageTags, released only when the attempt resolves. Fable extended it from legacy attempts to every attempt, because the same-project variant of the race exists without shared tags, and added one assertion to your regression. Fable approves the exact recorded set of 25 rows.

Write "OpenAI round 7" under Comments, after Fable round 6. Preserve every earlier comment word for word. Identify your model and provider. Keep it short.

Your job:
1. Say approve, revise or dispute on T05a as recorded in Fable round 6. For a dispute, name the exact case and the smallest test.
2. If approve, confirm the exact set in Fable's section 3 row by row, update only the OpenAI column of the agreement register, and state that the consensus exit checklist is complete, naming the three items open outside the set: Levi's D04 and D05 inputs, the 0.5 BZZ fill's evidence, and T05a's later harness run on Engine 29.1.3 and Compose v5.1.4.
3. If not, end with the remaining disagreement, the precise question, and a handoff prompt for Fable round 7.

Only edit the shared document. No fixes, issues, repository settings, builds, pulls, deployments or infrastructure changes. The review-20260907 deployment holds funded assets and is not disposable. The 0.5 BZZ chequebook fill's submission remains unverified: do not call it unsent, settled or safe to retry without transaction evidence. Do not run the R04 script on the host.
```
