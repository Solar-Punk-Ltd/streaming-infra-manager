#!/usr/bin/env bash

set -euo pipefail

GUARD_BIN="${HOME}/.local/bin/streaming-release-guard"
GUARD_STATE_ROOT="${HOME}/.local/state/streaming-release-guard"

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

guard_exists=false
state_exists=false
if path_exists "$GUARD_BIN"; then
    guard_exists=true
fi
if path_exists "$GUARD_STATE_ROOT"; then
    state_exists=true
fi

if [ "$guard_exists" = false ] && [ "$state_exists" = false ]; then
    printf '%s\n' legacy
    exit 0
fi

if [ "$guard_exists" = false ] || [ "$state_exists" = false ]; then
    echo "ERROR: release guard installation is partial" >&2
    exit 1
fi
if [ ! -x "$GUARD_BIN" ] || [ ! -d "$GUARD_STATE_ROOT" ] || [ -L "$GUARD_STATE_ROOT" ]; then
    echo "ERROR: release guard installation is invalid" >&2
    exit 1
fi

mode="$("$GUARD_BIN" status --state-root "$GUARD_STATE_ROOT")"
case "$mode" in
    legacy | managed) printf '%s\n' "$mode" ;;
    *)
        echo "ERROR: release guard returned an invalid deployment mode" >&2
        exit 1
        ;;
esac
