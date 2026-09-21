# Reconnect SRS broadcasts and continue cumulative recordings

Status: active. Published as draft PR https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/242. Not ready to merge.
Target: `Solar-Punk-Ltd/swarm-hls-stream`, `main`.

Managed SRS broadcasts retain the same uploader and recording through an encoder interruption of up to sixty seconds. After the original deadline, the uploader closes the run and refuses that ingest ID. An owner-approved Continue prepares the retained history before a later encoder connection can append to the same cumulative recording.

Durable source identity, accepted-media journals, pending reports and completion checkpoints preserve recovery boundaries across process failure. ABR renditions belong to their run and source generation. A delayed disconnect from an earlier source cannot revoke the continued source's rendition authorization. Actual opening-media inspection checks codec, audio layout and the frozen ladder before publication. Completed replay reads use pinned master and rendition references, so a viewer watching the previous replay keeps its playhead until choosing to switch.

This applies to SRS. It does not add OBS remote control, transcoding for incompatible continuation settings, or automatic reopening after the deadline. Managed behavior is disabled by default and requires the compatible admin plus release/enrollment checks.

Companions: admin run/permission and Continue controls, followed by the manager's verified stack pin and observation/release integration. Final checked commits remain required before readiness. The isolated negative browser branch is test evidence only and must never be merged.

The new isolated fixture command selects reconnect or cumulative-media scenarios. It validates exact candidate identities and private targets, records resource intent before creation, and uses verified Docker identities for cleanup. Interrupted or ambiguous operations retain their evidence and refuse automatic cleanup. The command reports execution completion separately from acceptance evidence.

Validation recorded so far includes focused deadline, stale-callback, durability, feed-recovery and format-check regressions. The continued-source disconnect regression first failed, then the complete twelve-case managed callback file passed. A separate retained-recording recovery regression first exposed a missing discriminator import, then passed with the import repaired. Both files passed all fifteen cases on integrated stack `b488147165652cfe08b3101c6109961e9b513e4e`. The bounded strict compiler check also passed on that commit. A real mounted-page Chrome test passed three cases. Removing its immutable replay binding produced the two intended failures. That browser test substitutes the media player and is not decoding evidence. Early pinned SRS RTMP/SRT probes establish callback and disconnect behavior, not cumulative playback.

Before readiness: final full build/lint/typecheck/tests, Linux writer/process-crash checks, installed-image provenance and package inventory, the isolated private-chain media matrix, actual cumulative audio/video decoding and the separately coordinated OBS/real-Swarm case. Record every executed and skipped validation row with the tested commit. No existing funded deployment is a disposable fixture.

Companion drafts: [stack #242](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/242), [admin #8](https://github.com/Solar-Punk-Ltd/streaming-monorepo/pull/8), [manager #43](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/pull/43).
