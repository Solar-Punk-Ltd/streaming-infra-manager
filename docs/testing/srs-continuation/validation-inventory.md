# SRS continuation validation inventory

Status: active evidence record for R09 of the registered SRS continuation plan.
Date: 2026-09-21.
Reviewer: OpenAI-hosted Astra.

This page separates focused implementation checks from assembled media acceptance. A row is not complete merely because a related unit suite passes. Exact candidate commits, counts and executed commands are recorded in `docs/consensus/briefs/SRS-IMPLEMENTATION-PROGRESS.md` and the linked evidence pages. The approved V01 through V22 requirements remain in the reviewed plan.

| Row | Existing evidence or test surface | Still needed for acceptance |
| --- | --- | --- |
| V01 | Pinned SRS 6.0.191 RTMP/SRT source and one-rung probes passed. Busy refusal and forced client disconnect were observed | Execute the prepared delayed first-rung probe, then repeat against the assembled managed uploader |
| V02 | Real PostgreSQL claim/report tests and nine controlled transaction overlaps passed | Run the final admin candidate, including run-scoped rendition overlaps |
| V03 | `ManagedSourceReconnect` and `SrsManagedLifecycle` exercise deadline boundaries and callback ordering | Final stack candidate verification |
| V04 | Focused reconnect and source-progress tests distinguish media from connection attempts | Actual stalled-input and static-picture controls |
| V05 | Same-uploader reconnect has focused orchestrator coverage | Labeled A/B media, actual audio/video decode and seam seeking |
| V06 | Source-generation and rung callbacks have focused SRS coverage | Complete ladder playback and individual-rung loss in the media arrangement |
| V07 | Ordered admin reports, stale callbacks and source identity have focused coverage | Final candidate managed rendition registry checks and assembled media checks. Production registry and delayed response regressions now exist |
| V08 | Durable store failures, original cutoff recovery and closure retries have focused coverage. The Linux writer test remains unexecuted on macOS | Linux writer competition and actual process kills at the recorded durability boundaries |
| V09 | Cumulative checkpoint seeding and prepared-successor admission have focused coverage, including cancelled intermediate runs | Decode A+B+C across fresh uploader processes and compare old snapshot bytes |
| V10 | Controlled Continue/cancel/claim overlaps and identical report retry bodies have passed | Assembled admin outage and lost-response cases |
| V11 | Viewer snapshot selection and expected-ladder validation have focused coverage | Production ABR report integration and old-rung playback after later runs |
| V12 | Sealed-checkpoint recovery avoids a second finalization in focused tests. The SDK reference-recovery correction at 7a72f4ce passed inline and wrapped-payload checks using the real SDK with fake HTTP | Real Bee failure and process-kill checks |
| V13 | Managed legacy-route refusal, direct ingress checks and credential-log sentinel tests exist | Final candidate API suites and actual direct-rung refusal |
| V14 | Manifest and large-payload readers have existing tests | A cumulative playlist over 4 KiB through both actual viewer gateway read paths |
| V15 | Actual format inspection is wired at 62cede49. Probe-busy retry, canonical fingerprints and displaced-result fencing are repaired through a1e7c79f, with 15 final focused format/probe checks. Admin legacy-adoption transactions passed seven PostgreSQL cases through 7562e4d. Uploader adoption, gap dating and concurrent legacy admission are repaired through 8c8c90c | Assembled adoption and unavailable old-chunk tests |
| V16 | Actual mounted watch-page Chrome test passed 3 cases. An isolated one-line fault produced the intended 2 failures | Real playback during grace and continuation, including a refreshed page and ABR selection |
| V17 | Admin UI and manager lifecycle freshness tests passed focused checks. Manager Chrome regression ran | Final candidate browser suites and assembled two-tab/keyboard checks |
| V18 | No cumulative media decoding claimed | Decode, identify and seek labeled content across every seam and quality |
| V19 | Real old-SQL refusal and focused external release-guard checks exist. Removing the preflight produced the intended failure | Complete supported adapters, isolated installed-wrapper old-image refusals and mixed-version checks |
| V20 | No acceptance run for this feature | Separately coordinated OBS and real Swarm validation. Funded deployments are not disposable fixtures |
| V21 | Verified-empty outcomes, spool refusal and cancelled-ready continuation tests exist | Assembled first-empty, continued-empty and all-upload-failed cases |
| V22 | Managed unpublish/publish preservation and active-run overlap protection passed four real PostgreSQL cases through 13ea24f, including a blocked writer | Final metadata/visibility checks, deployed fixture restart and compatible engine-config rollout preserving closure |

The media fixture design and pinned private-chain image candidates are in `media-harness.md`. The early protocol probes do not establish cumulative playback. The browser selection fixture deliberately substitutes its player, so its result is not video-decoding evidence. The private chain cannot establish real Swarm propagation or funded storage lifetime.

Remote publication and the next host probe currently wait for renewed 1Password approval. No live deployment has been changed by this implementation task. Default branches have not been merged.
