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

Baselines checked locally and remotely: manager 87673c99, stack 2c4867ae, admin 48848678. Canonical checkouts unchanged.

## Progress

- R01 source/client correlation, busy-publisher and disconnect probes passed on SRS 6.0.191 for RTMP and SRT, including source plus a transcoded ABR rung. Wire contract integration remains in progress.
- R02 pure lifecycle invariants committed at 38e9c8c after the red checkpoint 01ac893. Five focused tests passed. Real Postgres regression is running against an isolated test database through a loopback SSH tunnel. Legacy streams remain unenrolled.
- R03 waiting/resume regressions dispatched. SRS activation waits for the verified source signal.
- R06 independent viewer selection regression dispatched. Initial catalogue loading and route changes remain supported.
- Remaining R04/R05/R07/R08/R09/R10/R11 are pending those foundations. No claim of feature completion or runtime acceptance.

## Environment evidence

Read-only SSH succeeded on the owner-selected test host. Docker Engine 29.1.3, host Compose v5.0.0, 64 CPUs, 251 GiB RAM and about 1.9 TiB free. It runs the live manager, viewer, four ABR Bees and one ABR uploader/SRS pair. Etherproxy port 9000 is occupied. None was changed. Test services must use their own names, network, ports and volumes.

Levi relayed that the estate session had committed and cleared coordination. Registered `estate/plans/2026-09-20-srs-reconnect-continuation.md`, added its INDEX row, appended a STATE entry and added the admin Postgres suite mapping. Existing unrelated notes were preserved. `check-plan-registry.mjs` passed. Copied only the suite mapping to the clean verify-jobs checkout. That distribution copy remains uncommitted and unpublished, so remote database coverage is not claimed yet.

The probe artifacts are in `.scratch/srs-probe/probe-1` and `probe-3` in this worktree. Probe 2 failed because the harness used a different inside-container RTMP port from its publisher URL. Probe 3 uses the same dual-listener pattern as the stack entrypoint. This was a harness correction, not a product finding. Test containers and networks are removed by the probe. The separately named test database remains until its focused checks finish.

## Evidence discipline

Small focused red/green tests use the laptop lane. Full checks run on the verification box. Real SRS and media run in isolated services on the authorized host. No live credentials enter artifacts. No deposits, stamp purchases or other money movement are authorized to agents. Price the complete funded test matrix and obtain the owner's transaction execution when that phase is ready.
