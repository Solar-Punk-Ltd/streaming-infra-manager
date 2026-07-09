# e2e — streaming failure-scenario tests

End-to-end / fault-injection tests that drive the **real** stack (media engine → stream-uploader → bee →
Swarm → gateway → viewer) and inject failures, to prove PR #10's integrity + segment-continuity
behaviour. Unit tests live in the packages; this is the layer above them.

## Modes

- **attach** (default) — connect to an **already-deployed** profile (e.g. `srs-check-test1`) over
  `ssh`, discover its live stamp, and inject faults with `docker stop/start/pause`. No deploy, no
  BZZ. Mirrors the manual `docker stop bee-uploader; sleep 8; docker start` flow.
- **deploy** — _not implemented yet_. Setting `E2E_MODE=deploy` errors out on purpose; deploy the
  profile yourself (or via the manager) and attach to it.

**Setup — point the suite at your deployment.** Copy the env template and edit it; `.env` is
git-ignored and shell-exported vars override it:

```bash
cp .env.example .env    # then set E2E_PROFILE, E2E_PUBLIC_HOST, E2E_ENGINE, E2E_PORT_SLOT, …
```

Every knob is an `E2E_*` var documented inline in [`.env.example`](./.env.example); the defaults it
falls back to live in [`config.ts`](./config.ts).

## Layout

```
harness/    shared helpers (host ssh, publisher, viewer catalog, engine profiles, log assertions)
smoke/      read-only attach + stamp-discovery check (safe anytime)
preflight/  pre-run gates (chequebook funding) — run before any stream is published
scenarios/  the fault-injection matrix
service/    whole-service coverage (no faults)
```

### The suite

Preflight (gates that run first, before any stream is published):

| File | Proves |
|------|--------|
| `preflight/chequebook-funding` | the uploader node's chequebook holds ≥ 0.5 BZZ — tries to top up from the node's wallet if short, **fails** if it can't |

Fault scenarios (publish a real stream, then inject a fault):

| File | Proves |
|------|--------|
| `scenarios/bee-outage-short` (A) | bee frozen < 15s window (`pause`) → buffer, zero loss, **no** discontinuity |
| `scenarios/bee-outage-long` (B)  | bee crash > 15s window (`stop`) → **arms** a discontinuity, gap, clean resume |
| `scenarios/publish-stop-to-vod` (D) | clean broadcaster stop → immediate VOD finalize (unpublish webhook) |
| `scenarios/gateway-outage-viewer` (G) | viewer gateway down → uploads **unaffected** (independent path) |
| `scenarios/engine-restart` (E) | media-engine restart (SRS or OME) → orchestrator re-announces; a fresh `live` topic resumes (needs the PR #10 recovery fix deployed) |
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

### Engines

The suite runs against either media engine, selected by `E2E_ENGINE` (default `srs`):

| | SRS (default) | OME |
|---|---|---|
| SRT streamid | `#!::r=<path>,m=publish` | full `srt://host:port/<app>/<stream>` URL |
| default stream path | `live/stream` | `video/stream` (app is `video`/`audio`) |
| lifecycle markers | `[SRS] Stream published/unpublished` | `[OME] Stream opening/closing` |
| `/health.engines` | `['srs']` | `['ome']` |
| restart target (scenario E) | `<profile>-srs-1` | `ome` (standalone singleton) |

Only `E2E_ENGINE` / `E2E_STREAM_PATH` and — OME only — `E2E_OME_SRT_PORT` / `E2E_OME_CONTAINER`
change between engines; everything asserted downstream (catalog, VOD finalize, `/health` shape) is
engine-independent. The per-engine differences live in one file, [`harness/engine.ts`](./harness/engine.ts).

> ⚠️ The OME SRT streamid form above is confirmed during the live OME bring-up; if OME needs
> percent-encoding it is a one-line change in `harness/engine.ts`.

## Run

```bash
# safe, read-only: proves attach + stamp discovery against the deployed profile
pnpm --filter @streaming-infra-manager/e2e test:e2e:smoke

# full suite — publishes a real stream + stops real containers + burns real stamp.
# Serial, opt-in, NOT part of the fast unit CI.
pnpm --filter @streaming-infra-manager/e2e test:e2e
```

The full run executes `preflight/ → scenarios/ → service/` in that order, serially — the chequebook
gate fails fast before any stream is published (and before any stamp is burned).

## Prerequisites

- `ssh <target>` works non-interactively (default target `manager-host`).
- `ffmpeg` on PATH (the SRT publisher / OBS stand-in).
- A deployed profile with a **usable stamp** (the smoke test checks TTL first).
- The uploader node's **chequebook funded to ≥ 0.5 BZZ** (the `preflight/chequebook-funding` gate
  checks this and tops up from the node's wallet if it can).
