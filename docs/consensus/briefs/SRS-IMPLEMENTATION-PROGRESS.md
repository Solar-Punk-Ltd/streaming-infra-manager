# SRS continuation implementation

Status: active. Isolated implementation authorized. Shared plan registered after owner-relayed coordination.
Date: 2026-09-21.
Coordinator: OpenAI-hosted Astra. Sol implements admin and uploader. Terra implements the first viewer slice.

## Owner decisions and authorization

- D01: compatible codec, audio layout and ladder required.
- D02: admin PR targets master. Stack and manager PRs target main.
- D03: one combined replay, no list of earlier versions. Previous replay remains available during continuation.
- D04: real streaming tests on 157.90.34.105. Standard verification uses the existing verification box.
- Levi authorized feature branches, implementation, parallel agents and pushed PRs at the end. This does not authorize default-branch merges or replacing live services.
- No further Fable review rounds.

Current proposal: `docs/consensus/SRS-RECONNECT-CONTINUATION-PLAN-v2.md`. Its reviewed bytes are preserved. These owner decisions supersede its pending D03/D04 cells.

## Branches and workers

| Repository / slice | Branch | Worktree | Owner |
| --- | --- | --- | --- |
| Manager and integration | feat/srs-reconnect-continuation | /private/tmp/srs-continuation-20260920-manager | Astra |
| Admin foundation | feat/srs-reconnect-continuation | /private/tmp/srs-continuation-20260920-admin | Sol, continuation_admin |
| Uploader waiting/resume | feat/srs-reconnect-continuation | /private/tmp/srs-continuation-20260920-stack | Sol, continuation_stack |
| Viewer selection | feat/srs-continuation-viewer | /private/tmp/srs-continuation-20260920-viewer | Terra, continuation_viewer |
| Manager lifecycle display | feat/srs-continuation-manager | /private/tmp/srs-continuation-20260920-manager-ui | Sol, continuation_manager_finish, after Terra's first checkpoint |

Baselines checked locally and remotely: manager 87673c99, stack 2c4867ae, admin 48848678. Canonical checkouts unchanged.

## Progress

| Task | Current implementation and evidence | Still required |
| --- | --- | --- |
| R01 | SRS 6.0.191 source/client, busy-publisher and disconnect probes passed for RTMP and SRT, including one transcoded rung. Shared lookup, claim, report and continuation contracts are recorded | Actual format fingerprint and full media integration |
| R02 | Lifecycle schema, closed-state SQL guards, claims, ordered reporting, retained replay and catalogue projection are committed. Full standard and PostgreSQL verification passed at e805886, including 106 database tests. Nine controlled database overlap regressions passed after accde85 | Enrollment integration and later exact-candidate checks |
| R03 | Durable claim attempts, original deadline recovery, source identity and same-uploader reconnect are implemented. a228356 passed 22 focused recovery tests. 3d4f7a5 binds ABR rung callbacks to their original source generation, with 31 focused SRS tests passing | Final R04 integration |
| R04 | 1cac7de restores managed queues and same-run history in fresh uploader objects. c8bb423 retries closure persistence. 5dd6dd8 refuses managed callback acknowledgement on spool failure and preserves the source file, with 46 focused recovery/source/SRS tests passing | Actual format checks, complete finalization, cross-admin-run A+B+C continuation and real process-crash evidence |
| R05 | Owner/internal operation routes and monotonic allocation exist. Nine database races passed. e805886 adds reload reconciliation and clock-independent status aging, with full standard checks passing. 51c2c75 adds slow-response aging, pending-operation polling and revision checks, with 19 focused UI tests passing | Runtime preparation integration and later exact-candidate checks |
| R06 | 8cad6df includes immutable master/rung selection, replay-to-newer-replay switching and replay retention during preparation. Real Chrome focused checks passed 3 cases. The one-line negative fault at f3938d52 produced the intended 2 failures, with 1 unaffected case passing | Full verification-box checks and real decode remain pending |
| R07 | Strict capability capture, bounded private reads and lifecycle UI are integrated through ddf5e0ee. Focused manager checks passed 49 cases and the real Chrome polling regression passed one case | Full manager verification and integration with the uploader runtime endpoint |
| R08 | Release, enrollment and external-guard boundaries are documented | Implementation and incompatible-release refusal proof |
| R09 | Early engine probes and focused source/database tests exist | Complete isolated dev-Bee media harness and executed V01 to V22 inventory |
| R10 | Isolated product branches and verification mapping are published as needed | Reviewed companion PRs, exact stack pin and release packet |
| R11 | Test host access works. Existing disposable Postgres is retained | Separate real OBS/Swarm acceptance and owner-coordinated deployment |

No feature-completion or runtime-acceptance claim is made. Existing live deployments remain unchanged.

Later R06 checkpoint: 05815c23 fixes catalogue type validation, 0871ddb implements captured master/rung replay and run-aware selection, and 0c6c884 extends the mounted-page browser regression. Focused client tests passed 44 cases. Changed-file lint and the fixture module smoke passed. Actual browser RED/GREEN remains pending access to push and dispatch the checks. The viewer worker has moved to the bounded R07 manager display slice in a separate worktree. R04 accepted-media durability is specified in `SRS-ACCEPTED-MEDIA-DURABILITY.md` for the next uploader slice.

## Environment evidence

Read-only SSH succeeded on the owner-selected test host. Docker Engine 29.1.3, host Compose v5.0.0, 64 CPUs, 251 GiB RAM and about 1.9 TiB free. It runs the live manager, viewer, four ABR Bees and one ABR uploader/SRS pair. Etherproxy port 9000 is occupied. None was changed. Test services must use their own names, network, ports and volumes.

Levi relayed that the estate session had committed and cleared coordination. Registered `estate/plans/2026-09-20-srs-reconnect-continuation.md`, added its INDEX row, appended a STATE entry and added the admin Postgres suite mapping. Existing unrelated notes were preserved. `check-plan-registry.mjs` passed.

Levi separately approved publishing the exact test-runner mapping commit 66e0ea0 to verify-jobs main. It adds the admin Postgres suite and the continuation browser suite on the existing browser image. That commit is published. No runner settings, credentials or workflows changed. The browser mapping names the new feature suite, which must exist in the candidate before its deep run.

Early foundation branches were pushed for verification only. PRs are not opened and no product default branch is merged. These are foundation checks, not full feature acceptance.

| Candidate and remote run | Executed result | Unexecuted or remaining checks |
| --- | --- | --- |
| Admin f5166b6, verify-jobs run 35506570335 | Requested and tested commit match. Postgres integration passed 89 tests in 21 suites, zero failures. The ordinary job failed at the baseline root lint script because no workspace package defines lint | Typechecking and unit tests did not start. Automatic review rejected removing the broken command. Levi instead instructed us to configure and fix lint. A real lint setup is now assigned to the admin worker |
| Stack 4b08614, verify-jobs run 35506583842 | Requested and tested commit match. Workspace build passed. Lint failed on import ordering in the new StreamOrchestrator change | Typechecking and tests did not start. Import ordering is corrected in the later uploader checkpoint and awaits the next remote run |

The full admin database output is retained at `.scratch/admin-db-box.log`. It includes the actual legacy SQL refusal against managed closed rows and an unchanged legacy-stream control. Its successful database result does not turn the overall failed run into a pass.

Later checkpoints: uploader 24a67d9 flushes a newly created admission directory's parent before acknowledgement. Uploader 8d6b5fb integrates durable claim, deadline and closed-state recovery, with 16 focused reconnect/recovery tests passing. Uploader ad0d364 adds negotiated admin lookup, bound claims and identical report retry bodies, with 42 focused HTTP-client tests passing. Admin 5dceb36 completes the first claim/report/lookup slice, with seven focused Postgres tests and 51 focused lifecycle unit tests passing. The admin worktree now has its own frozen dependency installation, with no lockfile change.

Viewer 909e4d3 isolates its browser test from the ordinary unit glob and records fixture process diagnostics. Its fixture-module smoke passed after 8284adb moved the fixture into the existing client dependency scope. Remote deep run 35507572850 tested exactly 8284adb and failed at build on a narrowed catalogue-rendition type. Browser checks did not run. That setup failure is not the required behavioral red result.

Levi instructed us to configure and fix the admin's lint command, rather than remove it. Commits c3def14 and e72850a add real typed ESLint checks to all three packages and repair the reported findings. Focused changed-file lint passed. A deliberate unawaited `assert.rejects` failed while ordinary `node:test` declarations passed through a narrow known-safe-call exception. No validation command was removed. Full lint, typechecking and unit checks remain pending the next verification run.

The lint dependency check covered all 45 newly resolved package versions. Every introduced version was registry-signed and older than fourteen days. The installed-tree signature check passed for 501 packages, with 153 attestations. The finalized vulnerability audit contained no introduced package. The malware result for chalk names version 5.6.1, which does not affect the introduced 4.1.2. Several packages, including eslint and @eslint/js, lack provenance attestations despite valid signatures. The admin worker is adding a tracked record naming them. Full local evidence is at `/private/tmp/srs-continuation-lint-evidence/`.

Push attempts for admin e72850a and viewer 05815c23 failed because the 1Password agent did not sign the GitHub key. Read-only test-host inventory failed for the same reason on its own key. Levi has been asked to unlock and approve the prompts. These failures do not change the remote checkpoints or supply new test results. Isolated source work and review continue while access waits.

Levi returned and approved the connection prompts. Admin 16c0b4d is now pushed. Remote run 35519384273 tested exactly that commit. The full Postgres integration suite passed 94 tests in 22 suites, with zero failures or skips. The ordinary job reached the newly configured real lint checks and found 60 errors and one warning in existing backend files. Typechecking and unit tests did not run. Those lint findings are assigned for repair. Full outputs are retained as `.scratch/admin-16c0b4d-db-box.log` and `.scratch/admin-16c0b4d-box-failed.log`.

The task's existing disposable Postgres container is still running. Its local tunnel has been restored. The host inventory was read without changing any live service. Cached SRS 6 and Bee 2.8.2 remain available for the later isolated media harness.

Uploader checkpoints 463e471a, 037c1b35 and a50f767b add managed SRS integration, bounded ABR source progress and preservation of rung uploaders during reconnect grace. Focused SRS/admin-client/storage/config tests passed 140 cases at the first checkpoint. The later ABR grace regression passed 24 cases. Managed raw-media durability and checkpoint finalization remain R04 work. Forced-cutoff fixtures still expose the old finalization reporting path, so these results do not prove complete managed finalization.

The viewer corrections through 58b8d83 are integrated into the stack branch at 7796ac6a. That exact combined checkpoint is pushed. Deep run 35519612886 stopped at build because the new playback-selection predicate did not narrow an optional stream for TypeScript. The viewer's separate pre-fix checkpoint 05815c23 is pushed. Run 35519514969 stopped at browser-harness lint, before the browser ran. Neither result is behavioral browser evidence. The type narrowing is assigned for repair. The next negative control uses the corrected harness and deliberately removes the actual watch page's immutable-replay binding.

Admin f7450f7 fixes the remaining backend lint errors without dropping the lint command or globally weakening its rules. The focused backend lint scope passed and 146 related unit checks passed. That checkpoint is pushed for another full standard and Postgres run. Manager 867dc95a adds strict immutable stack capability parsing in its separate worktree. Its focused source contract checks passed 23 cases. The manager fixture test could not start without its built common package, so that behavior remains for the box build and checks.

Viewer e96e7d2 fixes the TypeScript narrowing and is pushed for deep run 35520266029. Isolated negative-control commit 438a759 is pushed on `test/srs-continuation-browser-negative` for run 35520264386. It removes only the watch page's replay prop and must never be merged. Both runs are pending. Admin run 35520105015 tested f7450f7 exactly. Its database job passed. The ordinary job found nineteen frontend lint errors, primarily existing test mocks and type assertions. They are assigned as a separate lint repair. Typechecking and unit tests did not run.

Both viewer runs subsequently passed build and lint, then stopped on undeclared browser-fixture Window properties during typechecking. Neither reached its browser assertions. The correction is assigned, including the isolated negative-control branch. This remains setup evidence, not the required red/green behavioral proof.

Latest verification on 2026-09-21: admin df5bee7 passed full lint and typechecking in run 35521391377. Its ordinary suite then failed one existing frontend date expectation because it assumed a different timezone. It passed 128 other frontend tests. This is assigned as a deterministic test repair. The database job result is recorded separately, not inferred from the ordinary job. Full output is `.scratch/admin-df5bee7-box-failed.log`.

The database job in 35521391377 also passed. Admin f84ac80 repairs the timezone assumption with 17 focused tests passing. c45cc14 excludes query values from request logs with a sentinel red/green regression. Owner controls at 93cdc47 are pushed. Run 35522092506 passed lint, then stopped at a direct `streams.map(toStream)` call whose second argument became incompatible after the presenter accepted managed state. This is assigned for a narrow call-site repair. No full unit result is claimed for that candidate.

Admin run 35522864856 tested exactly e8058860d6be3e512bd4cd5cc3b86ffd21b54ea8 and passed. Full lint, typechecking, all three package unit suites and PostgreSQL integration executed. Counts were 5 common tests, 137 frontend tests, 282 backend unit tests and 106 database tests. Every executed test passed, with no skips. Complete output is retained in `.scratch/admin-e805886-box.log`. This proves the admin checkpoint, not the still-unfinished cross-repository media flow.

R07 manager commits through a15bfaa1 in the worker worktree are integrated into the root feature branch as ddf5e0ee. The browser regression includes delayed replies, stale active observations, terminal state retention, deployment identity changes, unmount cancellation and admin navigation. Full manager verification is pending.

The delayed-first-rung hypothesis remains unverified. Primary SRS v6 source stops its encoder before the source unpublish callback, but that source branch is not exact-image proof. `srs-protocol-probe.py --late-rung` holds the old rung publish response until after a replacement source publish, then checks whether old-rung media follows. The isolated test has been copied to the approved host, but its execution is waiting for a new 1Password SSH approval. No result is claimed yet.

Viewer runs 35521109692 and 35521107222 stopped at import sorting after the type declaration repair. Neither reached the browser. Sol corrected the fixture declaration boundary and imports in f15945a, with focused e2e and fixture compilation passing. That exact positive candidate is running as 35521764584. The corresponding isolated negative candidate 7f7c9e2 is running as 35521779446. It still removes only the real watch page's immutable replay binding and is never a merge candidate.

Both runs completed with build, lint and typechecking passed. Their ordinary test step stopped before the browser. The deploy suite passed 902 tests, failed four and skipped four. Three failures came from the no-pnpm fixture removing the entire system binary directory when pnpm shared it. The fourth was the unused-export ratchet, which found six new unneeded exports. Both repairs are assigned without weakening the gate. The other completed package results and full failure output remain in `.scratch/viewer-f15945a-box-failed.log`. The negative branch reached the same setup failures, so it still does not prove the intended browser fault.

Controlled database overlap tests passed nine cases after accde85. A request that waited on the stream lock had retained a stale joined-row snapshot. The repair locks the stream first, then reads and locks its current run. Cases include different and identical Continue requests, both orderings of preparation versus cancellation and claim versus cancellation, competing claims, and both orderings of old and new reports. Each asserts one authority and retained replay without deadlock or a server error.

Levi explicitly emphasized asynchronous and concurrent operations. The review requires controlled overlapping transactions and delayed callbacks, not only sequential state-transition tests. The additional overlapping Continue, prepare/cancel, claim/cancel and stale-report checks subsequently passed in the controlled nine-case regression. The allocation repair described below also passed. These results are included in the later full admin verification.

The reviewed allocation repair consumes a run identity even when its preparation fails or is cancelled. A fresh request allocates above all previous identities, under the existing stream lock. Repeating an old request still returns its own terminal operation. Cancelling an already prepared but unclaimed run records a verified empty outcome while preserving its predecessor checkpoint and replay. Claim and cancel must take the same lock so a claimed run cannot be described as empty.

Remote standard run 35507259841 tested exactly uploader d9f3544. Build and lint passed. Typechecking found a test helper inferred as video-only despite its audio case. Unit tests did not run. The helper annotation is repaired in 477e151 and awaits the next remote checkpoint.

## Implementation review findings

Cross-provider review, OpenAI-hosted Astra. These are implementation findings, not a new Fable review round.

| Finding | Priority, likelihood and affected users | Repair and trade-off | State |
| --- | --- | --- | --- |
| Original live viewer cannot join a later run | P1. Normal live-to-ended-to-continuation flow affects viewers because the selection tracks only live/replay kind | Retain the selected run number and offer an explicit switch to a newer run, including when the original selection was live. Preserve playhead until the click. A small selection/browser regression avoids a broken same-page continuation | Repaired in 0871ddb. Focused tests passed. Mounted browser proof pending |
| Archived ABR rungs matched by array order | P1. Normal database and master sort orders can differ and send viewers the wrong rendition | Bind each captured master URI to its exact retained topic. Reject missing, duplicate and unknown mappings. A reversed-array regression costs a small parser change and protects quality/decoding | Repaired in 0871ddb. Focused reversed-order regression passed |
| Managed reports inherit legacy conflict-as-success handling | P1. A plausible response-loss or stale-event race can discard an unaccepted final report | Handle managed conflicts separately and reconcile the exact accepted event and snapshot before clearing the durable outbox. Add a conflicting VOD regression. The small protocol addition avoids false completion | Assigned to uploader and admin |
| Closed report stops retrying during an admin outage | P1. An ordinary outage through cutoff can leave the admin showing an older run state and prevent Continue | Retry the durable report queue independently of the source heartbeat, which ends at closure. A fake-clock outage-and-recovery regression avoids requiring a process restart to report the truth | Assigned to uploader |
| Resumed source inherits the first source's publication callback | P1. Normal reconnect reuses the uploader but its callback captured source A, so published source B can remain Waiting | Bind successful publication to the media's source generation. A same-uploader A-to-B regression proves Waiting returns to Live and a delayed A publication cannot do so | Assigned to uploader |
| Cancelled or failed preparation prevents a later Continue | P1. Ordinary owner cancellation or preparation failure permanently strands that stream's continuation authorization | Retain every operation identity, allocate a new monotonic run for a new request, and prove cancellation against concurrent claims. This adds a small migration and focused database races while preserving the old replay | Assigned to admin |
| Delayed claim reply grants a new sixty-second budget | P1. A plausible lost response followed by recovery can admit input after the original attempt expired | Bind the returned claim to its persisted original deadline. A reply at thirty seconds leaves thirty seconds, and a reply after expiry closes before admission. The small repair avoids granting a fresh window after an outage | Assigned to uploader |
| Delayed ABR rung callback inherits the replacement source identity | P1. A plausible delayed callback during an ordinary reconnect can add old source footage to the replacement recording | Bind the rung's SRS connection to the base generation at admission. A router regression delivers rung A after source B and proves refusal before queue or duplicate-filter mutation. This costs a small connection map and protects cumulative footage | Assigned to uploader |
| Per-segment records duplicate every prior segment | P1. Ordinary long broadcasts with short segments would retain quadratic history and repeatedly parse it on synchronous admission, risking disk exhaustion and blocked ingest | Use bounded per-segment placement records and a recoverable run index/checkpoint. Prove linear retained-byte and read-operation growth with a counted fixture. The localized store repair avoids paying for full histories on every segment | Assigned to uploader before R04 integration |
| First manager display does not honor the frozen wire and freshness contract | P2. Normal polling can show unavailable for valid responses or replace Closed with a delayed Waiting result | Repair the field mapping, per-request ordering and clock-independent observation age. Use the uploader's existing Node runtime for its private loopback read. Focused parser, container and delayed-poll tests cost a bounded UI/service change and avoid misleading operators | Assigned to manager worker |
| Request logging includes private recovery-query identity | P1. Every ordinary recovery query now carries claim identity, while the logger writes the full original URL | Log the path without query parameters and prove sentinel private values are absent. This small middleware regression avoids retaining private identity in logs | Repaired in c45cc14 with focused red/green evidence |
| A viewer already watching replay cannot select the newer combined replay | P1. Normal completion of a continuation exposes a button whose handler refuses every replay-to-replay selection | Allow an explicit switch when the completed run differs, while freezing the current replay until that click. A focused selection and mounted-page regression protects the existing playhead | Assigned to viewer slice owner |
| Admin operation and freshness state only survives a component render | P2. Normal page reload loses the pending operation, and an idle open page can show Live indefinitely after reporting stops | Return the current owner-scoped operation and server-relative age, poll and expire locally, and reject delayed revision regressions. Bounded UI/database tests avoid duplicate intent or misleading controls | Assigned to admin |
| First OBS connection disconnects before producing a segment | P1. Ordinary quick Stop/Start can leave the old provisional candidate reserved and refuse the replacement until cutoff | Clear only the matching provisional connection on unpublish while retaining the original deadline. A publish/unpublish/replacement-media regression costs one bounded admission fix and avoids stranding a valid reconnect | Assigned to uploader |
| Router connection maps disappear when only the uploader restarts | P1. A normal process restart leaves SRS running, so later media arrives without a new publish hook and cannot be trusted through empty in-memory maps | Restore verified connection bindings from durable run evidence before media admission. Test a fresh real router and orchestrator without replaying publish. This adds required startup integration and prevents both dropped valid media and legacy recovery bypass | Required R04 startup integration, not yet verified |

The selected ffprobe runtime, exact registry digest and outstanding dependency evidence are recorded in `docs/testing/srs-continuation/runtime-provenance.md`. No container runtime build or live installation has been claimed.

The focused positive/negative viewer browser evidence is recorded in `docs/testing/srs-continuation/viewer-browser-evidence.md`. Its deliberate fault is isolated and is not part of any product candidate. GitHub and test-host SSH signing later expired. The next branch pushes and the new SRS probe remain pending 1Password approval. Local implementation continues.

The viewer findings are assigned to continuation_viewer and remain open until their focused checks and the browser run prove the repairs. The durable pre-claim journal, report outbox and accepted-media spool are required implementation boundaries, not completed evidence.

The probe artifacts are in `.scratch/srs-probe/probe-1` and `probe-3` in this worktree. Probe 2 failed because the harness used a different inside-container RTMP port from its publisher URL. Probe 3 uses the same dual-listener pattern as the stack entrypoint. This was a harness correction, not a product finding. Test containers and networks are removed by the probe. The separately named test database remains until its focused checks finish.

## Evidence discipline

Small focused red/green tests use the laptop lane. Full checks run on the verification box. Real SRS and media run in isolated services on the authorized host. No live credentials enter artifacts. No deposits, stamp purchases or other money movement are authorized to agents. Price the complete funded test matrix and obtain the owner's transaction execution when that phase is ready.
