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
#   1. Builds swarm-hls-stream locally so its dist/ artifacts ship with the
#      stack (the host docker daemon mounts those into sibling containers
#      spawned by the manager, so they must exist on the server filesystem).
#   2. rsyncs the repo to /home/solarpunk/streaming-infra-manager, without
#      manager/swarm-hls-stream: the tree the engines of existing deployments
#      mount is never written over again, so a container restart keeps the
#      files it was started with. Excludes node_modules, build caches and
#      .git. The manager's .env DOES ship, and --delete means this checkout
#      is the only source of truth for it.
#   3. Seals the streaming stack into one package with `bundled:seal`. The
#      package holds the files of the commit the checkout is on, the two
#      built directories, the stack's own .env, deploy config and engine
#      envs, and a manifest naming every path with its hash. It is copied to
#      the host under a staging name and renamed once every file arrived, so
#      the host never reads a package a dropped connection left half copied.
#      Nothing about it is published yet.
#   4. Builds the images on the server, then runs `manager:upgrade` in a
#      one-off container of the image just built. That command owns the rest:
#      it holds one directory for the whole run so a second upgrade cannot
#      start beside it, stops the old api, checks the package against the
#      identity it was given, migrates, publishes the package as an immutable
#      build the bundled version deploys from, starts the project and waits
#      for the api to answer. A container keeps what it mounts until its own
#      deployment is deployed. With MANAGER_DOMAIN set the upgrade is asked
#      for the public TLS edge, and without it the edge is removed by name and
#      the removal is checked, because dropping a profile does not stop a
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
    PUBLIC_EDGE_FLAG=""
    echo "==> MANAGER_DOMAIN is empty: no public edge, SSH tunnel only"
elif [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]; then
    PUBLIC_EDGE_FLAG="--public-edge"
    echo "==> MANAGER_DOMAIN=${MANAGER_DOMAIN}: starting the public HTTPS edge too"
else
    echo "ERROR: MANAGER_DOMAIN in $ENV_FILE is not a host name: '${MANAGER_DOMAIN}'." >&2
    echo "Give it a dotted name with an A record on this host, such as" >&2
    echo "manager.example.org, or leave it empty for the SSH tunnel only." >&2
    exit 1
fi

echo "==> Building swarm-hls-stream locally (so its dist/ ships inside the package)"
# swarm-hls-stream has its own pnpm workspace, separate from the parent repo.
pnpm -C manager/swarm-hls-stream install --frozen-lockfile
pnpm -C manager/swarm-hls-stream -r build

echo "==> Recording the bundled stack commit"
# The rsync below excludes .git, so on the server the submodule tree carries no
# way of saying which commit it is. A bundled row that has never been published
# reads this file at boot and shows it as its commit. Written next to the
# checkout rather than inside it, because the submodule's own .gitignore does
# not cover it and a file in there would show up as an untracked change.
git -C manager/swarm-hls-stream rev-parse HEAD > manager/.stack-commit
echo "[deploy] bundled stack commit: $(cat manager/.stack-commit)"

echo "==> Building the manager, so its command line exists here"
pnpm --filter @streaming-infra-manager/api... build

# One fresh id per deploy run, which is what the host's journal records the
# shipment under. Replaying an earlier one is not something this script does.
SHIPMENT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
TOOLCHAIN="node $(node --version) pnpm $(pnpm --version) $(uname -s)/$(uname -m)"
SEAL_DIR="$(mktemp -d)"
trap 'rm -rf "$SEAL_DIR"' EXIT

echo "==> Sealing the bundled stack (shipment ${SHIPMENT_ID})"
SEAL_JSON="$(node manager/dist/cli.js bundled:seal \
    --source manager/swarm-hls-stream \
    --out "$SEAL_DIR" \
    --shipment-id "$SHIPMENT_ID" \
    --dist packages/client/dist \
    --dist packages/stream-uploader/dist \
    --adopt-inputs \
    --toolchain "$TOOLCHAIN")"
SHIPMENT_COMMIT="$(node -p 'JSON.parse(process.argv[1]).commit' "$SEAL_JSON")"
SHIPMENT_DIGEST="$(node -p 'JSON.parse(process.argv[1]).digest' "$SEAL_JSON")"
echo "[deploy] sealed ${SHIPMENT_COMMIT} as ${SHIPMENT_DIGEST}"

# The host's versions root, where the upgrade publishes from: the path the
# remote block below exports and manager/docker-compose.yml bind-mounts, under
# the home of the user the api runs as.
REMOTE_HOME="$(ssh "$SSH_TARGET" 'printf %s "$HOME"')"
if [ -z "$REMOTE_HOME" ]; then
    echo "ERROR: could not read the home directory on ${SSH_TARGET}." >&2
    exit 1
fi
REMOTE_VERSIONS_ROOT="${REMOTE_HOME}/streaming-infra-manager-versions"
REMOTE_PACKAGES="${REMOTE_VERSIONS_ROOT}/bundled.packages"

echo "==> rsync → ${SSH_TARGET}:${REMOTE_PATH} (manager/swarm-hls-stream left as it is)"
rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'manager/swarm-hls-stream/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    ./ "${SSH_TARGET}:${REMOTE_PATH}/"

echo "==> rsync the sealed package → ${SSH_TARGET}:${REMOTE_PACKAGES}"
# Archive mode and nothing else: the manifest records every file's mode and
# every symbolic link, and a copy that dropped either would fail verification
# on the host. Into a staging name beside the packages already there, never
# over one, and made visible with one rename once every file arrived.
ssh "$SSH_TARGET" "mkdir -p '${REMOTE_PACKAGES}' && rm -rf '${REMOTE_PACKAGES}/sealed-${SHIPMENT_ID}.tmp'"
rsync -a --delete \
    "${SEAL_DIR}/sealed-${SHIPMENT_ID}/" "${SSH_TARGET}:${REMOTE_PACKAGES}/sealed-${SHIPMENT_ID}.tmp/"
ssh "$SSH_TARGET" "mv '${REMOTE_PACKAGES}/sealed-${SHIPMENT_ID}.tmp' '${REMOTE_PACKAGES}/sealed-${SHIPMENT_ID}'"

# What the upgrade records as the manager it installed: the commit of this
# checkout and a digest of the tree that commit names.
MANAGER_COMMIT="$(git rev-parse HEAD)"
MANAGER_DIGEST="$(git ls-tree -r --full-tree HEAD | shasum -a 256 | cut -c1-64)"

echo "==> Remote build + upgrade"
# Detect the server's primary IP on the host (the manager runs in a container,
# so it can't see the host's real address itself) and pass it through as
# PUBLIC_HOST for building component URLs.
ssh "$SSH_TARGET" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_PATH}/manager

PUBLIC_HOST="\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="src"){print \$(i+1); exit}}')"
echo "[deploy] resolved PUBLIC_HOST='\${PUBLIC_HOST}' (default-route src IP)"
if [ -z "\${PUBLIC_HOST}" ]; then
    echo "[deploy] WARNING: PUBLIC_HOST is empty, so component URLs will fall back to localhost" >&2
fi

export PUBLIC_HOST
export BEE_DATA_ROOT="\${HOME}/streaming-infra-manager-data"

# Added stack versions live here, a sibling of the data root and outside the
# tree the rsync above deletes into, so a manager deploy cannot wipe them.
export STACK_VERSIONS_ROOT="\${HOME}/streaming-infra-manager-versions"
mkdir -p "\${STACK_VERSIONS_ROOT}"
echo "[deploy] stack versions root: \${STACK_VERSIONS_ROOT}"

docker compose build
IMAGE_ID="\$(docker image inspect --format '{{.Id}}' manager-api)"
echo "[deploy] built api image \${IMAGE_ID}"

# --no-deps is deliberate. This one-off container decides for itself whether
# Postgres may be started, because a host that has never run the manager and a
# host whose database was removed are different situations and only one of them
# may be treated as an empty database. The container joins the project network,
# so postgres and api resolve by name inside it.
RECEIPT="\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade \
    --shipment-id '${SHIPMENT_ID}' \
    --commit '${SHIPMENT_COMMIT}' \
    --digest '${SHIPMENT_DIGEST}' \
    --manager-commit '${MANAGER_COMMIT}' \
    --manager-digest '${MANAGER_DIGEST}' \
    --image-id "\${IMAGE_ID}" \
    --project manager \
    --compose-file ${REMOTE_PATH}/manager/docker-compose.yml \
    --mutable-root ${REMOTE_PATH} \
    --toolchain '${TOOLCHAIN}' ${PUBLIC_EDGE_FLAG})"
echo "[deploy] upgrade receipt: \${RECEIPT}"

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
