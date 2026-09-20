#!/usr/bin/env bash
# Stages a manager candidate beside the legacy checkout, then hands the exact
# candidate to the independently installed release guard.

set -euo pipefail

SSH_TARGET="${1:-viewer}"
if [[ "$SSH_TARGET" == -* ]]; then
    echo "ERROR: the ssh target must not start with a dash (got: $SSH_TARGET)" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="manager/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy manager/.env.sample and fill in the required values." >&2
    exit 1
fi
if ! grep -Eq '^POSTGRES_PASSWORD=.+$' "$ENV_FILE"; then
    echo "ERROR: POSTGRES_PASSWORD is missing or empty in $ENV_FILE." >&2
    exit 1
fi

MANAGER_DOMAIN="$(
    sed -n 's/^MANAGER_DOMAIN=//p' "$ENV_FILE" |
        tail -n 1 |
        tr -d '\r' |
        tr '[:upper:]' '[:lower:]' |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
        sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
)"
HOSTNAME_PATTERN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
if [ -n "$MANAGER_DOMAIN" ] && ! [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]; then
    echo "ERROR: MANAGER_DOMAIN in $ENV_FILE is not a host name: '${MANAGER_DOMAIN}'." >&2
    exit 1
fi

MANAGER_COMMIT="$(git rev-parse HEAD)"
STACK_COMMIT="$(git rev-parse HEAD:manager/swarm-hls-stream)"
RELEASES_ROOT="/home/solarpunk/streaming-infra-manager-releases/manager"
INCOMING_ROOT="${RELEASES_ROOT}/.incoming-${MANAGER_COMMIT}-$$"

echo "==> Preparing isolated manager candidate"
ssh "$SSH_TARGET" bash -s -- "$RELEASES_ROOT" "$INCOMING_ROOT" <<'REMOTE'
set -euo pipefail
RELEASES_ROOT="$1"
INCOMING_ROOT="$2"
mkdir -p -m 700 "$RELEASES_ROOT"
if [ -e "$INCOMING_ROOT" ]; then
    echo "ERROR: manager candidate staging path already exists" >&2
    exit 1
fi
mkdir -m 700 "$INCOMING_ROOT"
REMOTE

rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.scratch/' \
    --exclude 'manager/swarm-hls-stream/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    ./ "${SSH_TARGET}:${INCOMING_ROOT}/"

echo "==> Guarding manager transition"
ssh "$SSH_TARGET" bash -s -- \
    "$INCOMING_ROOT" "$RELEASES_ROOT" "$MANAGER_COMMIT" "$STACK_COMMIT" <<'REMOTE'
set -euo pipefail
INCOMING_ROOT="$1"
RELEASES_ROOT="$2"
MANAGER_COMMIT="$3"
STACK_COMMIT="$4"
GUARD_BIN="${HOME}/.local/bin/streaming-release-guard"
GUARD_STATE_ROOT="${HOME}/.local/state/streaming-release-guard"

if [ ! -x "$GUARD_BIN" ]; then
    echo "ERROR: the external release guard is not installed" >&2
    exit 1
fi
: "${RELEASE_GUARD_ADMIN_URL:?the guard admin URL is not routed into this process}"
: "${RELEASE_GUARD_ADMIN_TOKEN:?the guard admin token is not routed into this process}"

printf '%s\n' "$MANAGER_COMMIT" > "${INCOMING_ROOT}/.release-commit"
printf '%s\n' "$STACK_COMMIT" > "${INCOMING_ROOT}/manager/.stack-commit"
CANDIDATE_DIGEST="$("$GUARD_BIN" digest --candidate-root "$INCOMING_ROOT")"
CANDIDATE_ROOT="${RELEASES_ROOT}/${CANDIDATE_DIGEST}"

reconcile_existing_candidate() {
    EXISTING_DIGEST="$("$GUARD_BIN" digest --candidate-root "$CANDIDATE_ROOT")"
    if [ "$EXISTING_DIGEST" != "$CANDIDATE_DIGEST" ]; then
        echo "ERROR: the manager release path is already bound to different content" >&2
        return 1
    fi
    rm -rf "$INCOMING_ROOT"
}

publish_candidate() {
    if [ -e "$CANDIDATE_ROOT" ]; then
        reconcile_existing_candidate
        return
    fi
    if mv --no-target-directory "$INCOMING_ROOT" "$CANDIDATE_ROOT"; then
        return
    fi
    if [ ! -e "$CANDIDATE_ROOT" ]; then
        echo "ERROR: the manager candidate could not be published" >&2
        return 1
    fi
    reconcile_existing_candidate
}

publish_candidate

WORK_ROOT="${GUARD_STATE_ROOT}/work/manager-${CANDIDATE_DIGEST}"
mkdir -p -m 700 "$WORK_ROOT"
"$GUARD_BIN" manager \
    --state-root "$GUARD_STATE_ROOT" \
    --candidate-root "$CANDIDATE_ROOT" \
    --work-root "$WORK_ROOT"
REMOTE

echo "==> Done. Manager release ${MANAGER_COMMIT} was verified by the installed guard."
if [ -n "$MANAGER_DOMAIN" ]; then
    echo "Public: https://${MANAGER_DOMAIN}"
fi
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
