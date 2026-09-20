# SRS lifecycle contract, version 1

Status: active implementation contract.
Date: 2026-09-20.
Owner: OpenAI-hosted Astra. Companion implementations use the same shapes.

This records the protocol decisions needed by the approved reconnect and continuation plan. It does not claim that the three implementations or the full media matrix have passed yet.

## Identities and permission

The declared stream UUID is the admin identity. The topic and derived rendition topics stay fixed. A positive run number identifies a broadcast period. A feed index identifies a feed entry and is never substituted for a run number.

Lifecycle version 1 is opt-in. Legacy and OME streams remain outside it. Each managed run is assigned to one configured uploader identity. Claiming changes permission from open to claimed atomically. Run identity, assignment and claim identity accompany every report and recovery read. A closed permission never becomes open in the same run.

Run states are ready, claimed, live, waiting, closed and vod. Claimed may become waiting before the first manifest publication succeeds. Live is reported only after usable media publication succeeds. Closed means admission has ended. VOD means final manifests and a durable continuation checkpoint are complete.

The existing ingest lookup requires `X-Stream-Lifecycle-Version: 1` for managed rows. An old client receives the same not-found refusal as any other disallowed lookup. A configured managed uploader refuses a response without the matching lifecycle contract.

A negotiated lookup retains the existing stream fields and adds `lifecycleVersion: 1` with `mode: legacy` or `mode: managed`. Managed mode also includes `lifecycle: { revision, runNumber, state, permission, uploaderId }`. Explicit negotiated legacy mode omits that lifecycle object and lets an active legacy stream finish under its existing behavior. An absent envelope never means legacy to an enabled uploader. Non-negotiating old clients receive their original payload only for legacy rows. This distinction prevents an old admin response from silently disabling admission protection while preserving mixed-row operation.

## Internal routes

All routes below retain the existing internal bearer-token authentication. Tokens and encoder keys are never written to logs or public catalogue entries.

| Action | Route | Required identity and result |
| --- | --- | --- |
| Claim | POST `/api/internal/streams/:id/runs/:run/claims` | `lifecycleVersion`, `expectedRevision`, `uploaderId`, `requestId`. Returns run, revision, claim ID, state and permission |
| Observe or finalize | POST `/api/internal/streams/:id/runs/:run/reports` | `lifecycleVersion`, `runNumber`, `uploaderId`, `claimId`, `eventSequence`, `observedAt`, state and state-specific data |
| Recover | GET `/api/internal/streams/:id/runs/:run` | Bound `uploaderId` and `claimId`. Available after ingest is closed so response loss can be reconciled |
| Find preparation work | GET `/api/internal/uploaders/:uploaderId/continuations` | Pending operations assigned to that uploader, including stream ID, topic, media type, operation ID, previous and next run, revision and retained snapshot |
| Complete preparation | POST `/api/internal/streams/:id/continuations/:operationId/preparation` | `lifecycleVersion`, `uploaderId`, `expectedRevision`, status ready or failed, opaque `checkpointReference` and bounded failure description when applicable |

Claims use an expected revision and request ID. Concurrent different claims have one winner. An exact retry cannot return a cached open permission after the run closed. It returns the current result or a closed refusal.

Reports use a strictly increasing sequence within a claim. An identical sequence and payload is idempotent. A lower sequence is stale. Reusing a sequence with different data is a conflict. An old run or claim cannot mutate the current run. Retrying a report after a catalogue-write failure republishes the committed state without applying the transition twice.

Waiting reports carry the absolute reconnect deadline. Closed reports carry a reason. VOD reports carry the completed recording snapshot. Active observations use a ten-second heartbeat. The server records receipt time and labels an active observation unavailable after thirty seconds without a fresh report. Receipt time never resets the source deadline. Durable closed and completed facts do not expire into open permission.

Preparation is polled by the uploader through its existing admin connection. The admin does not call a host command endpoint. Preparation validates assignment, operation identity and expected revision in one transaction. A cancelled, claimed or replaced operation cannot reopen permission. The same acknowledgement retry is idempotent. Failed preparation preserves closed admission and the previous completed replay.

## Owner controls

POST `/api/streams/:id/continuations` accepts `requestId` and `expectedRevision`. It returns 202 with an operation and its Location. GET on that operation reconciles an uncertain response. DELETE cancels only before the new run is claimed.

Operation states are pending, ready, failed, cancelled and claimed. There is at most one unresolved operation for the stream. Allocation happens once. Preparing a run does not advertise empty video or replace the completed snapshot. The run becomes open only after its assigned uploader has durably prepared the checkpoint. Owner scoping remains the same as the other stream controls.

A durably verified empty closed run may also be continued with empty history. Empty means no media was accepted. Failed uploads of accepted media never qualify. The closed report retains its private checkpoint UUID and explicit empty outcome without fabricating a completed recording. An empty continuation preserves any earlier completed replay.

## Completed replay and private checkpoint

The internal snapshot has a run number, an opaque checkpoint UUID, an exact master reference and an exact reference for every expected rendition. The UUID names a record in the assigned uploader's durable checkpoint store. It is neither a host path nor a public catalogue value. Loss of that record blocks continuation until it can be restored or safely adopted from verified recording data.

Master fields are topic, index, reference and duration. Rendition fields add name and the original quality metadata, including width, height and bandwidth where relevant. Indices are nonnegative safe integers. References are validated Swarm references, not arbitrary URLs. The snapshot requires precisely the expected ladder. A partial ladder is not a completed ABR replay.

The public catalogue adds two optional fields:

```text
lifecycle: {
  version: 1,
  revision,
  runNumber,
  state: ready | claimed | live | waiting | closed | vod
}
completedRecording: {
  runNumber,
  master: { topic, index, reference, duration },
  expectedRenditions: [name],
  renditions: [{ name, topic, index, reference, duration,
                 width?, height?, bandwidth?, avgBandwidth? }]
}
```

Neither field contains the checkpoint UUID, uploader assignment, claim ID or a secret. Existing top-level catalogue status and rendition fields remain compatible. Captured quality metadata is immutable with the snapshot. The prior completed snapshot stays visible during preparation and the next live run. Successful finalization replaces it with the new cumulative replay. There is no version-history list.

## Viewer selection

After the initial catalogue lookup, a new visitor selects the current live run for live or waiting, otherwise the completed replay when available. Existing legacy direct URLs still work.

A mounted replay freezes its master and every rendition input. Catalogue refresh changes surrounding metadata only. A newer live run offers `Stream resumed · Watch live`. That explicit action creates one new player selection. During a continuation, the previous combined replay remains selectable and reads its exact completed references rather than feed heads.

The component regression must rerender the mounted watch page. A pure helper test alone does not prove that React preserves the player. The browser check records player creation/destruction and playhead before the poll and after the explicit action.

## SRS source proof and deadline

The engine probe ran the host's cached SRS 6 image, reporting 6.0.191, on Docker Engine 29.1.3. Test-only RTMP, SRT, callback receiver, source HLS and one transcoded ABR rung ran without Bee or paid traffic. Existing services were unchanged.

Both protocols include server, service and client identities in publish, media and unpublish callbacks. A competing RTMP publisher produced publish without media or unpublish. A competing SRT publisher produced publish and unpublish without media. Neither replaced the incumbent. A publish callback is therefore provisional.

DELETE of the current publishing client through the SRS API detached both RTMP and SRT. A denied publish produced no accepted stream. Source and ABR rendition media callbacks were independently observed. Managed ABR keeps bounded source HLS enabled as a progress signal and never uploads that extra source rendition to Swarm. The callback-load gate counts the source plus all rungs.

For one silent-socket sample per protocol, unpublish arrived 24,291 milliseconds after pausing the RTMP sender and 5,145 milliseconds after pausing the SRT sender. These are observations on this configuration, not promised timeouts. The lifecycle deadline comes from the last verified advancing source media, or the initial bounded claim when no media has arrived. A delayed unpublish cannot grant another sixty seconds.

Source identity includes server ID, service ID, client ID and local generation. Only verified source progress may renew its no-progress budget. A rung, upload backlog, refused candidate or old callback may not. At the deadline, persist closed before accepting another callback, reporting state or finalizing. Kick an attached source and keep all later input refused until a new prepared run is claimed.

## Evidence and remaining work

The executable protocol probe is `docs/testing/srs-continuation/srs-protocol-probe.py`. Its source, collected outcomes and full before/after readings identify the test configuration. These engine probes do not prove cumulative decoding, the React interaction, real Swarm publication or deployment compatibility. Those remain the implementation validation matrix.

Enrollment, adoption and the independent rollback guard remain R08 deliverables. No stream is automatically enrolled merely because this contract document exists. Mixed-version deployments remain disabled until their capability checks and release preflight pass.
