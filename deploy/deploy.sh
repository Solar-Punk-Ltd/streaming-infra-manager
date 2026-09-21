#!/usr/bin/env bash
# Selects the preserved standalone deployment until this installation is
# durably activated, then requires the external release guard path.

set -euo pipefail

SSH_TARGET="${1:-viewer}"
if [[ "$SSH_TARGET" == -* ]]; then
    echo "ERROR: the ssh target must not start with a dash (got: $SSH_TARGET)" >&2
    exit 1
fi

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_MODE="$(ssh "$SSH_TARGET" bash -s -- begin < "${DEPLOY_ROOT}/release-mode.sh")"

case "$RELEASE_MODE" in
    bootstrap:*)
        owner_token="${RELEASE_MODE#bootstrap:}"
        "${DEPLOY_ROOT}/deploy-standalone.sh" "$SSH_TARGET"
        ssh "$SSH_TARGET" bash -s -- finish-bootstrap "$owner_token" < "${DEPLOY_ROOT}/release-mode.sh"
        ;;
    guard:*)
        owner_token="${RELEASE_MODE#guard:}"
        "${DEPLOY_ROOT}/deploy-standalone.sh" "$SSH_TARGET"
        ssh "$SSH_TARGET" bash -s -- finish-guard "$owner_token" < "${DEPLOY_ROOT}/release-mode.sh"
        ;;
    managed)
        exec "${DEPLOY_ROOT}/deploy-managed.sh" "$SSH_TARGET"
        ;;
    *)
        echo "ERROR: release guard returned an invalid deployment mode" >&2
        exit 1
        ;;
esac
