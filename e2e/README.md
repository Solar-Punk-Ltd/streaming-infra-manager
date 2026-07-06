# e2e — streaming failure-scenario tests

End-to-end / fault-injection tests that drive the **real** stack (SRS → stream-uploader → bee →
Swarm → gateway → viewer) and inject failures, to prove PR #10's integrity + segment-continuity
behaviour. Unit tests live in the packages; this is the layer above them.

## Modes

- **attach** (default) — connect to an **already-deployed** profile (e.g. `srs-check-test1`) over
  `ssh`, discover its live stamp, and inject faults with `docker stop/start/pause`. No deploy, no
  BZZ. Mirrors the manual `docker stop bee-uploader; sleep 8; docker start` flow.
- **deploy** — bring a profile up fresh via the manager API first (heavier, opt-in).

Target is set in [`config.ts`](./config.ts) and overridable via `E2E_*` env vars
(`E2E_MODE`, `E2E_SSH_TARGET`, `E2E_PROFILE`, `E2E_PORT_SLOT`, `E2E_PUBLIC_HOST`, …).

## Layout

```
harness/    shared helpers (host ssh, publisher, viewer catalog, log assertions) — not tests
smoke/      read-only attach + stamp-discovery check (safe anytime)
scenarios/  the fault-injection matrix
service/    whole-service coverage (no faults)
```

### The suite

Fault scenarios (publish a real stream, then inject a fault):

| File | Proves |
|------|--------|
| `scenarios/bee-outage-short` (A) | bee frozen < 15s window (`pause`) → buffer, zero loss, **no** discontinuity |
| `scenarios/bee-outage-long` (B)  | bee crash > 15s window (`stop`) → **arms** a discontinuity, gap, clean resume |
| `scenarios/publish-stop-to-vod` (D) | clean broadcaster stop → immediate VOD finalize (unpublish webhook) |
| `scenarios/gateway-outage-viewer` (G) | viewer gateway down → uploads **unaffected** (independent path) |
| `scenarios/srs-engine-restart` (E) | SRS engine restart → orchestrator re-announces; a fresh `live` topic resumes (needs the PR #10 recovery fix deployed) |
| `scenarios/uploader-crash-recovery` (F) | uploader hard-crash (SIGKILL) → stream recovers from saved state and stays `live`, not VOD-ed at the 60s recovery timer (needs the PR #10 recovery fix deployed) |

Service coverage (happy path, no faults):

| File | Proves |
|------|--------|
| `service/happy-path` | gapless segments + advancing (non-frozen) manifest, no discontinuity |
| `service/health-endpoint` | `/health` activeStreams / engines / staleManifestStreams across live→idle |
| `service/catalog-via-gateway` | **player-visible**: a new `live` entry via the bee-gateway → flips to `vod` |
| `service/multi-stream-concurrent` | two concurrent live streams → distinct catalog topics, no spurious discontinuity, each finalizes to its own VOD |

### Execution model

Every scenario publishes to the **same** live path on the **same** profile, so the suite runs
**serially** (`--test-concurrency=1`) and each test's `before` calls `waitForIdle` (polls `/health`
until `activeStreams=0`) so a prior test's draining stream can't collide with "already active".

## Run

```bash
# safe, read-only: proves attach + stamp discovery against the deployed profile
pnpm --filter @streaming-infra-manager/e2e test:e2e:smoke

# full suite — publishes a real stream + stops real containers + burns real stamp.
# Serial, opt-in, NOT part of the fast unit CI.
pnpm --filter @streaming-infra-manager/e2e test:e2e
```

## Prerequisites

- `ssh <target>` works non-interactively (default target `manager-host`).
- `ffmpeg` on PATH (the SRT publisher / OBS stand-in).
- A deployed profile with a **usable stamp** (the smoke test checks TTL first).
