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
| Exclusive-writer helper | Alpine 3.23 main `flock=2.41.6-r1` | The [official Alpine package record](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/flock) lists a 2026-09-05 build, source commit `96f05433b217acf92bee031df551b10d8b3a1ec2` and musl as its sole runtime dependency. This package build is older than fourteen days. Actual installed-package and process-exclusion evidence is still pending |

The image index contains per-platform attestation manifests. Their presence is not a claim that their signatures or contents were independently verified. No runtime image has yet been built for this feature. The isolated build must retain the exact image ID, installed APK versions, trusted package signature result and vulnerability/provenance readings before release readiness. No untrusted-package flag is permitted. No npm dependency is introduced for the media probe.

The Node runtime release itself predates the Docker rebuild. The [official Node 22.23.2 release](https://nodejs.org/en/blog/release/v22.23.2) is dated 2026-07-29 and is a security release. The under-two-week flag above applies to the image rebuild. The [Alpine 3.23 community security database](https://secdb.alpinelinux.org/v3.23/community.json) returned 461 package entries. Its ffmpeg security-fix versions end at 8.0-r0, below the proposed 8.0.1-r1. This does not replace the still-pending installed transitive-package inventory and review.

The approved package choice does not change any live service. The test host is used only for the isolated runtime and real-media validation authorized by Levi.

## Writer ownership

The selected design opens one lock file in the actual configured state directory before any managed store opens. A bounded `flock` helper acquires the lock through an inherited file descriptor. Node retains that descriptor for the complete writer lifetime. The [Linux flock contract](https://man7.org/linux/man-pages/man2/flock.2.html) associates the lock with the shared open-file description and releases it when its final descriptor closes. This avoids a stale PID heuristic or deleting a lock inode after a crash.

The implementation must prove the behavior with real competing processes, a killed holder and a successful successor. A custom `STATE_DIR` must use its own matching lock. A missing helper refuses managed startup. A local platform skip is reported as skipped and does not substitute for the Linux/runtime proof. The same mounted volume is the boundary, independently copied state volumes are not a distributed writer fence.
