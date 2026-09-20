# Reconnect SRS broadcasts and continue cumulative recordings

Status: active local PR draft. Not published. Implementation and assembled validation remain in progress.
Target: `Solar-Punk-Ltd/swarm-hls-stream`, `main`.

Managed SRS broadcasts retain the same uploader and recording through an encoder interruption of up to sixty seconds. After the original deadline, the uploader closes the run and refuses that ingest ID. An owner-approved Continue prepares the retained history before a later encoder connection can append to the same cumulative recording.

Durable source identity, accepted-media journals, pending reports and completion checkpoints preserve recovery boundaries across process failure. ABR renditions belong to their run and source generation. Actual opening-media inspection checks codec, audio layout and the frozen ladder before publication. Completed replay reads use pinned master and rendition references, so a viewer watching the previous replay keeps its playhead until choosing to switch.

This applies to SRS. It does not add OBS remote control, transcoding for incompatible continuation settings, or automatic reopening after the deadline. Managed behavior is disabled by default and requires the compatible admin plus release/enrollment checks.

Companions: admin run/permission and Continue controls, followed by the manager's verified stack pin and observation/release integration. Add PR links and exact checked commits before publication. The isolated negative browser branch is test evidence only and must never be merged.

Validation recorded so far includes focused deadline, stale-callback, durability, feed-recovery and format-check regressions. A real mounted-page Chrome test passed three cases. Removing its immutable replay binding produced the two intended failures. That browser test substitutes the media player and is not decoding evidence. Early pinned SRS RTMP/SRT probes establish callback and disconnect behavior, not cumulative playback.

Before readiness: final full build/lint/typecheck/tests, Linux writer/process-crash checks, installed-image provenance and package inventory, the isolated private-chain media matrix, actual cumulative audio/video decoding and the separately coordinated OBS/real-Swarm case. Record every executed and skipped validation row with the tested commit. No existing funded deployment is a disposable fixture.
