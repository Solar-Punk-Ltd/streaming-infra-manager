# SRS continuation implementation

Status: active. Isolated implementation authorized. Shared plan registered after owner-relayed coordination.
Date: 2026-09-20.
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
| Manager lifecycle display | feat/srs-continuation-manager | /private/tmp/srs-continuation-20260920-manager-ui | Terra, continuation_viewer, next bounded slice |

Baselines checked locally and remotely: manager 87673c99, stack 2c4867ae, admin 48848678. Canonical checkouts unchanged.

## Progress

- R01 source/client correlation, busy-publisher and disconnect probes passed on SRS 6.0.191 for RTMP and SRT, including source plus a transcoded ABR rung. Wire contract integration remains in progress.
- R02 pure lifecycle invariants committed at 38e9c8c after the red checkpoint 01ac893. Five focused tests passed. Real Postgres red proved the missing lifecycle columns while its legacy control passed. Schema and recording invariants landed at c08d452, schema compatibility at 56d3a1c, and nullable-identity review repairs at f5166b6. Claims, reporting routes and Continue operations are next. Legacy streams remain unenrolled.
- R03 in-memory waiting/resume foundation landed at 93f7121 after red checkpoint 87c26f3e. Seven focused tests passed. The shared audio timestamp parser prerequisite landed at 4b08614 with 17 parser tests passing. Advancing video/audio timestamps landed at f013234 with ten focused tests passing. Durable admission storage landed at d9f3544 with six focused store tests passing. Startup recovery, SRS integration and durable pending media remain in progress. Metadata durability alone does not preserve queued footage.
- R06 initial playback-selection fix landed at f750fbc4 with five focused tests and a deliberate helper fault detected. Managed catalogue parsing, playback selection and the first mounted-page browser harness landed at 866c5b7. Focused catalogue/selection tests passed 39 cases. Browser setup corrections and immutable replay wiring are still in progress. No browser acceptance result is claimed yet.
- Remaining R04/R05/R07/R08/R09/R10/R11 are pending those foundations. No claim of feature completion or runtime acceptance.

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

The viewer findings are assigned to continuation_viewer and remain open until their focused checks and the browser run prove the repairs. The durable pre-claim journal, report outbox and accepted-media spool are required implementation boundaries, not completed evidence.

The probe artifacts are in `.scratch/srs-probe/probe-1` and `probe-3` in this worktree. Probe 2 failed because the harness used a different inside-container RTMP port from its publisher URL. Probe 3 uses the same dual-listener pattern as the stack entrypoint. This was a harness correction, not a product finding. Test containers and networks are removed by the probe. The separately named test database remains until its focused checks finish.

## Evidence discipline

Small focused red/green tests use the laptop lane. Full checks run on the verification box. Real SRS and media run in isolated services on the authorized host. No live credentials enter artifacts. No deposits, stamp purchases or other money movement are authorized to agents. Price the complete funded test matrix and obtain the owner's transaction execution when that phase is ready.
