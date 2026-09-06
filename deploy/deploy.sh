#!/usr/bin/env bash
# Deploy the streaming-infra-manager to a server via rsync + remote build.
#
#   ./deploy/deploy.sh [ssh-target]
#
# ssh-target defaults to `viewer` (configure in ~/.ssh/config). Example:
#   Host viewer
#     HostName <ip>
#     User solarpunk
#     LocalForward 8080 localhost:8080
#
# What it does:
#   1. Builds swarm-hls-stream locally so its dist/ artifacts ship over rsync
#      (the host docker daemon mounts those into sibling containers spawned
#      by the manager, so they must exist on the server filesystem).
#   2. rsyncs the repo to /home/solarpunk/streaming-infra-manager.
#      Excludes node_modules, build caches and .git. Both .env files (the
#      manager's and swarm-hls-stream's) DO ship, and --delete means this
#      checkout is the only source of truth for them.
#   3. SSHes in and runs `docker compose up -d --build --remove-orphans`.
#      Builds happen on the server, so the image tags match the server's
#      docker engine. With MANAGER_DOMAIN set, the `public` profile joins in
#      and starts the TLS edge. With it cleared, the edge is removed by name
#      and the removal is checked, because dropping a profile does not stop a
#      container already running under it.

set -euo pipefail

SSH_TARGET="${1:-viewer}"
REMOTE_PATH="/home/solarpunk/streaming-infra-manager"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Checking manager/.env"
ENV_FILE="manager/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy manager/.env.sample and fill in the required values." >&2
    exit 1
fi
if ! grep -q "POSTGRES_PASSWORD=.\+" "$ENV_FILE"; then
    echo "ERROR: POSTGRES_PASSWORD is missing or empty in $ENV_FILE." >&2
    exit 1
fi

# Compose trims the same value on the server and strips one pair of quotes, so
# a value like MANAGER_DOMAIN="manager.example.org" is a plain name to it. Trailing whitespace or a
# carriage return left the name looking set here, this script reporting success,
# and the edge restarting forever on an empty site address. Trim it the way
# Compose will, and refuse a name Caddy could not ask for a certificate for
# rather than finding out from the edge's logs.
MANAGER_DOMAIN="$(
    sed -n 's/^MANAGER_DOMAIN=//p' "$ENV_FILE" |
        tail -n 1 |
        tr -d '\r' |
        tr '[:upper:]' '[:lower:]' |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
        sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
)"
HOSTNAME_PATTERN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'

if [ -z "$MANAGER_DOMAIN" ]; then
    COMPOSE_PROFILE_FLAG=""
    echo "==> MANAGER_DOMAIN is empty: no public edge, SSH tunnel only"
elif [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]; then
    COMPOSE_PROFILE_FLAG="--profile public"
    echo "==> MANAGER_DOMAIN=${MANAGER_DOMAIN}: starting the public HTTPS edge too"
else
    echo "ERROR: MANAGER_DOMAIN in $ENV_FILE is not a host name: '${MANAGER_DOMAIN}'." >&2
    echo "Give it a dotted name with an A record on this host, such as" >&2
    echo "manager.example.org, or leave it empty for the SSH tunnel only." >&2
    exit 1
fi

echo "==> Building swarm-hls-stream locally (so dist/ ships over rsync)"
# swarm-hls-stream has its own pnpm workspace, separate from the parent repo.
pnpm -C manager/swarm-hls-stream install --frozen-lockfile
pnpm -C manager/swarm-hls-stream -r build

echo "==> rsync → ${SSH_TARGET}:${REMOTE_PATH}"
rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    --exclude 'manager/swarm-hls-stream/deploy/data/' \
    ./ "${SSH_TARGET}:${REMOTE_PATH}/"

echo "==> Remote build + up"
# Detect the server's primary IP on the host (the manager runs in a container,
# so it can't see the host's real address itself) and pass it through as
# PUBLIC_HOST for building component URLs.
ssh "$SSH_TARGET" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_PATH}/manager

PUBLIC_HOST="\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="src"){print \$(i+1); exit}}')"
echo "[deploy] resolved PUBLIC_HOST='\${PUBLIC_HOST}' (default-route src IP)"
if [ -z "\${PUBLIC_HOST}" ]; then
    echo "[deploy] WARNING: PUBLIC_HOST is empty; component URLs will fall back to localhost" >&2
fi

export PUBLIC_HOST
export BEE_DATA_ROOT="\${HOME}/streaming-infra-manager-data"
# --remove-orphans reaches a service renamed or deleted in the compose file,
# and only inside the manager compose project, each deployment having its own
# project name. It does not reach the edge: Compose counts a service whose
# profile is inactive as one it knows about rather than an orphan, so a
# container started under --profile public keeps running once the profile is
# dropped. Naming the profile is the only way to reach it, so with no domain
# set the edge is removed by name and the removal is checked. It publishes 80,
# 443 and 443/udp, so a deploy that leaves it up leaves the host public.
docker compose ${COMPOSE_PROFILE_FLAG} up -d --build --remove-orphans

if [ -z "${COMPOSE_PROFILE_FLAG}" ]; then
    docker compose --profile public rm -sf edge
    if [ -n "\$(docker compose --profile public ps -q edge)" ]; then
        echo "[deploy] ERROR: MANAGER_DOMAIN is empty and the edge is still running." >&2
        echo "[deploy] The host is still answering on 80 and 443." >&2
        echo "[deploy] Stop it by hand: cd ${REMOTE_PATH}/manager && docker compose --profile public rm -sf edge" >&2
        exit 1
    fi
    echo "[deploy] no public edge running"
fi

echo "[deploy] PUBLIC_HOST seen inside api container:"
docker compose exec -T api sh -c 'echo "  PUBLIC_HOST=\${PUBLIC_HOST}"' || \
    echo "[deploy] (could not exec into api container to verify)"
REMOTE


echo "==> Done."
if [ -n "$MANAGER_DOMAIN" ]; then
    echo "Public: https://${MANAGER_DOMAIN}"
    echo "First certificate: ssh ${SSH_TARGET}, then in ${REMOTE_PATH}/manager run docker compose logs -f edge"
fi
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
