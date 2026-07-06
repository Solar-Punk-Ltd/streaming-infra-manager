import { describe, it } from 'node:test';

/**
 * Scenario E — SRS media-engine restart mid-stream. PARKED as a documented `todo`.
 *
 * Live investigation (2026-07-06) showed that restarting the SRS engine container wedges the live
 * path — the uploader never recovers the stream and refuses the reconnecting broadcaster:
 *
 *   - Restarting SRS drops the broadcaster's SRT connection. ffmpeg/OBS in caller mode does not
 *     auto-reconnect the SRT session, so the publisher dies and the segment feed stops.
 *   - SRS sends NO `on_unpublish` on restart, so the uploader never learns the session ended. The
 *     stream stays in `activeStreams` forever — there is no idle reaper; only on_unpublish, the
 *     recovery timeout, or shutdown cleanup ever remove a stream (StreamOrchestrator.stopStream).
 *   - It never surfaces as stale on /health either: `hasStaleLiveManifest` counts manifest *publish*
 *     failures (consecutiveManifestFailures), which a bee outage trips but a feed cessation does not
 *     — no segments means no publish attempts, so staleManifestStreams stays 0 (StreamUploader.ts).
 *   - When a broadcaster reconnects to the same path, SRS re-announces `on_publish` → startStream,
 *     but the stream is still active → "[StreamOrchestrator] Stream <id> already active, rejecting
 *     start" (StreamOrchestrator.ts:57). The new segments are dropped (dedup/unknown), so the live
 *     path is stuck until the stream-uploader is restarted.
 *
 * Shares scenario F's root cause: the only reconnect path is the RecoveryStore recovery-timer branch
 * (uploader hard-crash), never an engine restart. Root cause is PRE-EXISTING (not PR #10). A fix
 * (reap idle activeStreams, or let a re-announced on_publish adopt/replace an existing active stream)
 * belongs in its own ticket. The harness (publisher + host + logwatch + /health) is ready to turn
 * this into a behavioral test once the resume path is defined. See uploader-crash-recovery.test.ts.
 */
describe('E — SRS media-engine restart mid-stream', () => {
  it.todo('survive an SRS-engine restart and let the broadcaster resume (not supported yet — see comment)');
});
