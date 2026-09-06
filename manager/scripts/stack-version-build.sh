#!/usr/bin/env bash
# Check out one version of the streaming stack and build its packages.
#
#   stack-version-build.sh <root> <ref> <repo-url>
#
# <root>     absolute path the checkout lives at, on the host and inside the api
#            container alike. STACK_VERSIONS_ROOT is bind-mounted at the same
#            absolute path on both sides, which is what lets the compose files
#            inside the checkout resolve their own relative volumes: the docker
#            daemon runs on the host, so it reads every path as a host path.
# <ref>      branch or tag to follow. The commit only moves when this runs.
# <repo-url> where the stack comes from. A constant in the manager, never
#            operator supplied.
#
# Prints STACK_COMMIT=<sha> for whoever is reading the log. The manager itself
# reads the commit with `git rev-parse` in <root> once this exits, because a
# real build prints far more than the manager keeps of this stream.
#
# The packages are built in a throwaway node container rather than in the api
# image, so the api image keeps carrying no toolchain of its own. That container
# is never shown <root>. Every deployment's secrets sit there as .env.<profile>
# files holding STREAM_KEY, SRT_PASSPHRASE and STAMP, and the build runs the
# followed branch's own install and build scripts, so the branch would be able
# to read them. It is handed a staging tree exported from the fetched commit
# instead, which holds the branch's files and nothing of this host's, and the
# built tree is copied back into <root> afterwards with every env file kept.
set -euo pipefail

readonly BUILD_IMAGE="node:22-alpine"
readonly BUILD_COMMAND='corepack enable && pnpm install --frozen-lockfile && pnpm -r build'

if [ "$#" -ne 3 ]; then
    echo "usage: stack-version-build.sh <root> <ref> <repo-url>" >&2
    exit 2
fi

ROOT="$1"
REF="$2"
REPO_URL="$3"

# Checked here as well as in the manager, because these three values land in
# `git clone --branch`, `git -C` and `docker run -v`, where a leading dash is an
# option, `..` walks out of the directory, and a relative root is whatever the
# working directory happened to be.
case "$ROOT" in
    /*) ;;
    *)
        echo "ERROR: <root> must be an absolute path (got: $ROOT)" >&2
        exit 2
        ;;
esac
case "$ROOT" in
    *..*)
        echo "ERROR: <root> must not contain .. (got: $ROOT)" >&2
        exit 2
        ;;
esac
if ! [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || [[ "$REF" == -* ]] || [[ "$REF" == *..* ]]; then
    echo "ERROR: <ref> must be a branch or tag of letters, digits, dot, underscore, slash and dash, with no leading dash and no .. (got: $REF)" >&2
    exit 2
fi
if ! [[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]]; then
    echo "ERROR: <repo-url> must be an https github clone url (got: $REPO_URL)" >&2
    exit 2
fi

# Beside the root rather than inside it, so the copy back can delete whatever
# the branch dropped and still leave the root's own files alone.
STAGING="$ROOT.staging"
trap 'rm -rf "$STAGING"' EXIT

# Git only, up to here. Nothing out of the fetched tree has run yet.
if [ -d "$ROOT/.git" ]; then
    echo "==> Fetching $REF into $ROOT"
    git -C "$ROOT" fetch --prune --tags origin "$REF"
    # FETCH_HEAD rather than origin/<ref>: a tag has no origin/<name>, and this
    # is the one thing a branch and a tag both leave behind.
    git -C "$ROOT" checkout --detach --force FETCH_HEAD
    git -C "$ROOT" reset --hard FETCH_HEAD
    ARCHIVE_REV="FETCH_HEAD"
else
    echo "==> Cloning $REF into $ROOT"
    mkdir -p "$(dirname "$ROOT")"
    rm -rf "$ROOT"
    git clone --branch "$REF" --single-branch "$REPO_URL" "$ROOT"
    ARCHIVE_REV="HEAD"
fi

echo "STACK_COMMIT=$(git -C "$ROOT" rev-parse HEAD)"

echo "==> Exporting the commit into $STAGING"
rm -rf "$STAGING"
mkdir -p "$STAGING"
git -C "$ROOT" archive "$ARCHIVE_REV" | tar -x -C "$STAGING"

# No -e and no --env-file: the container gets the staging tree, a cpu and memory
# ceiling, a process ceiling, and nothing else of this host.
echo "==> Installing and building the packages in $BUILD_IMAGE"
docker run --rm \
    --memory 4g \
    --cpus 2 \
    --pids-limit 512 \
    -v "$STAGING:$STAGING" \
    -w "$STAGING" \
    "$BUILD_IMAGE" sh -c "$BUILD_COMMAND"

# The deploy scripts read dist/ and node_modules from the root, so the built
# tree has to land there. Everything this host wrote into the root is excluded,
# which also keeps --delete off it: the deployments' env files, the base env,
# the deploy config and the per engine env files, and the two data directories
# the compose files fall back to when BEE_DATA_ROOT is unset, so an update can
# never take a Bee node's data with it.
echo "==> Copying the built tree into $ROOT"
rsync -a --delete \
    --exclude '.git' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'deploy/config.json' \
    --exclude 'deploy/.env.deploy*' \
    --exclude 'engines/*/.env*' \
    --exclude 'nodes/data' \
    --exclude 'deploy/data' \
    "$STAGING/" "$ROOT/"

copy_when_missing() {
    local src="$1"
    local dst="$2"
    if [ ! -f "$dst" ] && [ -f "$src" ]; then
        cp "$src" "$dst"
        echo "==> Created ${dst#"$ROOT"/} from ${src#"$ROOT"/}"
    fi
}

copy_when_missing "$ROOT/.env.sample" "$ROOT/.env"
copy_when_missing "$ROOT/deploy/config.sample.json" "$ROOT/deploy/config.json"

echo "==> Done. $ROOT is ready to deploy from."
