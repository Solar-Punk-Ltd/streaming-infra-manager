#!/usr/bin/env bash
# T02: the real SRS parser on eight files at once, each differing in one
# directive.
#
# What it proves: the manager's own config check, with its own command runner
# and the deployment's own image, answers eight concurrent questions
# separately. Four files that differ in one directive value are accepted, four
# that break a different directive each are refused, every refusal names the
# directive of its own file and none of the other three, and the scratch
# directory is empty when the eight are done. A check that read another
# check's copy would refuse with a directive the operator cannot find in the
# file in front of them, which reads exactly like a real refusal.
#
# What it does not prove: that any of these files would run. Nothing is
# started here, only parsed, and the engine that parses a file is not the
# engine that has to stay up on it. That is T01.
#
# Usage, from the repository root, with the stack submodule checked out:
#   bash manager/test/docker/srs-check-isolation.sh
# Exit 0 on pass, 1 on a wrong answer, 2 on a harness problem. Needs docker and
# the image below. No funds, no host, no network beyond the image: every check
# container runs with --network none.
#
# Evidence, 2026-09-10, this laptop, arm64, Docker 29.7.2, on the digest below:
# PASS. Eight checks at once, four accepted, four refused, each refusal naming
# only its own directive, scratch directory empty. Wall time 2 s.
#
# Re-run the same day on the corrected pin, after the first one turned out to
# name a real image in this repository that no tag points at any more. PASS
# again, wall time 2 s, and the four refusal strings came back word for word
# the ones test/unit/srsCheckIsolation.test.ts records.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STACK="$ROOT/manager/swarm-hls-stream"
# ossrs/srs:6 resolved to this manifest list on 2026-09-10. The stack runs the
# same tag, so the parser here is the parser a deployment gets.
IMAGE="${SRS_CHECK_IMAGE:-ossrs/srs@sha256:2be08a0fe28737bf28bae8a575bb5776e09b620366dd1e62dd4f8a41cf4310f3}"

if [ ! -f "$STACK/engines/srs/srs.conf.template" ] || [ ! -f "$STACK/engines/srs/entrypoint.sh" ]; then
  echo "FAIL: the stack submodule is not checked out at $STACK (git submodule update --init)" >&2
  exit 2
fi

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null || {
  echo "FAIL: could not get $IMAGE" >&2
  exit 2
}

echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
exec "$ROOT/manager/node_modules/.bin/tsx" --conditions=development \
  "$ROOT/manager/test/docker/srsCheckIsolation.ts" "$STACK" "$IMAGE"
