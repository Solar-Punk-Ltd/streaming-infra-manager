#!/usr/bin/env bash

set -euo pipefail
umask 077

UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
FIXTURE_ID_PATTERN='^srs-continuation-20260920-[a-z0-9]{8,16}$'

configure_paths() {
    if [ "$#" -eq 0 ]; then
        installation_root="${HOME}/.local"
        BOOTSTRAP_LOCK="${HOME}/.local/state/streaming-release-bootstrap.lock"
    elif [ "$#" -eq 2 ] && [ "$1" = --fixture-id ] && [[ "$2" =~ $FIXTURE_ID_PATTERN ]]; then
        fixture_base="/home/solarpunk/srs-continuation-tests-20260920"
        fixture_parent="${fixture_base}/${2}"
        installation_root="${fixture_parent}/guard"
        if [ ! -d "$fixture_base" ] || [ -L "$fixture_base" ] ||
            [ "$(cd "$fixture_base" && pwd -P)" != "$fixture_base" ] ||
            [ ! -d "$fixture_parent" ] || [ -L "$fixture_parent" ] ||
            [ "$(cd "$fixture_parent" && pwd -P)" != "$fixture_parent" ] ||
            [ ! -d "$installation_root" ] || [ -L "$installation_root" ] ||
            [ "$(cd "$installation_root" && pwd -P)" != "$installation_root" ]; then
            echo "ERROR: release fixture guard root is invalid" >&2
            exit 1
        fi
        BOOTSTRAP_LOCK="${installation_root}/state/bootstrap.lock"
    else
        echo "ERROR: release fixture identity is invalid" >&2
        exit 2
    fi
    GUARD_BIN="${installation_root}/bin/streaming-release-guard"
    GUARD_STATE_ROOT="${installation_root}/state/streaming-release-guard"
    BOOTSTRAP_OWNER="${BOOTSTRAP_LOCK}/owner"
    BOOTSTRAP_RELEASE_CLAIM="${BOOTSTRAP_LOCK}/release.claim"
}

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

sync_paths() {
    if [ "$(uname -s)" = Linux ]; then
        for path in "$@"; do sync -f "$path"; done
    else
        sync
    fi
}

new_owner_token() {
    if [ -r /proc/sys/kernel/random/uuid ]; then
        IFS= read -r owner_token < /proc/sys/kernel/random/uuid
    else
        owner_token="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    fi
    if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
        echo "ERROR: release bootstrap owner token source is invalid" >&2
        exit 1
    fi
    printf '%s\n' "$owner_token"
}

require_absent_installation() {
    if path_exists "$GUARD_BIN" || path_exists "$GUARD_STATE_ROOT"; then
        echo "ERROR: release guard installation already exists or is partial" >&2
        exit 1
    fi
}

begin_bootstrap() {
    mkdir -p "$(dirname "$BOOTSTRAP_LOCK")"
    chmod 700 "$(dirname "$BOOTSTRAP_LOCK")"
    if ! mkdir -m 700 "$BOOTSTRAP_LOCK"; then
        echo "ERROR: release bootstrap lease is active or requires operator recovery" >&2
        exit 1
    fi
    sync_paths "$(dirname "$BOOTSTRAP_LOCK")"
    require_absent_installation
    owner_token="$(new_owner_token)"
    printf '%s\n' "$owner_token" > "${BOOTSTRAP_OWNER}.tmp"
    chmod 600 "${BOOTSTRAP_OWNER}.tmp"
    sync_paths "${BOOTSTRAP_OWNER}.tmp"
    mv "${BOOTSTRAP_OWNER}.tmp" "$BOOTSTRAP_OWNER"
    sync_paths "$BOOTSTRAP_LOCK"
    printf 'bootstrap:%s\n' "$owner_token"
}

finish_bootstrap() {
    owner_token="${1:-}"
    if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
        echo "ERROR: release bootstrap owner token is invalid" >&2
        exit 1
    fi
    if [ ! -d "$BOOTSTRAP_LOCK" ] || [ -L "$BOOTSTRAP_LOCK" ] ||
        [ ! -f "$BOOTSTRAP_OWNER" ] || [ -L "$BOOTSTRAP_OWNER" ]; then
        echo "ERROR: release bootstrap lease is invalid" >&2
        exit 1
    fi
    IFS= read -r actual_owner < "$BOOTSTRAP_OWNER"
    if [ "$actual_owner" != "$owner_token" ]; then
        echo "ERROR: release bootstrap owner token does not match" >&2
        exit 1
    fi
    if ! ln "$BOOTSTRAP_OWNER" "$BOOTSTRAP_RELEASE_CLAIM"; then
        echo "ERROR: release bootstrap lease is already being released or requires operator recovery" >&2
        exit 1
    fi
    IFS= read -r claimed_owner < "$BOOTSTRAP_RELEASE_CLAIM"
    if [ "$claimed_owner" != "$owner_token" ] || [ ! "$BOOTSTRAP_OWNER" -ef "$BOOTSTRAP_RELEASE_CLAIM" ]; then
        rm "$BOOTSTRAP_RELEASE_CLAIM"
        echo "ERROR: release bootstrap owner token does not match" >&2
        exit 1
    fi
    rm "$BOOTSTRAP_OWNER"
    sync_paths "$BOOTSTRAP_LOCK"
    rm "$BOOTSTRAP_RELEASE_CLAIM"
    sync_paths "$BOOTSTRAP_LOCK"
    rmdir "$BOOTSTRAP_LOCK"
    sync_paths "$(dirname "$BOOTSTRAP_LOCK")"
    printf '%s\n' 'release bootstrap lease released'
}

begin_release() {
    guard_exists=false
    state_exists=false
    if path_exists "$GUARD_BIN"; then guard_exists=true; fi
    if path_exists "$GUARD_STATE_ROOT"; then state_exists=true; fi

    if [ "$guard_exists" = false ] && [ "$state_exists" = false ]; then
        begin_bootstrap
        return
    fi
    if [ "$guard_exists" = false ] || [ "$state_exists" = false ]; then
        echo "ERROR: release guard installation is partial" >&2
        exit 1
    fi
    if [ ! -x "$GUARD_BIN" ] || [ ! -d "$GUARD_STATE_ROOT" ] || [ -L "$GUARD_STATE_ROOT" ]; then
        echo "ERROR: release guard installation is invalid" >&2
        exit 1
    fi

    result="$("$GUARD_BIN" begin-legacy --state-root "$GUARD_STATE_ROOT")"
    case "$result" in
        managed) printf '%s\n' managed ;;
        legacy:*)
            owner_token="${result#legacy:}"
            if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
                echo "ERROR: release guard returned an invalid legacy lease" >&2
                exit 1
            fi
            printf 'guard:%s\n' "$owner_token"
            ;;
        *)
            echo "ERROR: release guard returned an invalid deployment mode" >&2
            exit 1
            ;;
    esac
}

command="${1:-begin}"
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
    begin)
        configure_paths "$@"
        begin_release
        ;;
    begin-bootstrap-install)
        configure_paths "$@"
        require_absent_installation
        begin_bootstrap
        ;;
    finish-bootstrap)
        owner_token="${1:-}"
        if [ "$#" -gt 0 ]; then shift; fi
        configure_paths "$@"
        finish_bootstrap "$owner_token"
        ;;
    finish-guard)
        owner_token="${1:-}"
        if [ "$#" -gt 0 ]; then shift; fi
        configure_paths "$@"
        "$GUARD_BIN" finish-legacy --state-root "$GUARD_STATE_ROOT" --owner-token "$owner_token"
        ;;
    *)
        echo "ERROR: release mode command is invalid" >&2
        exit 2
        ;;
esac
