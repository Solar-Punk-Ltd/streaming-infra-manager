#!/usr/bin/env bash
# The shared image race (R04), reproduced and closed, in isolation.
#
# Two Compose projects build one image name. Compose creates a container by
# tag name, so a build that finishes and moves the tag while the other
# project is between its own build and its container creation puts one
# project's content under the other's container. The stack names its built
# images `stream-uploader` and `stream-client`, one tag for every deployment.
#
# Three things run here, all on throwaway projects and images of this run:
#
#   1. The controlled interleaving: project a builds, project b builds and
#      creates, then a creates without building. Deterministic: a's container
#      runs b's content under the shared tag, and its own content under a
#      per-project name.
#   2. The bounded control: both projects run `up -d --build --force-recreate`
#      at once, for a number of rounds with random build delays, under the
#      shared tag. The wrong-content count is reported. It is a control, not
#      an assertion: the race is a window, and a run that never hits it says
#      so rather than failing.
#   3. The corrected variant: the same rounds with the `image:` line removed,
#      so compose names each build after its project. Zero wrong content is
#      asserted, and a missing container or a failed build is classified apart
#      from wrong content.
#
# Every container is checked by subprocess exit code and exact content: the
# WHO and the NONCE the build was given. Never on the host, never on a shared
# daemon: run it on a laptop or in CI's Docker job.
#
# Usage: bash manager/test/docker/shared-image-race.sh [rounds]
set -u

ROUNDS="${1:-10}"
RUN="imgrace-$$"
WORK="$(mktemp -d)"
IMAGE="$RUN-shared"
PROJECT_A="${RUN}a"
PROJECT_B="${RUN}b"
WRONG_CONTROL=0
WRONG_FIXED=0
MISSING_FIXED=0
FAILED_FIXED=0

cleanup() {
  for p in "$PROJECT_A" "$PROJECT_B"; do
    for f in shared fixed; do
      docker compose -p "$p" -f "$WORK/$f.yml" down --rmi local -v --remove-orphans >/dev/null 2>&1 || true
    done
  done
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null), compose: $(docker compose version --short 2>/dev/null)"

cat > "$WORK/Dockerfile" <<'DF'
FROM alpine:3.20
ARG WHO
ARG NONCE
ARG DELAY=0
RUN sleep "$DELAY" && printf '%s %s\n' "$WHO" "$NONCE" > /who
CMD ["sleep", "300"]
DF

# The shared tag, as the stack has it, and the corrected file without it.
cat > "$WORK/shared.yml" <<YML
services:
  app:
    image: $IMAGE
    build:
      context: .
      args:
        WHO: \${WHO}
        NONCE: \${NONCE}
        DELAY: \${DELAY:-0}
YML
cat > "$WORK/fixed.yml" <<'YML'
services:
  app:
    build:
      context: .
      args:
        WHO: ${WHO}
        NONCE: ${NONCE}
        DELAY: ${DELAY:-0}
YML

# What the project's container says, or a classification when it cannot say.
content_of() {
  local project="$1" ids
  ids="$(docker ps -a -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=app")"
  [ -n "$ids" ] || { echo "missing"; return; }
  docker exec "$(echo "$ids" | head -1)" cat /who 2>/dev/null || echo "unreadable"
}

up() {
  local project="$1" file="$2" who="$3" nonce="$4" delay="$5"
  WHO="$who" NONCE="$nonce" DELAY="$delay" docker compose -p "$project" -f "$WORK/$file" up -d --build --force-recreate >/dev/null 2>&1
}

# --- 1. the controlled interleaving --------------------------------------
echo "== controlled interleaving"
nonce="ctl-$RANDOM"
WHO=a NONCE="$nonce" docker compose -p "$PROJECT_A" -f "$WORK/shared.yml" build >/dev/null 2>&1 || fail "a could not build"
up "$PROJECT_B" shared.yml b "$nonce" 0 || fail "b could not come up"
WHO=a NONCE="$nonce" docker compose -p "$PROJECT_A" -f "$WORK/shared.yml" up -d --force-recreate >/dev/null 2>&1 || fail "a could not create without a build"
got="$(content_of "$PROJECT_A")"
echo "shared tag, a created after b built: a's container says '$got' (expected the race: 'b $nonce')"
[ "$got" = "b $nonce" ] || echo "note: the deterministic case did not reproduce on this compose, recorded as is"
docker compose -p "$PROJECT_A" -f "$WORK/shared.yml" down -v >/dev/null 2>&1
docker compose -p "$PROJECT_B" -f "$WORK/shared.yml" down -v >/dev/null 2>&1

WHO=a NONCE="$nonce" docker compose -p "$PROJECT_A" -f "$WORK/fixed.yml" build >/dev/null 2>&1 || fail "a could not build (fixed)"
up "$PROJECT_B" fixed.yml b "$nonce" 0 || fail "b could not come up (fixed)"
WHO=a NONCE="$nonce" docker compose -p "$PROJECT_A" -f "$WORK/fixed.yml" up -d --force-recreate >/dev/null 2>&1 || fail "a could not create without a build (fixed)"
got="$(content_of "$PROJECT_A")"
echo "per-project name, same order: a's container says '$got' (expected 'a $nonce')"
[ "$got" = "a $nonce" ] || fail "the corrected variant put wrong content under a's container in the controlled interleaving"
docker compose -p "$PROJECT_A" -f "$WORK/fixed.yml" down -v >/dev/null 2>&1
docker compose -p "$PROJECT_B" -f "$WORK/fixed.yml" down -v >/dev/null 2>&1

# --- 2 and 3. the rounds -------------------------------------------------
rounds() {
  local file="$1" label="$2" wrong=0 missing=0 failed=0 round nonce delay_a delay_b got_a got_b
  for round in $(seq 1 "$ROUNDS"); do
    nonce="$label-$round-$RANDOM"
    delay_a=$((RANDOM % 3)); delay_b=$((RANDOM % 3))
    up "$PROJECT_A" "$file" a "$nonce" "$delay_a" & pa=$!
    up "$PROJECT_B" "$file" b "$nonce" "$delay_b" & pb=$!
    wait $pa; ea=$?; wait $pb; eb=$?
    if [ "$ea" -ne 0 ] || [ "$eb" -ne 0 ]; then failed=$((failed + 1)); continue; fi
    got_a="$(content_of "$PROJECT_A")"; got_b="$(content_of "$PROJECT_B")"
    for pair in "a:$got_a" "b:$got_b"; do
      who="${pair%%:*}"; got="${pair#*:}"
      case "$got" in
        "$who $nonce") ;;
        missing|unreadable) missing=$((missing + 1)) ;;
        *) wrong=$((wrong + 1)); echo "round $round: $who's container says '$got', expected '$who $nonce'" ;;
      esac
    done
  done
  echo "$label: $ROUNDS rounds, $((ROUNDS * 2)) creations, wrong content $wrong, missing $missing, failed builds $failed"
  echo "$wrong $missing $failed"
}

echo "== the bounded control, shared tag"
control="$(rounds shared.yml control)"
echo "$control" | sed '$d'
read -r WRONG_CONTROL _ _ <<< "$(echo "$control" | tail -1)"
echo "== the corrected variant, per-project image names"
result="$(rounds fixed.yml fixed)"
echo "$result" | sed '$d'
read -r WRONG_FIXED MISSING_FIXED FAILED_FIXED <<< "$(echo "$result" | tail -1)"

echo "control reproduced the race in this run: $([ "$WRONG_CONTROL" -gt 0 ] && echo yes || echo 'no, the window was not hit')"
[ "$WRONG_FIXED" -eq 0 ] || fail "the corrected variant put wrong content under a container $WRONG_FIXED time(s)"
[ "$MISSING_FIXED" -eq 0 ] || fail "the corrected variant left $MISSING_FIXED container(s) missing or unreadable"
[ "$FAILED_FIXED" -eq 0 ] || fail "the corrected variant had $FAILED_FIXED failed build(s)"
echo "PASS: per-project image names ran $((ROUNDS * 2)) creations with their own content every time"
