# SRS opening-media inspection runtime

Status: active evidence record under the registered SRS continuation implementation.
Date: 2026-09-21.
Reviewer: OpenAI-hosted Astra.

Actual codec and audio-layout checks will use a bounded ffprobe subprocess. It inspects the opening MPEG-TS bytes without conversion. The child receives bytes through stdin, accepts only the pipe protocol and has input, output, time and concurrency limits. The source generation must still be current when the result returns.

## Candidate runtime

| Component | Exact candidate | Evidence and limitation |
| --- | --- | --- |
| Node base | `node:22.23.2-alpine3.23@sha256:72c5815a06aed9a2273aea5628d74d348af57843a7b547af2fe53dd3e4b95261` | Official multi-platform index read through `docker buildx imagetools inspect` on the approved test host. The amd64 manifest is `sha256:595e1b43636b204a5a59408f78f012ffd5c984f2451f565ed4e6a0e0d8f1b8b7` |
| Base source | docker-node `bc0a422bce0f729dd85790639d9f1918143f1235`, `22/alpine3.23` | The registry annotations agree with the [official-images Node listing](https://raw.githubusercontent.com/docker-library/official-images/master/library/node). The amd64 image creation timestamp is 2026-09-17. This is younger than two weeks and is explicitly flagged |
| ffprobe package | Alpine 3.23 community `ffmpeg=8.0.1-r1` | The [official Alpine package record](https://pkgs.alpinelinux.org/package/v3.23/community/x86_64/ffmpeg) lists ffprobe, a 2026-01-09 build and source commit `8623c9968f3fca48863eb9d3a355c2baaba7b20b` |

The image index contains per-platform attestation manifests. Their presence is not a claim that their signatures or contents were independently verified. No runtime image has yet been built for this feature. The isolated build must retain the exact image ID, installed APK versions, trusted package signature result and vulnerability/provenance readings before release readiness. No untrusted-package flag is permitted. No npm dependency is introduced for the media probe.

The approved package choice does not change any live service. The test host is used only for the isolated runtime and real-media validation authorized by Levi.
