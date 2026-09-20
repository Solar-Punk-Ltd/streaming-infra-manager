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
RELEASE_MODE="$(ssh "$SSH_TARGET" bash -s < "${DEPLOY_ROOT}/release-mode.sh")"

case "$RELEASE_MODE" in
    legacy)
        exec "${DEPLOY_ROOT}/deploy-standalone.sh" "$SSH_TARGET"
        ;;
    managed)
        exec "${DEPLOY_ROOT}/deploy-managed.sh" "$SSH_TARGET"
        ;;
    *)
        echo "ERROR: release guard returned an invalid deployment mode" >&2
        exit 1
        ;;
esac
