# Live Streaming Resilience — What We Support & How to Verify It

_Status: **10 / 10** automated failure tests passing (last run 2026-07-08)._

This system streams live video and stores it on Swarm (decentralized storage). It is built to **keep streaming through failures** — nodes crashing, services restarting, networks dropping — instead of falling over. This document has two parts:

- **[Part 1 — What we support](#part-1--what-we-support)** — plain-English resilience capabilities, for product and stakeholders.
- **[Part 2 — Verify it yourself by hand](#part-2--verify-it-yourself-by-hand)** — step-by-step drills you run while watching the player.

---

## Part 1 — What we support

The pipeline is: **broadcaster → media server → uploader → storage (Swarm) → viewer's player.** Failures can hit any link. Here is what the system does when they do, and what a viewer actually experiences.

| If this fails… | The system… | The viewer experiences… |
|---|---|---|
| **Storage stalls briefly** (a few seconds) | holds the data and catches up when it recovers — nothing lost | a brief pause, then normal playback — no missing content |
| **Storage goes down longer** (crash / restart) | skips only the piece it couldn't save, marks a clean cut, and resumes | a short skip, then playback continues — **it does not freeze forever** |
| **The uploader service crashes** mid-stream | automatically restarts and resumes the *same* stream from where it left off | the stream keeps going |
| **The encoder / ingest server restarts** | the broadcast reconnects and resumes on its own | the stream resumes |
| **The viewer's gateway goes offline** | broadcasting is completely unaffected; viewing returns when the gateway is back | a temporary "can't load," then recovery — the broadcast never stopped |
| **The broadcaster ends normally** | finalizes the stream into a replayable recording (VOD) | the live stream becomes a watchable recording |
| **Two broadcasters stream at once** | handles both independently, each with its own recording | both work, no interference |

**Every row above is verified automatically** by an end-to-end test suite that injects the *real* failure (kills real containers, drops real nodes) against a live deployment and checks the outcome. Current status: **10 / 10 passing.**

### One known limitation (honest note)

Under heavy upload load, the **directory of streams** (the "what's live / what's recorded" list a viewer browses) can take a **few minutes** to update. The video itself plays fine — only the *listing* lags, and it catches up on its own. This is a property of pushing everything through a single storage node's outbound queue; it is **not** a data-loss or playback problem. We are accepting it for now.

### Not covered yet (honest scope)

Resilience to the failures in the table above is proven. These **other** streaming concerns are **not** automated here, and we don't claim them:

- **Seeking / scrubbing** — jumping around the timeline of a live or recorded stream.
- **Volume & audio quality** — beyond "a tone is present and stays in sync."
- **Adaptive bitrate (ABR)** — multiple quality renditions and the player switching between them on the fly.
- **Viewer scale** — many simultaneous *viewers* (we verify two simultaneous *broadcasters*, which is a different axis).
- **Mid-stream join** — a viewer opening a stream that has already been live for a while and getting a correct starting window.
- **Soak / endurance** — multi-hour streams, stamp exhaustion over time, and memory growth under sustained load.

If it isn't a row in the table above, this suite doesn't verify it.

---

## Part 2 — Verify it yourself by hand

The idea: **open the player in a browser, start a stream, then trigger a failure from the terminal and watch what the player does.** Each drill below is "do this → watch the player → what pass looks like."

### What you need

- A **running deployment** of the stack (any profile, local or on a server).
- **`ffmpeg`** on your machine — it stands in for a broadcaster (OBS).
- A **web browser** — to watch as a viewer.
- **Terminal access to wherever the containers run** (`docker` locally, or `ssh` to the server).

### Step 0 — point the commands at your deployment

Nothing below is hardcoded to a specific machine. Set these once for *your* setup:

```bash
export HOST=localhost           # or the server's address/IP if it runs remotely
export PROFILE=<your-profile>   # the container-name prefix for your deployment

# How docker commands reach the containers:
export DOCKER="docker"              # if the stack runs on THIS machine
# export DOCKER="ssh <server> docker"   # if it runs on a remote server
```

Find your profile name and the ports it exposes:

```bash
$DOCKER ps --format '{{.Names}}\t{{.Ports}}' | grep "$PROFILE"
```

The containers are named `$PROFILE-<service>-1`. You'll act on these services:
`srs` (media server), `stream-uploader` (our service), `bee-uploader` (storage), `bee-gateway` (what viewers read through), `client` (the player web app).

From that `ps` output, note the **host** ports mapped to three services and set:

```bash
export SRT_PORT=<port mapped on the srs container's SRT/UDP port>
export CLIENT_URL=http://$HOST:<port mapped on the client container>
export UPLOADER_API=http://$HOST:<port mapped on the stream-uploader container>
```

Two handy watch commands (optional, for confirming what the player shows):

```bash
# Is a stream active right now? (immediate, authoritative)
curl -s $UPLOADER_API/health

# Live view of what the uploader is doing:
$DOCKER logs -f --tail 20 $PROFILE-stream-uploader-1
```

> **Remember the listing lag.** Anything you read in the **browser list** (or that a viewer sees appear/disappear) can trail by minutes under load. Anything from `$UPLOADER_API/health` or the uploader logs is **immediate**. When in doubt, trust the uploader.

### If your deployment runs OME instead of SRS

The drills below are written for **SRS** (the default engine). Against an **OME** deployment only three things change; everything else is identical:

- **The publish URL** (Step 1 and Drill 7) — OME carries the app/stream path as a full URL inside the streamid:

  ```bash
  # OME: app is `video` or `audio` (use video/stream, and video/stream2 for the second stream)
  -f mpegts "srt://$HOST:$SRT_PORT?streamid=srt://$HOST:$SRT_PORT/video/stream"
  ```

- **The media server** you restart in Drill 4 is the `ome` container (a standalone singleton), not `$PROFILE-srs-1`.
- `curl -s $UPLOADER_API/health` reports `engines: ["ome"]` instead of `["srs"]`.

> ⚠️ The exact OME publish-URL form is confirmed during the live OME bring-up. If your ffmpeg handshake is refused, check the `ome` container's logs — some builds want the inner URL percent-encoded.

The automated suite makes this switch for you with `E2E_ENGINE=ome` (see the engine matrix in [`e2e/README.md`](../../e2e/README.md)).

### Step 1 — start a stream and watch it

**Publish** a test pattern with tone (leave this terminal running):

```bash
ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 128k \
  -f mpegts "srt://$HOST:$SRT_PORT?streamid=#!::r=live/stream,m=publish"
```

**Watch:** open `$CLIENT_URL` in your browser and click the live stream.
**Expect:** within a few seconds it appears and plays a moving test pattern with a steady tone, smoothly.

Now run the drills below **without stopping ffmpeg or closing the player** (except the "clean stop" drill, which stops ffmpeg on purpose).

---

### Drill 1 — brief storage blip _(recoverable freeze)_

Freeze the storage node for ~8 seconds, then release it:

```bash
$DOCKER pause $PROFILE-bee-uploader-1 && sleep 8 && $DOCKER unpause $PROFILE-bee-uploader-1
```

- **Watch the player:** playback may buffer for a moment, then continues.
- **Pass:** playback resumes with **no skip** and no missing content. _(automated: `bee-outage-short`)_

### Drill 2 — storage crash _(longer outage)_

Take the storage node fully down for ~25 seconds, then bring it back:

```bash
$DOCKER stop $PROFILE-bee-uploader-1 && sleep 25 && $DOCKER start $PROFILE-bee-uploader-1
```

- **Watch the player:** it stalls briefly, then **skips over the missing few seconds** and keeps playing.
- **Pass:** playback continues after a short skip — it does **not** hang forever. The uploader logs show it resuming within seconds of the node returning. _(automated: `bee-outage-long`)_

### Drill 3 — uploader service crash & recovery

Hard-kill our uploader service and bring it straight back (keep ffmpeg running):

```bash
$DOCKER kill $PROFILE-stream-uploader-1 && sleep 2 && $DOCKER start $PROFILE-stream-uploader-1
```

- **Watch the logs:** `$DOCKER logs --tail 40 $PROFILE-stream-uploader-1` should show `Recovered stream …` then `Segments resumed …; cancelled recovery finalize timer`.
- **Confirm:** a minute later, `curl -s $UPLOADER_API/health` still shows `activeStreams` ≥ 1.
- **Pass:** the **same** stream keeps running — it is recovered from disk, not dropped or restarted as a new one. _(automated: `uploader-crash-recovery`)_

### Drill 4 — encoder / ingest restart

Restart the media server (keep ffmpeg running — it will reconnect):

```bash
$DOCKER restart $PROFILE-srs-1
```

- **Watch the player / list:** the broadcast reconnects and resumes on its own (it may reappear as a fresh live entry).
- **Pass:** streaming resumes with no manual intervention. _(automated: `srs-engine-restart`)_

### Drill 5 — viewer's gateway goes down

Take down the node the viewer reads through, watch the player, then restore it:

```bash
$DOCKER stop $PROFILE-bee-gateway-1
# watch the browser fail to load new content for a bit, then:
$DOCKER start $PROFILE-bee-gateway-1
```

- **Watch:** the **viewer** side is affected (player can't load), but the broadcast never stops — `$UPLOADER_API/health` stays `activeStreams` ≥ 1 the whole time.
- **Pass:** uploading is unaffected; the viewer recovers once the gateway is back. _(automated: `gateway-outage-viewer`)_

### Drill 6 — clean stop becomes a recording (VOD)

Stop the broadcaster normally (press `Ctrl-C` in the ffmpeg terminal).

- **Watch the list:** the stream ends and, after it catches up, appears as a **recording** you can replay.
- **Pass:** the entry changes from *live* to a watchable *recording* with a real duration. _(Give it a few minutes — this is the listing lag from Part 1.)_ _(automated: `publish-stop-to-vod`)_

### Drill 7 — two streams at once

With one stream already running, start a second one in a new terminal (note `stream2`):

```bash
ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 128k \
  -f mpegts "srt://$HOST:$SRT_PORT?streamid=#!::r=live/stream2,m=publish"
```

- **Watch:** `$UPLOADER_API/health` shows `activeStreams: 2`; both appear in the list and play independently.
- **Pass:** two independent streams; stopping each produces its own recording. _(automated: `multi-stream-concurrent`)_

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Player never starts / nothing in the list | broadcaster didn't connect — check the `ffmpeg` output and that `$SRT_PORT`/`$HOST` are right; confirm the `srs` container is up |
| New stream or "now a recording" is slow to show | the listing lag (Part 1) — expected under load; confirm it's really live via `$UPLOADER_API/health` first |
| `activeStreams` never returns to 0 after stopping | the recording is still being finalized; give it up to a few minutes |
| A drill "fails" only in the browser but `/health` looks right | you're seeing the listing lag, not a real failure — trust `/health` and the uploader logs |

## For engineers

The automated suite that proves all of this — how it's structured and how to run it — is documented in [`e2e/README.md`](../../e2e/README.md). Run it with `pnpm test:e2e` from the `e2e/` folder (expect 10/10 failure/service tests; the storage/recording drills are the slow ones because of the listing lag). A few specifics worth knowing:

- **Attach-only.** The suite **attaches** to an already-running deployment over `ssh` and injects faults; it never deploys a stack or spends BZZ to stand one up (`E2E_MODE=deploy` is intentionally not implemented). Point it at your profile via `e2e/.env` — copy [`e2e/.env.example`](../../e2e/.env.example).
- **Chequebook preflight.** Before any stream is published, `preflight/chequebook-funding` checks the uploader node's chequebook holds ≥ 0.5 BZZ and tops up from the wallet if it can — so the run fails fast, and burns no stamp, on an underfunded node.
- **SRS or OME.** `E2E_ENGINE=srs` (default) or `ome` switches the whole suite between media engines — it adapts the SRT streamid it publishes, the log markers it asserts, and the expected `/health.engines` value. The per-engine matrix is in [`e2e/README.md`](../../e2e/README.md).
