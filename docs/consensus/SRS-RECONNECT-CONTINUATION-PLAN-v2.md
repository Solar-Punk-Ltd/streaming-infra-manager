# SRS reconnect and explicit continuation

Status: proposed. Corrected after Fable's second review. D03 and D04 await Levi. Implementation has not started.
Date: 2026-09-20.
Author: OpenAI-hosted Codex, GPT-6 Astra. Cross-provider review, OpenAI-hosted.
Owner: Levi decides product policies and release. Astra owns the contract and review. Implementation workers follow bounded task briefs.
Activation: register the approved plan in `estate/plans/` and `estate/plans/INDEX.md` before treating it as an active brief. Estate registration and shared verification configuration are not authorized by this repository-only planning assignment.

Revision: v2 supersedes `SRS-RECONNECT-CONTINUATION-PLAN.md` as the current proposal. The reviewed v1 remains unchanged. Levi requested corrections without another review round. This is Astra's corrected proposal, not a claim that Fable approved these new bytes. Section 13 records the disposition of every finding.

## 1. Outcome and scope

A declared stream keeps its ID, OBS publishing address and watch page. SRS tolerates a source interruption for 60 seconds. If usable input returns in time, the recording continues automatically. Otherwise publishing closes and the recording becomes VOD after finalization succeeds. OBS cannot start another run for that ID until its owner explicitly selects **Continue stream** in the admin app.

Continue preserves the previous replay. Once new video arrives, the same watch page offers the resumed stream. Its next VOD contains the earlier footage followed by the new footage. Completed playlist entries remain completed and unchanged. Continuation writes later entries on the same feeds and reuses existing segment references rather than rewriting old video. A run number identifies the new broadcast period. It is not a feed index.

This is the design Levi accepted on 2026-09-20. It replaces the earlier first-batch proposal that would automatically create another recording after expiry. `BROADCAST-LIFECYCLE-PLAN.md` is retained as a held historical proposal, not an implementation brief. OME, an arbitrary Pause mode, generated intermission video, remote control of OBS, automatic cross-host failover and a permanent End action are outside this selected SRS batch. They are not declared unwanted or removed from future consideration.

Scope includes admin-declared SRS streams, single rendition and the supported ABR arrangements, RTMP and SRT, uploader persistence, admin controls, the supported viewer and manager integration. Existing standalone and OME behavior receives regression coverage. It is not silently opted into an admin-only Continue workflow.

No code, tests, host operations, transactions, commits, pushes or PRs were performed while writing this plan. The next action after decisions and activation is implementation in feature branches. PR creation and merge follow the resulting assignment and repository rules. Deployment remains a separate coordinated action.

## 2. Baseline and existing behavior

Source read on 2026-09-20. These are source observations, not fresh live-host evidence.

| Repository | Verified baseline | Default branch | Responsibility |
| --- | --- | --- | --- |
| `Solar-Punk-Ltd/streaming-monorepo` | `488486786a821dad76c2a2b16f812e3943572701` | `master` | Stream declarations, ownership, catalogue and Continue control |
| `Solar-Punk-Ltd/swarm-hls-stream` | `2c4867aee359928263155c50d82c13e6b1362f4b`, `v3.1` | `main` | SRS, uploader, manifests and bundled viewer |
| `Solar-Punk-Ltd/streaming-infra-manager` | `87673c99ecbf3685fc04773d95877d128b909113` | `main` | Deployment configuration, observed status and the verified stack pin |

The local manager pins the stack baseline above. Remote default heads matched these commits when read. Repository truth verification passed for the manager. Recheck heads, instructions and any `STATE.md` at implementation start. A branch moving invalidates a claim about its old head, not the recorded baseline evidence.

| Source | Observed behavior and implication |
| --- | --- |
| Admin `web2-admin/backend/src/domain/streamState.ts` | Explicitly allows `vod → live`. This must stop for streams enrolled in the new contract |
| Admin `StreamStateService.lookupByIngest` | Rejects draft and publishing rows, but returns VOD rows. A valid key currently resolves after completion |
| Admin `StreamRepository.markLive` | Clears completed-recording fields and rung completion when returning from VOD. It does not preserve cumulative recording history |
| Admin `LadderService`, `StreamRenditionRepository`, `PublishService` | Merge and publish current rungs. Reports and final indexes need a run identity so old messages cannot affect a later run |
| Stack `packages/stream-uploader/src/engines/adminGate.ts` | Checks declaration, key, owner and media type. It does not enforce a closed VOD permission |
| Stack `engines/srs.ts:447-502`, `libs/StreamOrchestrator.ts:394-484` | Single-stream and rung unpublishes call stop. Re-announcing a tracked stream can retire and finalize its uploader. Only the crash-recovery branch resumes it, bypassing takeover judgment. Managed reconnect needs its own waiting/resume path |
| SRS 6 `SrsRtmpConn::publishing` and stack `SrsStreamPayload` | The upstream RTMP publish hook runs before source acquisition. A busy refusal then produces no unpublish. The current uploader does not parse callback `client_id`. Hook acceptance cannot be treated as proof that a replacement source acquired the stream |
| Admin `Database.ts:30-64` | The migration runner ignores applied migrations unknown to its binary. An old image can boot against a newer schema. New-image boot checks alone cannot protect rollback to that old image |
| Stack `libs/StreamUploader.ts`, `libs/ManifestManager.ts` | Finalization publishes a closing live playlist and a VOD. Recovery state is cleared after completion. Preserve a distinct continuation checkpoint before that cleanup |
| Stack client `ManifestManagement.ts:111`, `LadderFeedPoller.ts` | Finalized playlists stop accepting updates or polling. Removing `ENDLIST` will not resume existing viewers |
| Stack client `SwarmHlsPlayer.tsx:154-160,548`, `StreamWatcher.tsx:45-72` | The player effect depends on rendition topics passed directly from the polled catalogue. Changing those topics can remount a replay viewer without consent. Freeze the selected playback inputs at the watch-page boundary |
| Stack client `FeedStateOverlay.tsx` | Already has waiting, reconnecting and ended messages. The initial batch can reuse them |
| Manager `manager/src/api/routes/actions.ts`, `engine.ts` | Deployment Stop is an infrastructure action. Engine overview currently reports `live: null`. Neither is a broadcast permission control |

Admin `docs/infra-state.md` identifies the public viewer as the stack's bundled client on a manager deployment. That answers repository ownership from documentation. R01 still records the configured viewer build for the eventual test. No live configuration was checked during this revision.

The admin's stored initial status is `published`, represented in the public catalogue as `scheduled`. This plan uses **Open** as operator-facing wording. Do not rename existing database statuses merely to match that wording.

## 3. User scenarios

The 60-second rule concerns the source input, not a viewer's connection to a gateway. There is no replacement video during an outage. Buffered footage may continue before a viewer starts waiting.

| ID | Scenario | Operator flow and state | SRS and uploader | Manifest and recording | Viewer experience |
| --- | --- | --- | --- | --- | --- |
| S01 | First start | Publish placeholder, then Start in OBS. Open becomes Live after media is published | Validate ID, key, assignment and permission, then admit one source | First live playlist grows | Waiting, then live video at the same watch page |
| S02 | Network returns inside 60 seconds | No admin action. Live shows Reconnecting during loss | Re-admit the authorized source into the same run before the deadline | No `ENDLIST` during grace. Correct discontinuity and numbering at return | Buffered footage, waiting indicator, automatic recovery |
| S03 | Stop OBS, then Start inside 60 seconds | Same as S02 | Intentional Stop is indistinguishable from source loss for this policy | Same recording | Same short interruption and recovery |
| S04 | Stop or outage reaches 60 seconds | Finishing, then VOD only after successful finalization | Persist closed admission at the deadline. Reject fresh publishing and new input for that run. Drain already accepted work | Close live media playlists, save cumulative VOD and continuation checkpoint | Remaining buffered footage, then ended or replay |
| S05 | OBS returns after 70 seconds | Remains VOD or Finishing. Owner must choose Continue | Refuse publication for the closed run, including automatic retries | No new recording or overwritten old playlist | Ended or replay |
| S06 | Owner chooses Continue | Preparing continuation, then Open for continuation. OBS may retry later or need Start Streaming | Prepare a new run and reopen only after required state is ready | Keep previous VOD pinned and playable. No empty new playlist is advertised | Existing replay remains available |
| S07 | New video after Continue | Live. Same stream ID and publishing address | Accept one current source into the new run | Later entries on the same feeds, prior snapshots retained, new footage appended with a marked break | Existing replay viewers get “Stream resumed · Watch live”. A new visitor opens current live playback and can select the last completed replay |
| S08 | Continued run ends | Same 60-second process, then VOD | Close this run and reject further connections | New cumulative replay contains A then B. Old snapshot A remains unchanged | One current replay containing both portions |
| S09 | Continue is armed but nobody returns | Remains Open for continuation. Owner can cancel reopening | No incoming video means no Live state or new VOD. Cancel closes the unclaimed permission | Previous VOD stays intact | Previous replay remains available |
| S10 | Repeated Stop/Start and multiple continuations | Each genuine recovery follows the same rules | Empty connection attempts do not renew grace. Every expired run needs its own explicit Continue | A, then A+B, then A+B+C, without duplicates | Stable watch page and predictable replay choices |
| S11 | Only one ABR rendition fails | Show rendition trouble, not a whole-stream end | Source owns the reconnect window. Healthy rungs continue | No premature group VOD. Group finalization accounts for the expected ladder | Healthy quality can remain playable |
| S12 | Finalization or continuation preparation fails | Show failure and recovery action. Continue stays unavailable until safe | Closed means closed even when the admin or Bee is unavailable | Preserve accepted work, previous VOD and pending checkpoint | Last verified replay remains available where present. Do not promise a newer ready VOD |
| S13 | OBS connects but the first run never produces media | Closed, no recording. Allow explicit retry of the same declared stream after the empty outcome is verified | Empty attempts still time out and do not bypass permission | Do not fabricate a VOD. A verified empty run permits Continue with empty history | No recording available, then waiting only after the owner reopens |

Cancel reopening is not a new Stop-live action. It can cancel only an unclaimed continuation. If OBS has already claimed it, return a conflict and show the current state rather than pretending to stop it.

## 4. Contract and enforcement

### 4.1 Keep four identities distinct

| Identity | Lifetime and use |
| --- | --- |
| Stream ID and declared ingest topic | Stable admin record, OBS address and watch route |
| Run number | Incremented once per explicit continuation. Does not change for an in-grace reconnect |
| Source connection identity | SRS server and client identity, with uploader session generation. Changes across reconnects and correlates late callbacks |
| Playback selection | Stable declared feed and derived rung topics. A live selection follows the current run. A replay selection pins exact final entries for the master and every rung. Finished entries never change |

The stream remains owned and authorized by the admin backend. Its durable run record controls which uploader may claim a ready run. The assigned uploader owns source timing, the effective local cutoff and media writes. These are separate responsibilities, not two competing authorities over the same field.

Add a lifecycle contract version and a compare-and-set revision to the admin record. Persist a run record with its state, assigned uploader identity, permission, reconnect deadline, last accepted event sequence and last verified recording reference. Snapshot rendition completion by run, not just by stream and rung name. Persist the current local run and closure under the uploader's existing durable volume before acknowledging an admission or closure.

The existing recovery store uses temporary-file write and rename without fsync. Do not describe that as power-loss durability. For the new admission record and continuation checkpoint, flush the temporary file, atomically rename it and flush the parent directory before acknowledging persistence. State the supported filesystem assumptions. Fault injection proves ordering and process-crash recovery, not a physical power-loss test. If durability or ownership cannot be established, refuse new admission until reconciled.

Each media writer is exclusive. A second process using the same state directory must refuse. An admin claim cannot be taken by another uploader while the existing assignment is unresolved. A missing or corrupt local record does not mean an unclaimed fresh stream. It requires reconciliation against the admin record and checkpoint. No automatic reassignment during an admin outage. Independently cloned signer/state volumes are not magically fenced by a local lock. Moving an assignment requires the old writer to be confirmed stopped.

### 4.2 Admit, recover and close

1. Initial publish lookup validates existing credentials, media type and signer ownership, then the managed lifecycle capability and run permission. Atomically claim the authorized run for the assigned uploader. Persist local ownership before accepting SRS publishing. An initial claim with no media has a bounded 60-second wait too. Empty attempts cannot reset it.
2. Parse and correlate SRS `server_id` and `client_id`, qualified by local source generation. Treat an allowed publish callback as a provisional candidate, not proof that SRS acquired the source. Keep the incumbent uploader and source identity intact until acquisition or media from the candidate is verified. R01 proves that signal on the pinned image for RTMP and SRT. If acquisition cannot be verified while an incumbent remains attached, refuse the overlapping attempt and let OBS retry after release. Preserve the existing authenticated takeover judgment. A same-key callback alone never retires a managed run.
3. A current source's unpublish puts its existing uploader into waiting rather than calling stop or finalizing it. ABR rung unpublishes caused by that loss retain their uploaders too. Arm one source deadline. Source-media inactivity supplies a deadline for a silent socket. Use the earlier applicable deadline so delayed callbacks cannot extend an outage. Measure SRS detection delay. Do not count old upload completions, an isolated failed rendition, or a viewer gateway failure as new source input.
4. Before the deadline, a valid reconnect resumes the waiting uploader with its manifest history intact. Reinitialize connection-specific duplicate filtering, accounting and timestamp anchoring only when the replacement is verified, preserving accepted work and takeover checks. Only usable advancing source media cancels the original deadline. A candidate SRS refuses as busy, with no subsequent unpublish, changes no incumbent ownership, counters, history or timer. Static pictures with advancing video timestamps still count as media. Direct rung publication cannot manufacture source authorization.
5. At `now >= deadline`, serialize closure against admission and media acceptance. Persist closed before draining or sending reports. A connection admitted just before expiry but still producing no usable input is closed too. Callbacks from previous source generations cannot affect the replacement.
6. Refuse new `on_publish` requests through the existing SRS callback response. Also reject stale segment delivery at the uploader. If a stale source connection remains attached, disconnect it using a capability proven for the pinned SRS image and protocol. Refusing an RTMP connection alone is not proof for SRT.
7. Finish accepted work, publish the closing manifests and cumulative recording, persist its checkpoint and report the matching run as VOD. Never use a failed or timed-out finalization as permission to reopen.

Use a monotonic deadline while the process is running. Persist enough wall-clock and progress information to reconstruct the remaining window after restart. Never restart a fresh 60 seconds. If time or ownership cannot be reconciled reliably, close admission and expose recovery required. Test exact boundary semantics with a fake clock. Actual network detection and playback latency are observations, not a promise of exact wall-clock cutoff from the viewer's perspective.

Known boundary limit: a connection established just before 60 seconds may miss the deadline if its first usable media arrives afterward. Keep the strict media deadline in this batch. Segment duration and keyframe timing affect that margin, so V05 records it without adding an extra renewable grace period. `HLS_SEGMENT_MAX` defaults to 2.5 seconds in the stack but is configurable, not a universal delivery guarantee.

Fable cites upstream SRS defaults of 5 seconds for RTMP publisher inactivity, 20 seconds for its first packet and 10 seconds for SRT peer inactivity. These are documentary starting points for V01, not measurements of the pinned image or proof of which deadline wins. The documented client-delete API likewise needs an actual SRT capability check.

`RECOVERY_TIMEOUT` already governs crash recovery and `ORPHAN_REAP_MS` already governs abandonment. Introduce a specifically named source reconnect policy rather than blindly changing either default. For this release its selected value is 60 seconds. The old timers must defer to the managed run's deadline and cannot end it early or reopen it later.

### 4.3 Continue and delayed reports

Continue is an authenticated owner action in the admin app. It requires the previous run to have closed, a verified final recording/checkpoint or a durable verified-empty outcome, and no unresolved writer or finalization operation. An empty outcome means no media was accepted, not that accepted media failed to upload. Preparation is idempotent and remains closed until complete. It may return an accepted operation while preparation runs. Retrying the same request after a timeout must recover that operation, not allocate another run.

Preparation verifies the retained manifest metadata, supported encoding contract, expected rung list and writer assignment. It allocates the next run once, retains the existing topics and records the exact prior snapshot it will extend. It also reconciles the next writable index on each feed. Those indices need not match each other or the run number. The uploader acknowledges readiness for that exact next run before the admin presents Open for continuation. Persist the pending request and acknowledgement so a crash between the two can be reconciled. Use the existing control path with a small durable operation record. No new message broker or general-purpose workflow service is required.

Once open, the next valid OBS retry is allowed to start. OBS may delay its retries or stop retrying, so do not promise an immediate start. Keep the existing publishing address and key unless the owner separately rotates the key. Display: “OBS may reconnect on its own. If it has stopped retrying, press Start Streaming.” Cancelling an unclaimed reopening competes atomically with admission, so one wins and the other receives the current state.

Every lifecycle and rendition report carries stream ID, run number and an event sequence scoped to that run. Reject old-run reports. Deduplicate the same event. Reject conflicting or backward events within a run. A delayed `live` must not undo closing, and a delayed VOD from run 1 must not close run 2. All catalogue writes build from the latest committed row and matching run snapshot under the existing writer serialization. Store a durable pending catalogue update so a failed feed write remains retryable after process restart.

Do not interpret any HTTP 409 as generic success. The uploader's present `already-settled` handling must distinguish an exact duplicate of the recorded transition from `stale_run`, a state conflict and an assignment mismatch.

Add informational `waiting` reports carrying the confirmed deadline and `closed` reports carrying the reason, alongside `live` and `vod`. Include run number, event sequence and observation time. Deliver them through a small durable retry record without delaying local cutoff. They describe observed state and never grant publishing permission. Late waiting after closed is a `stale_event` conflict. Define observation freshness and refresh in R01 so a lost report does not leave an indefinitely trusted Live label. When fresh evidence is unavailable, show the last observation as stale, without inventing a countdown.

### 4.4 API shape to freeze in R01

Retain the repositories' existing `/api` prefixes, authentication and flat error envelope. The paths below are new proposed routes, not existing APIs. R01 records the final wire fixtures used on both sides.

| Surface | Proposed change | Semantics |
| --- | --- | --- |
| `POST /api/streams/:id/continuations` | Owner session, existing cross-site protection, request ID and expected revision | 202 with operation location while preparing. Repeating the same request returns the same operation. 409 for finishing, changed revision or incompatible run |
| Continuation operation read and cancel | Owner-scoped operation resource | Reports pending, ready or failed. Cancel succeeds only before claim. Preserve the previous replay |
| Internal ingest lookup and run claim | Versioned lifecycle fields plus an atomic claim operation | Lookup alone never grants publication. Unknown, closed or unresolved runs are refused without leaking another owner's record |
| Internal lifecycle and rendition reports | Add run, event sequence, observation time and final recording/checkpoint references. Include `waiting` with deadline and `closed` with reason beside `live` and `vod` | Exact duplicate is distinguishable from stale-run or stale-event conflict. Reports do not grant permission. Old contracts cannot mutate enrolled runs |
| Uploader prepare/status control | Authenticated existing manager/uploader route, targeted assignment and run | Persist preparation before reporting acceptance. Read proves readiness, not merely that a request was sent |
| Public catalogue and watch-page data | Keep declared and rung topics. Add run number and retain the exact last completed snapshot, including all final rung references | Live resolves the current run's feed heads. Replay resolves pinned entries. Public data contains no key, internal token, host endpoint or writer-control capability |

Additive legacy routes remain usable for streams not enrolled in this contract. Managed streams require the capability on every mutation path, including generic start/segment routes and legacy state reports. An older uploader must fail closed for those streams rather than silently use the former VOD-to-Live rule.

Metadata edits, Republish, unpublish followed by publish, deployment restart and engine configuration rollout must not clear a managed stream's closed permission or retained history. Only the explicit continuation transition reopens that same stream. Existing owner-authorized deletion policy is unchanged, and this feature adds no automatic deletion.

## 5. Recording and viewer design

### 5.1 Preserve and extend media

Keep a durable continuation checkpoint separate from disposable crash-recovery state. It names the exact immutable final manifests, complete ordered segment references, source timeline boundaries, discontinuities, encoding metadata, expected rungs and cumulative durations. It must be durable before normal recovery cleanup and must not depend on reading an eventually consistent feed head.

At continuation, seed recording history from that checkpoint and write later entries on the same declared and derived rung feeds. Do not overwrite a completed entry or remove its end marker. Drain and reconcile all predecessor writes before handing these feeds to the next run. A late old-run task cannot advance the head after that handoff. Old media is referenced, not uploaded again. The live window contains the current run's live edge. Historical references are used for the cumulative replay and do not make a newly joined live viewer start at the beginning of the old recording.

At the join, maintain unique segment identities and valid media sequences. Mark timestamp resets with discontinuities. Use one source timeline mapping across ABR rungs, including missing-rung intervals. Preserve prior wall-clock timestamps. The recommended replay omits time when no media existed, while retaining the interruption times as metadata. A gap that already existed inside accepted footage is not silently deleted to make a test pass.

Validate the encoding contract against the actual opening media before publishing a continuation, not only the saved SRS or OBS configuration. A configuration can change after preparation. Persist the original codec, track layout and ladder facts from actual media. An incompatible opening must not overwrite the previous replay or count as usable recovery progress. R01 specifies this fingerprint and the supported compatible variations under D01.

Freeze the expected ladder at the start of the run. Never call an ABR recording complete just because every rung that happened to report has finished. Distinguish an explicitly failed or missing expected rung from a complete ladder. Retain available media and report an incomplete recording when finalization cannot be completed.

An ABR snapshot must pin each rung's exact final feed index or immutable manifest reference. Pinning only the master while its children still resolve at latest is insufficient. Stable topics do not remove this requirement. Test reading the old replay after multiple new runs, including opening it in a new tab during a continuation. Use the existing large-payload indexed-read path for recordings exceeding one Swarm chunk. Also verify the viewer's feed-head path through the gateway with the same large payload. A tiny playlist or an uploader-only indexed read does not establish cumulative replay support.

The prior snapshot is retained throughout preparation and live continuation. On successful new finalization, atomically make the cumulative snapshot current. Recovery after a crash at any intermediate point must find either the old verified snapshot or the verified new one, never a half-updated mixture. Retry metadata publication without reuploading already recorded segments or producing duplicate final entries.

No new automatic deletion or media retention policy is introduced. Continuing does not renew the storage lifetime of old chunks. Verify checkpoint readability and storage preconditions, and report missing old content as a continuation failure rather than silently producing a truncated recording. Existing recording migration can adopt only the complete verified snapshot that exists. It cannot invent earlier sessions that the old catalogue no longer identifies.

### 5.2 Stable feeds, explicit playback selection

Keep the declared topic as stream identity, watch-route identity and playback feed. Keep its derived rung topics too. A continuation appends new live entries above the old final recording. Preserve existing HLS payload types. Do not replace a legacy manifest feed with a JSON status document. Record a run number independently of feed indices so a player can distinguish a resumed broadcast even if catalogue polling skipped an intermediate state.

The current catalogue entry retains the last completed recording snapshot while the next run is being prepared or live. Replay resolution uses its exact final master and rung references, never their changing heads. A refreshed page or a new visitor can still select that replay while the next run is live. Once finalization succeeds, the newest cumulative snapshot becomes the default replay. D03 decides only whether the page also lists earlier completed versions. It does not remove preservation, snapshot metadata or access to the previous replay during continuation.

Advertise a new run as Live only after usable media has been published. A viewer already playing a replay is offered **Stream resumed · Watch live** when a newer live run is observed. At the watch-page boundary, freeze the selected run, master reference and full rendition inputs for that player session. Metadata and catalogue polls update surrounding UI, not those playback inputs. Clicking Watch live explicitly selects the new run and mounts a fresh player at its live edge. Test a catalogue rerender at this boundary, including changed rendition topics and indexes, and prove no destruction or seek before the click. Then prove the explicit click does switch playback. A direct player prop change may still intentionally remount it.

Within the 60-second window, the active player keeps waiting and resumes without this prompt because its playlist never ended. Once ended, replay playback is terminal for that snapshot. A newer revision is discovered by the enclosing watch page, not by hoping an ended HLS poller resumes itself.

Implement this in the bundled stack viewer, identified by the admin's infrastructure documentation. R01 records its configured version for testing. Stable feeds reduce changes to topic allocation but do not make an old viewer understand pinned replay selection or the explicit Watch live action. Keep reader-first enrollment until those behaviors are present. No promise that a third-party HLS player follows catalogue revisions automatically. Existing immutable VODs remain playable.

## 6. Admin and manager UI

Use existing Open, Live and VOD concepts. Keep media status separate from publishing permission and pending work.

- Open: first stream is ready for OBS.
- Live: usable published media exists for the current run.
- Reconnecting: show the remaining source grace interval from a fresh uploader observation or its accepted waiting report. Never infer a deadline from the container state or the time a poll returned.
- Finishing: publication is already closed, but the new replay is not ready yet.
- VOD: finalization succeeded. Show Continue stream and the completed replay.
- Preparing continuation: show the operation and preserve replay access. A request timeout leads to operation reconciliation.
- Open for continuation: “OBS may reconnect on its own. If it has stopped retrying, press Start Streaming.” Offer Cancel reopening until claimed.
- Failed or status unavailable: show the actual failure or missing observation. Do not turn it into Live, VOD-ready or safe-to-retry.

Continue belongs in `streaming-monorepo`. The infra manager shows observed state, the selected 60-second policy and a link to the owning admin stream. It reads a deadline from the uploader's authenticated status response. The admin uses the run-scoped reports in section 4.3. Both label stale observations as unavailable. The manager must not duplicate the admin's ownership or invent an independent permission flag. Deployment Start and Stop retain their infrastructure meaning. A running container is not proof of live video. Planned infrastructure Stop still warns about active streams and is not sold as the normal way to finish a broadcast.

Use existing controls and components. No new dashboard, OBS connector or encoded spinner is needed. Keyboard access, disabled reasons and progress/error announcements are acceptance requirements for the few controls added.

## 7. Tasks and acceptance

Sizes are relative implementation complexity, not promises of elapsed time. S is one focused change. M crosses a few related modules. L crosses lifecycle boundaries and must be split into logical commits. P1 means a release blocker for this feature. P2 means useful work that can be explicitly accepted as a limitation if it does not fit. Each task writes a failing regression before implementing its behavior.

| Task | Repo and owner role | Priority, likelihood and affected users | Size / depends on | Deliverable and acceptance |
| --- | --- | --- | --- | --- |
| R01 | All three, Astra contract and review | P1. Normal use crosses all three contracts, so incompatible assumptions affect every stream | M / activation, D04 for real probe | Freeze wire fixtures, stable topic/run/index identities, report freshness and the documented bundled viewer integration. Complete V01 on the exact SRS image, including hook-before-acquisition, busy refusal without unpublish, client correlation and SRT disconnect enforcement. Record the section 9 environment before dependent media work |
| R02 | Admin, implementation worker | P1. Ordinary reconnects currently reopen VOD and delayed reports can affect later runs | L / R01 | Add run permission, assignment, event ordering, retained master/rung snapshots and waiting/closed reports. Forward database constraints reject legacy mutations of managed closed state or retained history. New binaries reject unsupported schema versions. V02, V07, V08, V10, V12, V19 |
| R03 | Stack uploader, implementation worker | P1. Every normal Stop or network loss needs the deadline, and mistakes can lose recording data | L / R01, R02 contract | Explicit waiting/resume keeps the same uploader and history. Provisional publish callbacks cannot retire it. Preserve takeover authentication, correlate clients, persist the original deadline and defer recovery/reaper timers. Enforce cutoff on every input path and distinguish exact duplicate from stale-run reports. Single and ABR input behave consistently. V03 through V08, V10, V13 |
| R04 | Stack and admin, bounded workers with one contract | P1. Continuing without complete history or an exclusive writer can lose footage | L / R02, R03 | Durable continuation checkpoints, idempotent next-run allocation on stable feeds, drained predecessor writes, cumulative VOD and pinned master/rung snapshots. Validate actual opening media under D01 before manifest publication. Snapshot preservation is required under either D03 choice. V09 through V12, V14, V15, V21 |
| R05 | Admin backend and console, implementation worker | P1. Continue is a publishing authorization and must not happen twice or for another owner | M / R02, R04 | Continue, operation reconciliation, cancel-before-claim and truthful reported status. Preserve old replay and explain OBS retry behavior. V07, V08, V10, V16, V17 |
| R06 | Stack viewer, implementation worker | P1. Finished players otherwise never show the resumed stream, or silently replay the wrong footage | M / R01, R04, D03 for history UI | Freeze player selection across catalogue refreshes. Keep the stable route, explicit Watch live choice and indexed replay, including every ABR rung. Implement the history presentation Levi chooses in D03. V09, V11, V14, V16, V18 |
| R07 | Manager, implementation worker | P2. Operators would otherwise confuse deployment state with stream state | M / R01, R03, R05 | Read-only lifecycle display, admin link and clear deployment controls. Expose policy only on capable SRS stacks. V16, V17, V19. Stack pin is R10, not a premature part of this task |
| R08 | Admin, stack and manager release integration, implementation worker | P1. Outages and upgrades are plausible and can reopen closed streams or strand accepted footage | L / R02 through R06 | Capability-gated enrollment, legacy-recording adoption and recovery. Enforced release/rollback preflight remains outside the downgraded images and blocks an incompatible candidate before it can start. Database constraints protect stored state, not ingest by themselves. V08, V10, V12, V15, V19, V22 |
| R09 | Stack media harness plus admin/manager UI checks, implementation workers | P1. Stub-only success would leave real media and protocol failures undetected for users | L / R03 through R08, D04 | Implement the concrete test lanes in section 9 and record a runner for every V row. Include same-uploader reconnect, same-key overlap, busy refusal, actual decode, head and indexed large-payload reads, browser selection and negative controls. V01 through V22, with the live-only V20 explicitly separate |
| R10 | Stack/admin PR owners, then manager integration owner | P1. An unverified component combination affects all upgraded deployments | M / R09 | Reviewed companion PRs, exact candidate checks, manager pin to the verified stack commit, feature documentation and release packet. No dirty-submodule release. Pass the PR checklist |
| R11 | Levi-coordinated validation and release with agent observation | P1. Deployment order and state migration can affect funded active streams | M / reviewed candidates and test-environment approval | Prove V20 on the exact candidates in an approved isolated environment before final readiness. After authorized merges, deploy readers first, enroll idle streams and perform a release smoke check. Record versions and rollback proof. No active funded deployment is a disposable fixture |

Trade-off: R02 through R06 add durable state and coordinated contracts, but reusing IDs without them can overwrite history, accept an unintended broadcast or leave viewers stuck. Stable topics remove new topic allocation, not checkpoint and replay safety work. R08 is revised from M to L because a database trigger alone cannot prevent an old uploader accepting media. Its external preflight adds release integration but avoids that rollback hole. R07 adds operator clarity without changing the media contract and can be split from the core if Levi accepts the temporary display limitation. No unmeasured delivery date is attached to these sizes.

Work order: R01, then R02. R03 and preparation for R06 can follow the frozen contracts. R04 precedes the completed Continue control in R05. R07 can run alongside R05/R06. R08 and R09 assemble the exact combination. R10 prepares reviewed PR candidates, R11 validates them in the approved isolated environment, R10 completes merge readiness, then R11 performs the separately approved release. Workers may use separate worktrees after implementation is assigned. Astra reviews each logical commit and the assembled behavior. A second OpenAI invocation is not labeled a Claude or Fable review.

## 8. Verification matrix

Every result records the tested commits, test command, environment, executed and skipped cases, exit status and evidence path. Unit timing is deterministic. Real playback durations are reported observations. Successful HTTP requests, advancing catalogue status and mounted video elements are not substitutes for decoded media.

| ID | Priority | Smallest discriminating check | Required result |
| --- | --- | --- | --- |
| V01 | P1 | Pinned disposable SRS, RTMP and SRT, source plus ABR callbacks, reconnect inside engine inactivity timeout, same-key second publisher and client disconnect | Capture source/client identity, hook/acquisition/media order and busy refusal without unpublish. A refused candidate cannot replace the incumbent or deliver accepted media. Prove SRT cutoff separately. Measure detection delay without imposing a latency score |
| V02 | P1 | Real Postgres, two concurrent claims and then a close competing with admission | One owner wins. Closed never becomes open from a late lookup or report. Other tenant and invalid-key attempts are refused |
| V03 | P1 | Fake clock at 59,999 ms, 60,000 ms and 60,001 ms, then duplicate callbacks and a connection whose first media arrives late | Usable source media before deadline recovers once. A connection alone is insufficient. At or after deadline requires Continue. Exactly one finalization |
| V04 | P1 | Connect/reconnect without media, then a socket with stalled source timestamps | Original deadline remains. Real static-picture video still counts. Upload backlog cannot keep a dead source alive |
| V05 | P1 | Fake callbacks A publish/media/unpublish then B publish/media, followed by real labeled A/B media over loss and OBS-style Stop/Start inside grace | Same uploader instance and run, no notifyStop or early end marker, one final A+B recording with a marked seam. Audio/video decode and seek without missing or duplicated accepted footage. Record the late-window media-arrival margin |
| V06 | P1 | Whole ABR source loss versus one failed rung, with all expected renditions recorded | One source deadline, healthy rungs stay playable, no early group VOD, preserved cross-rung timeline |
| V07 | P1 | Delayed old unpublish, segment, Live and VOD after reconnect or Continue. Separately, B publish while A is attached, B refused busy without media/unpublish, then A unpublishes | Old messages cannot close, contaminate or reopen the current run. Busy-refused B changes no counters, history or ownership. A enters waiting and nothing finalizes early. A late callback from A cannot stop a verified B |
| V08 | P1 | Crash before and after each durable admission, cutoff, preparation and reporting boundary, plus failed file/directory flush | Restart keeps the original deadline and closed state. Pending actions reconcile. Missing/corrupt state refuses instead of creating fresh state. Persistence is not acknowledged before the required flushes. Process-crash evidence is not called a power-loss test |
| V09 | P1 | A ends, Continue, B ends, Continue, C ends, using fresh uploader processes too | Current replay is A+B+C. Each old snapshot remains byte-stable and playable. No old media uploads are repeated |
| V10 | P1 | Admin outage at cutoff, stale lookup, lost response, repeated Continue and competing Cancel | Local cutoff still applies. At most one new run. UI reconciles the same operation. No unsafe retry or conflicting permission |
| V11 | P1 | Final ABR master plus all rungs pinned, then two later runs and late rung reports | Old master still plays old rungs. New cumulative ladder is internally consistent. A missing expected rung is not counted as complete |
| V12 | P1 | Fail segment/manifest/catalogue writes and restart between VOD publication, checkpoint and cleanup | Previous verified replay survives. Accepted media remains recoverable. No false VOD-ready. Successful final publication is not duplicated |
| V13 | P1 | Direct start/segment API, loopback rung forgery, old uploader reports, unauthorized assignment | No alternative path bypasses permission or current-run validation. No secrets in logs, responses or public catalogue |
| V14 | P1 | Wrapped cumulative manifest larger than 4 KiB, repeated continuations, changed HLS headers and sequence resets, fetched through both indexed reads and the viewer's gateway feed-head request | Full history survives both read paths. Correct discontinuities, target duration and decoding across boundaries. No truncated restore or dependence on a tiny one-chunk fixture |
| V15 | P1 | Valid legacy snapshot, missing snapshot, unavailable old chunk and changed codec/ladder | Valid history can be adopted. Missing/incompatible history has an explicit refusal with old replay retained, under D01 |
| V16 | P1 | Browser opens before outage, during grace, during VOD and during continuation. Rerender the watch page with a refreshed catalogue and changed rendition references while replay is mounted | Automatic short recovery and honest ended state. Replay player is not destroyed or moved by polling. Explicit Watch live switches it once. Previous replay resolves correctly on refresh or in a new tab, including all pinned ABR rungs |
| V17 | P2 | Admin/manager stale reads, timed-out Continue, two tabs, keyboard-only operation. Deliver waiting, closed, then older waiting, and lose subsequent status refreshes | No stale success, duplicate operation or inaccessible control. Older waiting returns stale_event. Finishing and unavailable are distinct from ready. Stale observations do not produce a fabricated countdown or indefinitely confirmed Live |
| V18 | P1 | Play cumulative replay from start, seek on both sides of every seam and force every ABR quality | Video and audio decode. No wrong episode, sequence error or premature end. Verify with content markers, not only player events |
| V19 | P1 | Old/new component combinations, idle/active enrollment, pre-feature markLive SQL against managed closed state and an attempted old-image rollout through each supported release/rollback path | Database rejects the old mutation and preserves the final snapshot. New binaries refuse unsupported schema. The independent preflight refuses an incompatible image before container startup or ingress, including when the manager itself is the rollback target. Legacy streams still work. Database refusal alone is not an ingest-cutoff pass |
| V20 | P1 | Real approved OBS and Swarm run with one short outage, one 70-second outage and explicit Continue | Existing ID is rejected after expiry, then admitted only after Continue. Same page and cumulative replay work through the configured public viewer |
| V21 | P1 | First run with no accepted media, a continued empty run with prior VOD, and accepted media whose uploads all fail | First case records no VOD and can be explicitly reopened. Second retains prior replay. Third preserves failed work and cannot claim a verified-empty outcome |
| V22 | P1 | After closure, edit metadata, Republish, unpublish/publish, restart deployment and apply compatible engine config | The same ID stays closed and its checkpoint survives. Valid credentials still cannot publish until Continue |

Deliberate faults prove the tests matter. In isolated test copies, bypass the permission check, reset the restart deadline, accept an old run's VOD, discard earlier segments, feed polled rendition changes directly into the mounted replay player, and point an archived ABR rung at latest. V02/V13, V08, V07, V09, V16 and V11 respectively must fail. Also reinstate retire-and-replace for waiting sources and bypass the independent rollback preflight. V05/V07 and V19 must respectively fail. Record each failure and remove every deliberate fault before assembling a candidate. This targeted set is enough. A broad mutation campaign is not required for this batch.

Minimum real-media coverage is single and four-rendition ABR, RTMP and SRT, plus both one-Bee and per-rung publisher arrangements where supported. Run the full scenario flow in the default SRS topology, then focused admission, recovery, seam and end tests for the other combinations. Use at least one supported custom segment duration and frame rate. Under D01, reject incompatible format changes explicitly rather than silently narrowing the matrix.

## 9. Test execution and environment prerequisites

Use existing suites and add focused cases. Do not install dependencies or add repository workflows just to satisfy the verification box. Any genuinely needed dependency follows the repository's provenance checks.

| Layer | Execution and evidence |
| --- | --- |
| Focused unit iteration | The permitted local lane, a single suite at a time. Fake clocks, real parsing and isolated stores |
| Full unit, lint, typecheck and build | Existing verification-box workflow on exact pushed feature commits. Inspect both output streams and the requested/tested commit match |
| Admin database integration | Existing verification-box Postgres service with database-create permission, running `web2-admin/backend/test:integration` after the missing suite mapping is authorized. No development database |
| Admin UI and manager UI | Admin uses existing Vitest/jsdom component tests for keyboard access, disabled reasons and reconciliation. Its real two-tab case uses a written manual protocol on the D04 environment. Manager uses its mapped browser suite. Adding a browser dependency is unnecessary for this initial arrangement |
| SRS and media integration | A new disposable Compose arrangement containing pinned SRS, uploader, compatible admin plus disposable Postgres, Bee in dev mode and a synthetic labeled media sender. The bundled viewer and gateway run beside it for playback. R09 owns the harness, R01 adds the early protocol probe, and Levi selects its host through D04 |
| Viewer browser and media decode | Adapt the stack's existing `browser:*` lane to the D04 arrangement. Record the browser, gateway, exact commits and actual decode results. Existing deployed-host `e2e:*` commands are not claimed to work in a container without adaptation |
| Real Swarm/OBS validation | R11, separately authorized environment and spend, actual configured viewer, complete before/after observations |

The local `estate/verify/suites.json` currently maps manager native/browser suites and its stack submodule. The stack entry specifies build only. The admin repository has no entry there. Consequently a standard or deep run alone does not prove admin `test:integration`, stack `e2e:*` or `browser:*` suites ran.

The Docker runner is currently authorized for `LevilkTheReal/verify-fixture` only. The stack's existing media harness expects a deployed host and funded stamps. Neither is a ready execution lane for this plan. D04 selects a separate temporary test server or explicitly authorizes the necessary shared-box setup. Do not provision either now. A separate server is recommended because SRS transcoding otherwise shares the verification box with its Gnosis node. If the shared box is chosen, review repository admission, sibling-container resource limits, daemon-visible mounts and the accepted process-table disclosure before enabling the exact patch.

Before implementation validation, the verification owner must register the admin database suite and any concrete new suite names once those exist. The minimal known admin mapping is `postgres: ["web2-admin/backend/test:integration"]`. That suite uses development conditions and does not require `build: true`. Normal project builds are still separate checks. Check the helper's schema and deploy the mapping through the existing shared workflow only after authorization. A cross-repository test records all input commits and exact images. Do not widen token access implicitly.

The disposable dev-mode Bee lane proves application/media contracts, not real Swarm propagation, storage lifetime or paid delivery. V20 uses a separately approved funded stage. Each arrangement uses isolated ports, named resources, persistent test volumes for crash cases and a cleanup inventory. Never point the harness at an existing funded deployment.

Concrete execution assignment for every validation row:

| Validation | Execution lane |
| --- | --- |
| V01 | D04 disposable SRS protocol probe, real RTMP and SRT clients |
| V02 | Verification-box admin integration suite with disposable Postgres |
| V03, V04 | Stack focused fake-clock/callback tests locally while iterating, full suite on the box |
| V05 | Stack orchestrator regression on the box, then D04 real single-rendition media and decode |
| V06 | D04 source-loss and individual-rung-loss media harness |
| V07 | Stack callback unit suite and admin Postgres report tests on the box, busy-refusal sequence on D04 |
| V08 | Local isolated-store fault tests, full suite on the box, process-kill/restart cases on D04 persistent test volumes |
| V09 | D04 cumulative media harness with fresh uploader processes and replay decode |
| V10 | Box Postgres/concurrency and UI tests, plus D04 admin-outage and lost-response injection |
| V11 | D04 ABR snapshots and bundled-viewer reads after later runs |
| V12 | Box injected write failures, then D04 publication/checkpoint crash boundaries |
| V13 | Box API/auth regressions plus D04 real SRS direct-rung refusal |
| V14 | Box manifest parsing tests and D04 large-payload gateway head/indexed reads with the bundled viewer |
| V15 | Box adoption/format fixtures plus D04 changed opening-media and unavailable-chunk cases |
| V16 | Stack viewer selection regression on the box and `browser:*` checks against D04 |
| V17 | Admin Vitest/jsdom, manager mapped browser suite and admin report Postgres tests on the box. Recorded two-tab and keyboard protocol on D04 |
| V18 | D04 actual playback, seeking, content markers and forced ABR quality selection |
| V19 | Box real Postgres old-SQL test and schema checks, then D04 old/new image and release-wrapper refusal tests |
| V20 | Separately approved R11 OBS plus real Swarm stage, not the dev-mode Bee lane |
| V21 | Box empty/failed-outcome regressions and D04 first/continued empty runs |
| V22 | Box admin metadata/republish regressions and D04 deployment restart/config-rollout preservation |

R09 records the actual command and artifact for each assignment. These are required harness deliverables, not claims that all commands exist today. R01 can freeze the software contract while D04 is pending, but its real-engine proof and dependent media acceptance must wait for that environment.

Prepared standard commands, to run only after the named implementation branches exist and are pushed:

```sh
bash /Users/kisslevente/Documents/git/estate/tools/verify.sh run --repo Solar-Punk-Ltd/streaming-monorepo --ref feat/srs-reconnect-continuation --depth standard --scope all --services postgres
```

```sh
bash /Users/kisslevente/Documents/git/estate/tools/verify.sh run --repo Solar-Punk-Ltd/swarm-hls-stream --ref feat/srs-reconnect-continuation --depth standard --scope all
```

```sh
bash /Users/kisslevente/Documents/git/estate/tools/verify.sh run --repo Solar-Punk-Ltd/streaming-infra-manager --ref feat/srs-reconnect-continuation --depth deep --scope all
```

These commands are not the full acceptance suite. R09's executed-suite inventory must show where every V row ran, including named browser, database and media checks. A missing runner capability is an environment prerequisite, not permission to skip a required case or run heavy jobs on the laptop. An unstable retry is reported as unstable, never a clean pass.

For funded validation, size the run from the matrix before pricing it. Preflight storage capacity and lifetime, available chequebook balances, peers, RPC health, credentials, disk and queues. Record co-tenancy and resource limits. Capture every service's complete metrics and relevant logs before and after, then diff the whole instrument surface. Sanitize secrets at collection. The owner performs any funding transaction. No existing funded deployment, including `review-20260907`, is disposable. Its historical fill evidence is outside this task and remains unverified.

## 10. PR sequence and release gates

This cannot be delivered by a manager-only PR. Use one linked feature branch per repository, one logical fix per commit and no unrelated dependency or configuration cleanup. Follow Levi's repository branch convention with `feat/srs-reconnect-continuation` in all three. The earlier statement that the runtime requires a tool-name prefix was incorrect. It is an overridable default, not a demonstrated push restriction. No branch-prefix decision is needed.

| PR | Target | Contents | Merge condition |
| --- | --- | --- | --- |
| Admin companion | Existing `master`, approved D02 | Versioned run/permission contract, retained replay metadata, Continue control and migrations | Contract fixtures match stack, Postgres and UI checks pass, old behavior remains gated for unenrolled streams |
| Stack companion | `main` | SRS grace/enforcement, continuation checkpoints, cumulative replay, upgraded bundled viewer and media tests | Matched admin contract, required V rows pass and no early activation |
| Manager integration | `main` | Approved plan/reference docs, lifecycle read integration and pin to the exact reviewed stack commit | Companions are ready, the final pin is verified and the assembled candidate passes required checks |

Prepare and review companion PRs together. A merge into a default branch is not permission to activate the feature on an existing host. If a repository deploys automatically on merge, establish the disabled-by-default capability gate before merging any companion. After companion merges, recheck any changed merge commit before pinning it in the manager. Keep links and exact SHAs in every PR body.

Draft PRs may carry explicitly pending integration results. Final readiness requires V20 on the assembled candidates as well as the automated gates. A missing live environment is reported as pending validation, not as a tested release. Any owner-approved deferral is recorded as a release exception and does not turn the missing evidence into a pass.

PR checklist:

- [x] D01 and D02 resolved on 2026-09-20.
- [ ] D03 replay presentation and D04 test environment selected.
- [ ] Plan activated and assignments explicit.
- [ ] All repository baselines and applicable instructions rechecked.
- [ ] Each task has focused red-to-green evidence and review on its exact candidate.
- [ ] Shared fixtures agree across admin, uploader and viewer. No permissive legacy fallback for enrolled streams.
- [ ] Standard checks, real Postgres, browser, real SRS and relevant media cases actually executed. Skips named.
- [ ] Targeted deliberate faults each produced the expected failure.
- [ ] VOD history, ABR snapshot pinning, multi-cycle continuation and stale-report cases pass.
- [ ] Migration and rollback checks pass. Feature remains disabled until compatible components are deployed.
- [ ] Documentation describes OBS retries, the 60 seconds, Continue, cancel-before-claim, format limits and failure recovery.
- [ ] No credentials or funded test data in the diff. Submodule is clean and pinned to a published reviewed commit.
- [ ] No unresolved P1. Any accepted P2 names owner, consequence and follow-up. PR bodies distinguish tests from live proof.

Deployment order is upgraded viewer first, compatible admin next, then the managed stack and manager integration. Keep the capability off during mixed deployment. Enroll a new or idle test stream only when all participants match. Existing live streams finish under their old contract. A legacy VOD can be adopted only by the tested R08 path.

Before new durable state is written, a verified rollback can disable the feature and return to the prior component set. After enrollment, use two controls:

1. The forward migration installs database invariants that refuse legacy Live transitions on managed closed runs and protect retained recording references from incompatible writes. New binaries refuse unsupported schema versions. Test the actual pre-feature SQL against the migrated database. This protects persisted state. It does not itself stop an old uploader from accepting or writing media before its state report is rejected.
2. Every supported deployment and rollback entry point invokes a compatibility preflight before stopping or replacing services. It reads the durable enrollment/schema and uploader journal requirements and checks the candidate component capabilities. Refuse an incompatible candidate before it starts. Keep this guard and its compatibility record outside the images being downgraded, including the manager image, so reverting the candidate cannot revert the guard. Missing or unreadable capability evidence refuses the transition. Installation of this release guard is a separately coordinated part of R08/R11, not a host operation authorized by this draft.

V19 must show both the old-SQL refusal and the old-image startup refusal. Test the deployment wrapper itself, not just its helper. A new binary's boot check does not retrofit an old binary. Do not advertise support for arbitrary manual root launches that bypass the supported release path. After an incompatible rollback refusal, close input and use a compatible recovery build. Never restore a database over newly accepted footage. Keep compatible readers available during recovery.

Live completion checklist:

- [ ] Exact admin, stack, manager, SRS and viewer versions recorded.
- [ ] V20 demonstrated with OBS and the actual public watch page.
- [ ] Both single and ABR recordings play through every seam, with all intended qualities checked.
- [ ] A 70-second return is refused before Continue, and the same ID resumes only after it.
- [ ] Prior replay still works while the continuation is live and after it ends.
- [ ] Preflight, complete metric diffs and logs filed with no secret values.
- [ ] Test senders stopped and disposable test state cleaned without removing paid storage or other sessions' assets.
- [ ] Levi sees the final behavior and release evidence. Remaining limits are named.

## 11. Decisions and activation

Already selected: SRS only for this batch, 60-second automatic recovery, no synthetic replacement video, explicit Continue after expiry, stable stream ID and watch page, rejection while closed, preserved previous replay and cumulative recording. Existing replay viewers get a Watch live choice instead of an automatic playhead jump. OBS itself may keep retrying and is not remotely stopped by this feature. Stable feeds with distinct run numbers implement these choices without new per-run topics.

| Decision | Choice and impact | Recommendation | State |
| --- | --- | --- | --- |
| D01 | May codec, audio layout or quality ladder change across continuation? Accepting arbitrary changes adds media conversion and its separate validation. Refusing incompatible changes preserves the smaller implementation. Scene changes remain supported | Require a compatible output contract. Explain the exact mismatch and let the owner restore compatible settings or create a different stream. Do not silently split the promised cumulative replay | Decided by Levi on 2026-09-20: “Keep compatible encoding settings (recommended)” |
| D02 | Admin currently uses `master`, while the user requested a PR to `main`. Renaming a default branch affects its other sessions and automation | Target admin `master`, stack `main`, manager `main`. Do not rename the admin branch for this feature | Decided by Levi on 2026-09-20: “Use each existing default branch (recommended)” |
| D03 | After multiple continuations, should viewers see one current combined replay, or also a list of earlier completed versions such as A and A+B? Both keep old footage and the previous replay available during a continuation. The list adds history UI and catalogue entries. It does not require fresh feed topics | One current combined replay. Keep the previous replay selectable while the next run is live. Do not add a history list unless Levi wants it | Pending. No history UI is added or ruled out by this draft |
| D04 | Real SRS and video tests need a place to run. A separate temporary test server isolates their load and needs an available host or an approved rental. Using the shared verification server instead requires authorizing this repository's Docker jobs and reviewing its shared-resource setup | A separate temporary test server for media, with the existing verification box for unit, database and component checks. Quote any rental and funded-stage spend before provisioning | Pending. No server setup, rental or paid test is authorized by this draft |

Levi requested no more review rounds. Answer D03 and D04, record the choices and proceed with the separately activated implementation brief. Do not send another Fable handoff. The corrected plan is not described as unanimous consensus or as runtime-verified.

Operational prerequisites, not new product decisions:

1. Register this plan in estate before implementation. Prepare a new canonical plan file and one index row, without editing unrelated records. This needs the estate assignment and shared-session coordination required by the supplied repository instructions.
2. Record the configured public viewer build at R01. Its owning repository is documented as the bundled stack client. If the eventual test configuration contradicts that documentation, report the mismatch before claiming completion.
3. Register missing verification suites and confirm the authorized disposable SRS test environment. The concrete known admin database requirement is in section 9. No host configuration change is implicit in this plan.
4. Obtain separate release/test-spend authorization when the exact candidate and live run are ready. Do not ask for funding now or use historical approvals as an unlimited testing budget.

Ready-to-relay coordination prompt before shared activation:

> We are preparing the SRS reconnect/continuation feature across streaming-monorepo, swarm-hls-stream and streaming-infra-manager. The current corrected draft is `streaming-infra-manager/docs/consensus/SRS-RECONNECT-CONTINUATION-PLAN-v2.md`. Levi requested no further review rounds. Please identify active work that overlaps stream state, admin ingest lookup, SRS callbacks, recording finalization, catalogue fields or the viewer. We propose one isolated feature branch per repository. Before activation, confirm that adding `estate/plans/2026-09-20-srs-reconnect-continuation.md` and its `estate/plans/INDEX.md` row will not conflict with an in-flight edit. Verification mapping and release-guard installation will be separate concrete changes. No host or default-branch change is part of this coordination. Reply with conflicts or clear-to-proceed. We will report the activated plan path and candidate commits when ready.

Next implementation handoff after decisions and coordination:

> Read the active registered plan and repository instructions. Recheck the three baselines. Start R01 and freeze the cross-repository fixtures and SRS capability evidence before source implementation. Work in isolated feature branches, write the failing tests first and commit one logical change at a time. Astra reviews the contracts and worker changes. Build R02 through R09 in dependency order, then prepare the linked companion PRs and the manager integration PR. Keep the feature disabled during mixed deployment. Do not deploy, move funds or use funded deployments as disposable fixtures. Stop only the dependent work if a product decision or actual permission is missing, and continue independent work.

## 12. Evidence and planning validation

Primary references read 2026-09-20:

- [Admin lifecycle at the reviewed commit](https://github.com/Solar-Punk-Ltd/streaming-monorepo/blob/488486786a821dad76c2a2b16f812e3943572701/web2-admin/backend/src/domain/streamState.ts).
- [Admin ingest lookup and state reporting](https://github.com/Solar-Punk-Ltd/streaming-monorepo/blob/488486786a821dad76c2a2b16f812e3943572701/web2-admin/backend/src/domain/StreamStateService.ts).
- [Admin database integration contract](https://github.com/Solar-Punk-Ltd/streaming-monorepo/blob/488486786a821dad76c2a2b16f812e3943572701/web2-admin/backend/test/integration/README.md).
- [Admin migration runner](https://github.com/Solar-Punk-Ltd/streaming-monorepo/blob/488486786a821dad76c2a2b16f812e3943572701/web2-admin/backend/src/domain/Database.ts), read to check the old-binary rollback gap.
- [Admin viewer ownership record](https://github.com/Solar-Punk-Ltd/streaming-monorepo/blob/488486786a821dad76c2a2b16f812e3943572701/docs/infra-state.md), documentation rather than a current host inspection.
- [Stack orchestrator](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/blob/2c4867aee359928263155c50d82c13e6b1362f4b/packages/stream-uploader/src/libs/StreamOrchestrator.ts), inspected for recovery versus retire-and-replace behavior.
- [Stack watch-page inputs](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/blob/2c4867aee359928263155c50d82c13e6b1362f4b/packages/client/src/pages/StreamWatcher/StreamWatcher.tsx) and [player effect](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/blob/2c4867aee359928263155c50d82c13e6b1362f4b/packages/client/src/components/SwarmHlsPlayer/SwarmHlsPlayer.tsx), inspected for the catalogue-remount path.
- [Stack feed-index recovery](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/blob/2c4867aee359928263155c50d82c13e6b1362f4b/packages/stream-uploader/src/libs/StreamUploader.ts) and [recovery-store writes](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/blob/2c4867aee359928263155c50d82c13e6b1362f4b/packages/stream-uploader/src/libs/RecoveryStore.ts), inspected for stable-feed reuse and durability limits.
- [RFC 8216, ENDLIST and VOD semantics](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.3.4). Final playlists are not reopened by deleting a tag.
- [SRS 6 publish callback contract](https://ossrs.io/lts/en-us/docs/v6/doc/http-callback#http-callback-events). Matching-image RTMP and SRT enforcement still requires V01.
- [SRS 6 RTMP publish ordering](https://github.com/ossrs/srs/blob/6.0release/trunk/src/app/srs_app_rtmp_conn.cpp), checked for hook-before-acquisition and the missing unpublish on busy refusal. This upstream branch is not proof of the exact pinned image contents.

Planning checks are document checks only. Source baselines and the local verification mapping were read. No runtime behavior was newly verified. V1 and Fable's supplied review remain unchanged. The current proposal retains 13 scenarios, 11 tasks and 22 validation rows. D01 and D02 remain settled. D03 and D04 are the only new owner questions.

## 13. Fable review disposition

Input: Levi supplied Fable's “Second review of SRS-RECONNECT-CONTINUATION-PLAN.md” as an attachment on 2026-09-20. Reviewer identity stated in that artifact: Claude Fable 5.1, Anthropic. Its verdict on v1 is REVISE. This section is Astra's response, not an edit to Fable's review or an approval attributed to it. Levi ended further review rounds and requested these corrections.

| Finding | Priority and disposition | Correction, evidence and trade-off |
| --- | --- | --- |
| F01 | P1, accept with a stricter provisional-callback rule | Normal reconnect affects recording integrity. Source confirms retire-and-replace and upstream hook-before-acquisition. Sections 4.2, R03 and V01/V05/V07 retain the uploader and authenticate the replacement. Resetting counters immediately on the hook would still damage the incumbent when SRS later refuses busy, so that change waits for verified replacement. Cost is the waiting/resume path already needed for the feature. Accepting the gap splits recordings |
| F02 | P1, accept | Catalogue refresh can move every ABR replay viewer to live. R06 and V16 freeze the selection in the enclosing watch page. Test that boundary, not a rule that the player must ignore all deliberate prop changes. Cost is a small selection model and regression. Accepting it violates the explicit Watch live choice |
| F03 | P2, accept stable feeds, revise the claimed savings | Existing feed-index recovery supports later entries on stable topics. Sections 4.1 and 5 remove fresh-topic allocation. Indexed master and rung snapshots remain necessary for replay access during continuation, even without a history list. Stable topics do not remove that reader work or all remount risks. D03 is a presentation choice. Recommend the simpler list-free presentation while keeping preservation. This removes topic churn without losing the promised replay |
| F04 | P1, accept the gap, strengthen the proposed control | A rollback is plausible and can reopen ingest or erase history. Database.ts confirms old binaries ignore unknown migrations. A trigger protects the database only after a request reaches it. R02 adds invariants and new-binary schema checks. R08/V19 also block incompatible startup through a guard outside the downgraded images. This adds release integration, reflected in R08's L size. Accepting database-only protection would leave ingest unguarded |
| F05 | P2, accept with durable nonblocking delivery | Every outage otherwise leaves the console without a confirmed deadline. Sections 4.3/4.4, R02/R05 and V17 add waiting/closed reports, ordering, retry and freshness. Cutoff never waits for reporting. Small contract work avoids misleading operator state |
| F06 | P2, accept, required before media validation | R09 would otherwise have no executable lane. Section 9 assigns every V row, separates component tests from real browser/media tests and removes the unnecessary admin build prerequisite. The local workflow authorizes only the Docker fixture today. D04 selects the real-media environment. Cost is harness/environment preparation already implicit in R09. Accepting the gap would produce an untested release |
| F07 | P2, accept correction, no owner decision needed | The runtime prefix is a default and allows the user's repository convention. Commands now use feat/srs-reconnect-continuation. No push restriction was demonstrated. Cost is text only, avoiding needless branch-policy conflict |
| F08 | P2, accept conditional OBS copy | Reconnect may be delayed or stop, so Open does not promise immediate video. Section 6 tells the operator to press Start Streaming if retries stopped. No exact OBS backoff or version-specific timing is asserted. Cost is copy only |
| F09 | P3, record boundary limit | A just-in-time connection can still miss the usable-media deadline. Section 4.2 and existing V03/V05 describe and measure it. Keep the agreed strict window. No extra grace feature or separate workstream |
| F10 | P3, retain as unmeasured probe inputs | Upstream timeouts and the client API are documentary leads for existing V01. Do not infer which deadline governs on the deployed image or claim SRT disconnect works before the probe. No host investigation in this planning pass |
| F11 | P3, record baseline limit and specify new-record durability | RecoveryStore has no fsync. Section 4.1 names flush/rename/directory-flush requirements for the new records and V08 checks acknowledgement boundaries. This is not a claim of measured power-loss survival or a repository-wide storage rewrite |

Task disposition: R01 through R04, R06, R08 and R09 are corrected as recorded in section 7. R05, R07, R10 and R11 retain their approved purpose with the clarified reporting, OBS copy, branch naming and environment dependencies. R08's estimate increases because the proposed database-only fix did not enforce rollback ingest safety. R04 remains L because preservation and cumulative media still need end-to-end proof. D01 and D02 are unchanged.

Review process state: closed to further rounds at Levi's request. The technical corrections are recorded in v2. D03, D04, shared-plan activation and the implementation/test/release authorizations remain pending as named above. No runtime checks, source implementation, shared setup change or publication occurred in this correction pass.
