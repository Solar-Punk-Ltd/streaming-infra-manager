#!/usr/bin/env bash
# The OvenMediaEngine integration gate: SRT in, admission webhook out, HLS
# playlist served. No funds, no Swarm, no host: everything runs in throwaway
# containers on a private Docker network, and the uploader is a fake that
# answers the admission webhook the way the stack's uploader does, with the
# signature checked.
#
# What it proves: the pinned engine image and this stack's template, rendered
# by this stack's entrypoint, admit an SRT publisher through the webhook the
# uploader listens on, sign the admission request with the secret the
# entrypoint substitutes, and publish a media playlist on the port and path
# the uploader polls. That is the contract the manager's OME config check
# protects. T22 verifies Swarm delivery on top of this later.
#
# Usage, from the repository root, with the stack submodule checked out:
#   bash manager/test/docker/ome-admission-gate.sh
# Exit code 0 on pass. Needs docker and outbound network for the three images.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STACK="$ROOT/manager/swarm-hls-stream"
# latest resolved to v0.21.0 on 2026-09-08, and this digest is that manifest list.
IMAGE="${OME_GATE_IMAGE:-airensoft/ovenmediaengine@sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6}"
RUN="ome-gate-$$"
NET="$RUN"
SECRET="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
[ "${#SECRET}" -eq 32 ] || { echo "FAIL: could not draw a secret from /dev/urandom" >&2; exit 2; }
PUBLISH_SECONDS=25
PLAYLIST_WAIT_SECONDS=40
CLOSING_WAIT_SECONDS=20

if [ ! -f "$STACK/engines/ome/Server.xml.template" ] || [ ! -f "$STACK/engines/ome/entrypoint.sh" ]; then
  echo "FAIL: the stack submodule is not checked out at $STACK (git submodule update --init)" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$RUN-ome" "$RUN-uploader" "$RUN-publisher" "$RUN-poll" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

docker network create "$NET" >/dev/null || fail "could not create the network"

# One long-lived busybox on the gate's network answers every poll, so a poll
# costs a request and not a container, and the loops' seconds are seconds.
docker run -d --name "$RUN-poll" --network "$NET" alpine:3.20 sleep 600 >/dev/null || fail "could not start the poller"
on_net() { docker exec "$RUN-poll" "$@"; }

# The fake uploader: the admission route, signature checked the way the
# stack's uploader checks it, every call kept and served back at /calls.
docker run -d --name "$RUN-uploader" --network "$NET" --network-alias uploader \
  -e "OME_ADMISSION_SECRET=$SECRET" node:22-alpine node -e '
const http = require("node:http");
const { createHmac, timingSafeEqual } = require("node:crypto");
const secret = process.env.OME_ADMISSION_SECRET;
const calls = [];
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/calls") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method !== "POST" || req.url !== "/engines/ome/admission") {
    calls.push({ ok: false, why: `unexpected ${req.method} ${req.url}` });
    res.statusCode = 404; res.end(); return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const expected = Buffer.from(createHmac("sha1", secret).update(raw).digest("base64url"));
    const received = Buffer.from(req.headers["x-ome-signature"] ?? "");
    const signed = received.length === expected.length && timingSafeEqual(received, expected);
    let request = null;
    try { request = JSON.parse(raw.toString("utf8")).request ?? null; } catch {}
    calls.push({ ok: signed, direction: request?.direction, status: request?.status, url: request?.url, protocol: request?.protocol });
    res.setHeader("content-type", "application/json");
    if (!signed) { res.statusCode = 401; res.end(JSON.stringify({ allowed: false, reason: "invalid signature" })); return; }
    res.end(JSON.stringify({ allowed: true, lifetime: 0, reason: "ok" }));
  });
}).listen(3000, () => console.log("fake uploader listening on 3000"));
' >/dev/null || fail "could not start the fake uploader"
for _ in $(seq 1 20); do
  if on_net wget -q -O - -T 2 http://uploader:3000/calls >/dev/null 2>&1; then break; fi
  sleep 1
done
on_net wget -q -O - -T 2 http://uploader:3000/calls >/dev/null 2>&1 || {
  docker logs "$RUN-uploader" 2>&1 | tail -10 >&2
  fail "the fake uploader did not answer within 20 s"
}
echo "fake uploader up"

# The engine, run the way the stack runs it: this template, this entrypoint,
# the substitutions from the environment, nothing published on the host.
docker run -d --name "$RUN-ome" --network "$NET" --network-alias ome \
  -e OME_ADAPTER_HOST=uploader -e OME_ADAPTER_PORT=3000 -e "OME_ADMISSION_SECRET=$SECRET" \
  -e HLS_SEGMENT_DURATION=2 -e HLS_SEGMENT_COUNT=5 \
  -v "$STACK/engines/ome/Server.xml.template:/opt/ovenmediaengine/conf-template/Server.xml.template:ro" \
  -v "$STACK/engines/ome/entrypoint.sh:/opt/ovenmediaengine/conf-template/entrypoint.sh:ro" \
  --entrypoint /bin/bash "$IMAGE" /opt/ovenmediaengine/conf-template/entrypoint.sh >/dev/null \
  || fail "could not start the engine"

for _ in $(seq 1 30); do
  if docker logs "$RUN-ome" 2>&1 | grep -q "SrtProvider is listening"; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$RUN-ome")" != "true" ]; then
    docker logs "$RUN-ome" 2>&1 | tail -20 >&2
    fail "the engine exited before it listened for SRT"
  fi
  sleep 1
done
docker logs "$RUN-ome" 2>&1 | grep -q "SrtProvider is listening" || fail "the engine did not listen for SRT within 30 s"
echo "engine up: $(docker logs "$RUN-ome" 2>&1 | grep -o 'SrtProvider is listening on [^ ]*' | head -1)"

# The publisher: a generated picture and tone, sent as MPEG-TS over SRT to
# the video application, the stream id in the form OvenMediaEngine reads.
docker run -d --name "$RUN-publisher" --network "$NET" alpine:3.20 sh -c "
  apk add -q ffmpeg >/dev/null 2>&1 &&
  ffmpeg -hide_banner -loglevel warning -re \
    -f lavfi -i testsrc=size=320x240:rate=15 -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t $PUBLISH_SECONDS -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p \
    -c:a aac -b:a 64k -f mpegts \
    'srt://ome:10080?streamid=srt%3A%2F%2Fome%3A10080%2Fvideo%2Fgate&pkt_size=1316'
" >/dev/null || fail "could not start the publisher"
sleep 5
[ "$(docker inspect -f '{{.State.Running}}' "$RUN-publisher")" = "true" ] || {
  docker logs "$RUN-publisher" 2>&1 | tail -10 >&2
  fail "the publisher exited within 5 s of starting"
}
echo "publisher running"

# The playlist the uploader polls: the master at ts:playlist.m3u8, then the
# media playlist it names, with at least one segment in it.
media=""
for _ in $(seq 1 "$PLAYLIST_WAIT_SECONDS"); do
  master="$(on_net wget -q -O - -T 2 http://ome:8081/video/gate/ts:playlist.m3u8 2>/dev/null || true)"
  if printf '%s' "$master" | grep -q '^#EXTM3U'; then
    variant="$(printf '%s' "$master" | grep -v '^#' | grep -m1 '\.m3u8')"
    [ -n "$variant" ] || variant="ts:playlist.m3u8"
    case "$variant" in
      http*) url="$variant" ;;
      /*) url="http://ome:8081$variant" ;;
      *) url="http://ome:8081/video/gate/$variant" ;;
    esac
    media="$(on_net wget -q -O - -T 2 "$url" 2>/dev/null || true)"
    if printf '%s' "$media" | grep -q '^#EXTINF'; then break; fi
  fi
  sleep 1
done
printf '%s' "$media" | grep -q '^#EXTINF' || {
  echo "--- engine log tail ---" >&2; docker logs "$RUN-ome" 2>&1 | tail -30 >&2
  echo "--- publisher log tail ---" >&2; docker logs "$RUN-publisher" 2>&1 | tail -10 >&2
  fail "no media playlist with a segment within $PLAYLIST_WAIT_SECONDS s"
}
segments="$(printf '%s' "$media" | grep -c '^#EXTINF')"
echo "playlist served: $segments segment(s) in the media playlist"

calls="$(on_net wget -q -O - -T 2 http://uploader:3000/calls 2>/dev/null || true)"
printf '%s' "$calls" | grep -q '"ok":true,"direction":"incoming","status":"opening","url":"[^"]*/video/gate' \
  || { echo "admission calls: $calls" >&2; fail "no signed, incoming, opening admission call for video/gate"; }
printf '%s' "$calls" | grep -q '"ok":false' && { echo "admission calls: $calls" >&2; fail "an admission call failed the signature check"; }
echo "admission: signed opening call received for video/gate"

# The publisher ends on its own, and the engine tells the uploader.
for _ in $(seq 1 $((PUBLISH_SECONDS + CLOSING_WAIT_SECONDS))); do
  calls="$(on_net wget -q -O - -T 2 http://uploader:3000/calls 2>/dev/null || true)"
  if printf '%s' "$calls" | grep -q '"status":"closing"'; then break; fi
  sleep 1
done
printf '%s' "$calls" | grep -q '"status":"closing"' || { echo "admission calls: $calls" >&2; fail "no closing admission call after the publisher ended"; }
echo "admission: closing call received"
echo "admission calls: $calls"
echo "PASS: SRT in, signed admission out, HLS playlist served, on $IMAGE"
