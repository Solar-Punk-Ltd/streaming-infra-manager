#!/bin/sh
# The browser suites on the machine the runner actually is, so a failure only
# the runner sees can be reproduced here instead of by another billed push.
#
# Three runner-shaped failures reached main before this existed, each costing a
# round trip of about twelve billed minutes to see and another to test a guess
# at. The fourth was reproduced here in minutes, at about one run in three.
#
# Run from the repository root:
#   sh frontend/test/docker/browser-on-two-cores.sh                 # every suite
#   sh frontend/test/docker/browser-on-two-cores.sh pool-draft-browser.test.mjs
#
# --cpuset-cpus pins two real cores. --cpus would grant two cores of time while
# nproc still answered with this laptop's count, and Vite and esbuild start a
# worker per reported core, which builds a machine far harsher than the runner
# and fails suites the runner passes.
# --shm-size because Docker's default 64 MB /dev/shm is not enough for Chrome.
# --security-opt seccomp=unconfined --cap-add=SYS_ADMIN so Chrome's own sandbox
# can make the namespaces it wants, rather than passing --no-sandbox.
# --init so a killed grandchild is reaped rather than left a zombie.
#
# The checkout is copied in, never mounted writable, so nothing here is touched.
# The connected transfer suite needs PostgreSQL and is not served one, so it
# skips and the runner refuses it. That one refusal is expected here.
set -e

SUITE="$1"
NAME=browser-two-cores
IMAGE=node:22-bookworm

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --rm -d --name "$NAME" \
  --cpuset-cpus=0,1 --memory=7g \
  --shm-size=2g --init \
  --security-opt seccomp=unconfined --cap-add=SYS_ADMIN \
  -v "$PWD":/src:ro -w /tmp/w "$IMAGE" sleep infinity >/dev/null

docker exec "$NAME" sh -lc '
  mkdir -p /tmp/w && cd /src &&
  tar cf - --exclude=./node_modules --exclude=./.git --exclude=./.scratch \
      --exclude=./manager/swarm-hls-stream --exclude="*/node_modules" --exclude=".env*" . \
    | (cd /tmp/w && tar xf -)'

# Chromium from the distribution, which tracks the same major as the runner's
# Chrome. The suites print the build they drove, so a divergence is visible.
docker exec "$NAME" sh -lc 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium >/dev/null && chromium --version'
docker exec "$NAME" sh -lc 'cd /tmp/w && corepack enable && pnpm install --frozen-lockfile 2>&1 | tail -1'
docker exec "$NAME" sh -lc 'cd /tmp/w && pnpm --filter @streaming-infra-manager/common build >/dev/null && chown -R node:node /tmp/w'
docker exec "$NAME" sh -lc 'echo "cores: $(nproc)"'

# Detached, with the log inside the container, so the run survives the shell
# that started it. Follow it with:
#   docker exec browser-two-cores tail -f /tmp/browser.log
if [ -n "$SUITE" ]; then
  RUN="node --import tsx --conditions=development --test --test-reporter=tap test/$SUITE"
  DIR=/tmp/w/frontend
else
  RUN="pnpm --filter @streaming-infra-manager/frontend-prototype test:browser"
  DIR=/tmp/w
fi
docker exec -u node -e CHROME_BIN=/usr/bin/chromium "$NAME" \
  sh -lc "cd $DIR && rm -rf /tmp/w/frontend/node_modules/.vite-t09 && $RUN"
