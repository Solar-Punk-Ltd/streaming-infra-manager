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
#      Excludes node_modules, build caches, .git, and the server's own .env.
#   3. SSHes in and runs `docker compose up -d --build`. Builds happen on
#      the server, so the image tags match the server's docker engine.

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
docker compose up -d --build

echo "[deploy] PUBLIC_HOST seen inside api container:"
docker compose exec -T api sh -c 'echo "  PUBLIC_HOST=\${PUBLIC_HOST}"' || \
    echo "[deploy] (could not exec into api container to verify)"
REMOTE


echo "==> Done."
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
