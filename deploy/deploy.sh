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
#   1. Writes the stack commit this repository pins into manager/.stack-commit,
#      read from the repository itself rather than from a checkout, so a laptop
#      that never initialised the submodule still ships the right pin. That file
#      is the only thing about the streaming stack a deploy carries. The host
#      fetches that commit from GitHub and builds it there, through the same
#      path a version added in the UI takes.
#   2. rsyncs the repo to /home/solarpunk/streaming-infra-manager, without
#      manager/swarm-hls-stream: the tree the engines of existing deployments
#      mount is never written over again, so a container restart keeps the
#      files it was started with. Excludes node_modules, build caches and
#      .git. The manager's .env DOES ship, and --delete means this checkout
#      is the only source of truth for it.
#   3. Builds the images on the server, decides there whether this host has
#      ever run the manager, and then runs `manager:upgrade` in a one-off
#      container of the image just built. The first use question is answered
#      before that container exists, because preparing it can create the
#      project's volumes, and it stops the deploy when the data volume is gone
#      from under an installed manager. The command owns the rest:
#      it holds one directory for the whole run so a second upgrade cannot
#      start beside it, stops the old api, migrates, starts the project, waits
#      for the api to answer, and then waits for the api's own boot to finish
#      building the pinned stack commit. With MANAGER_DOMAIN set the upgrade is
#      asked for the public TLS edge, and without it the edge is removed by name
#      and the removal is checked, because dropping a profile does not stop a
#      container already running under it.
#
# The streaming stack's own settings live on the server, under the versions
# root, and no deploy reads or writes them. See deploy/README.md.

set -euo pipefail

SSH_TARGET="${1:-viewer}"
# It is handed to ssh as the destination, where a leading dash is an option.
if [[ "$SSH_TARGET" == -* ]]; then
    echo "ERROR: the ssh target must not start with a dash (got: $SSH_TARGET)" >&2
    exit 1
fi
REMOTE_PATH="/home/solarpunk/streaming-infra-manager"
# How long the upgrade waits for the host to fetch and build the pinned stack
# commit before it reports a failure. A first build on a cold host pulls the
# node image and installs the whole workspace.
BUNDLED_TIMEOUT="${BUNDLED_TIMEOUT:-1200}"
# It is interpolated into a single quoted word of the remote heredoc, so a
# value carrying a quote would close that quoting on the host.
if ! [[ "$BUNDLED_TIMEOUT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: BUNDLED_TIMEOUT must be a whole number of seconds (got: $BUNDLED_TIMEOUT)" >&2
    exit 1
fi

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

echo "==> Recording the stack commit this manager pins"
# The submodule pin, taken from the repository rather than from the working
# tree, so it is right whether or not the submodule is checked out here. The
# host reads this file at boot and builds that commit if it has no complete
# build of it. Written next to the checkout rather than inside it, because the
# submodule's own .gitignore does not cover it and a file in there would show
# up as an untracked change.
git rev-parse HEAD:manager/swarm-hls-stream > manager/.stack-commit
echo "[deploy] pinned stack commit: $(cat manager/.stack-commit)"

# What the upgrade records as the manager it installed: the commit of this
# checkout and a digest of the tree that commit names.
MANAGER_COMMIT="$(git rev-parse HEAD)"
MANAGER_DIGEST="$(git ls-tree -r --full-tree HEAD | shasum -a 256 | cut -c1-64)"

echo "==> rsync → ${SSH_TARGET}:${REMOTE_PATH} (manager/swarm-hls-stream left as it is)"
rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'manager/swarm-hls-stream/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    ./ "${SSH_TARGET}:${REMOTE_PATH}/"

echo "==> Remote build + upgrade"
# Detect the server's primary IP on the host (the manager runs in a container,
# so it can't see the host's real address itself) and pass it through as
# PUBLIC_HOST for building component URLs.
ssh "$SSH_TARGET" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_PATH}/manager

# The || true is what keeps this line from ending the whole remote block: it runs
# under pipefail, so a host without ip, or a route that cannot be read, would
# fail the substitution and none of the lines below would run.
PUBLIC_HOST="\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="src"){print \$(i+1); exit}}' || true)"
echo "[deploy] resolved PUBLIC_HOST='\${PUBLIC_HOST}' (default-route src IP)"
if [ -z "\${PUBLIC_HOST}" ]; then
    echo "[deploy] WARNING: PUBLIC_HOST is empty, so component URLs will fall back to localhost" >&2
fi

export PUBLIC_HOST
export BEE_DATA_ROOT="\${HOME}/streaming-infra-manager-data"

# Added stack versions live here, a sibling of the data root and outside the
# tree the rsync above deletes into, so a manager deploy cannot wipe them. The
# bundled version's own build and its settings live here too.
export STACK_VERSIONS_ROOT="\${HOME}/streaming-infra-manager-versions"
mkdir -p "\${STACK_VERSIONS_ROOT}"
echo "[deploy] stack versions root: \${STACK_VERSIONS_ROOT}"

docker compose build
IMAGE_ID="\$(docker image inspect --format '{{.Id}}' manager-api)"
echo "[deploy] built api image \${IMAGE_ID}"

# Whether this host has ever run the manager is decided here, before the one-off
# container below exists. Preparing that container can create the project's
# volumes, so the same question asked from inside it would find a data volume
# nothing has ever written to and call an old database a new one.
POSTGRES_VOLUME="manager_manager-pg"
service_containers() {
    docker ps -aq \
        --filter "label=com.docker.compose.project=manager" \
        --filter "label=com.docker.compose.service=\$1" \
        --filter "label=com.docker.compose.oneoff=False"
}
# Each answer is read into a variable of its own before it is looked at. A
# substitution inside a [ ... ] condition reports what it printed rather than
# that it failed, so a daemon that could not be asked would read as a host with
# nothing on it and this deploy would call an old database new.
DATA_VOLUME="\$(docker volume ls -q --filter name=^\${POSTGRES_VOLUME}\$)"
API_CONTAINERS="\$(service_containers api)"
POSTGRES_CONTAINERS="\$(service_containers postgres)"
FIRST_USE_FLAG=""
if [ -z "\${DATA_VOLUME}" ]; then
    if [ -n "\${API_CONTAINERS}" ]; then
        echo "[deploy] ERROR: this host has an api container but no \${POSTGRES_VOLUME} volume, so its database was removed under a manager that is still installed. Look at the host before deploying again." >&2
        exit 1
    fi
    if [ -z "\${POSTGRES_CONTAINERS}" ]; then
        FIRST_USE_FLAG="--first-use"
        echo "[deploy] no data volume and no containers of this project: this host has never run the manager"
    fi
fi

# --no-deps is deliberate. This one-off container decides for itself whether
# Postgres may be started, because a host that has never run the manager and a
# host whose database was removed are different situations and only one of them
# may be treated as an empty database. The container joins the project network,
# so postgres and api resolve by name inside it.
# The status is taken rather than left to end the block, because the receipt
# is the one line the upgrade prints and a failed bundled build is in it.
UPGRADE_STATUS=0
RECEIPT="\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade \
    --manager-commit '${MANAGER_COMMIT}' \
    --manager-digest '${MANAGER_DIGEST}' \
    --image-id "\${IMAGE_ID}" \
    --project manager \
    --compose-file ${REMOTE_PATH}/manager/docker-compose.yml \
    --mutable-root ${REMOTE_PATH} \
    --bundled-timeout '${BUNDLED_TIMEOUT}' \
    \${FIRST_USE_FLAG} ${PUBLIC_EDGE_FLAG} < /dev/null)" || UPGRADE_STATUS=\$?
echo "[deploy] upgrade receipt: \${RECEIPT}"
if [ "\${UPGRADE_STATUS}" -ne 0 ]; then
    echo "[deploy] the upgrade exited with \${UPGRADE_STATUS}" >&2
    exit "\${UPGRADE_STATUS}"
fi

echo "[deploy] PUBLIC_HOST seen inside api container:"
docker compose exec -T api sh -c 'echo "  PUBLIC_HOST=\${PUBLIC_HOST}"' < /dev/null || \
    echo "[deploy] (could not exec into api container to verify)"
REMOTE


echo "==> Done."
if [ -n "$MANAGER_DOMAIN" ]; then
    echo "Public: https://${MANAGER_DOMAIN}"
    echo "First certificate: ssh ${SSH_TARGET}, then in ${REMOTE_PATH}/manager run docker compose logs -f edge"
fi
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
