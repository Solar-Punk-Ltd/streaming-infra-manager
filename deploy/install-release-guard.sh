#!/usr/bin/env bash

set -euo pipefail
umask 077

if [ $(( $# % 2 )) -ne 0 ]; then
    echo "release guard installer arguments must be target name/value pairs" >&2
    exit 2
fi
fixture_id=""
fixture_network_name=""
for ((index = 1; index <= $#; index += 2)); do
    name="${!index}"
    value_index=$((index + 1))
    value="${!value_index}"
    case "$name" in
        --manager-mode | --manager-project-name | --manager-postgres-volume-name | --manager-postgres-port | --manager-web-port | --admin-project-name | --admin-postgres-volume-name | --admin-web-port | --uploader-profile | --uploader-port-slot | --uploader-services | --viewer-profile | --viewer-port-slot | --viewer-services | --fixture-network-name | --fixture-id) ;;
        *)
            echo "release guard installer target argument is invalid" >&2
            exit 2
            ;;
    esac
    if [ "$name" = --fixture-id ]; then fixture_id="$value"; fi
    if [ "$name" = --fixture-network-name ]; then fixture_network_name="$value"; fi
done

if [ -n "$fixture_id" ] || [ -n "$fixture_network_name" ]; then
    if [[ ! "$fixture_id" =~ ^srs-continuation-20260920-[a-z0-9]{8,16}$ ]] ||
        [ "$fixture_network_name" != "${fixture_id}-network" ]; then
        echo "release guard fixture identity is invalid" >&2
        exit 2
    fi
    fixture_base="/home/solarpunk/srs-continuation-tests-20260920"
    fixture_parent="${fixture_base}/${fixture_id}"
    installation_root="${fixture_parent}/guard"
    if [ ! -d "$fixture_base" ] || [ -L "$fixture_base" ] ||
        [ "$(cd "$fixture_base" && pwd -P)" != "$fixture_base" ] ||
        [ ! -d "$fixture_parent" ] || [ -L "$fixture_parent" ] ||
        [ "$(cd "$fixture_parent" && pwd -P)" != "$fixture_parent" ]; then
        echo "release guard fixture parent is invalid" >&2
        exit 1
    fi
    if [ -e "$installation_root" ] || [ -L "$installation_root" ]; then
        echo "release guard fixture guard root is invalid" >&2
        exit 1
    fi
    if ! mkdir -m 700 "$installation_root"; then
        echo "release guard fixture guard root is invalid" >&2
        exit 1
    fi
else
    installation_root="${HOME}/.local"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_root="${repo_root}/manager/dist/releaseGuard"
library_root="${installation_root}/lib/streaming-release-guard"
code_root="${library_root}/current"
bin_root="${installation_root}/bin"
launcher="${bin_root}/streaming-release-guard"
state_root="${installation_root}/state/streaming-release-guard"
launcher_source="${repo_root}/deploy/release-guard/streaming-release-guard"
container_launcher_source="${repo_root}/deploy/release-guard/streaming-release-guard-container"
release_mode_source="${repo_root}/deploy/release-mode.sh"
files=(
    FixedReleaseAdapter.js
    ReleaseGuardCli.js
    ReleaseGuardManagerStdin.js
    ReleaseGuardStore.js
    ReleaseGuardTypes.js
    ReleaseReceiptSubmitter.js
    ReleaseTransition.js
)

if [ ! -f "$launcher_source" ] || [ -L "$launcher_source" ]; then
    echo "release guard launcher source is missing" >&2
    exit 1
fi
if [ ! -f "$container_launcher_source" ] || [ -L "$container_launcher_source" ]; then
    echo "release guard container launcher source is missing" >&2
    exit 1
fi
if [ ! -f "$release_mode_source" ] || [ -L "$release_mode_source" ]; then
    echo "release guard bootstrap lease source is missing" >&2
    exit 1
fi
for file in "${files[@]}"; do
    if [ ! -f "${source_root}/${file}" ] || [ -L "${source_root}/${file}" ]; then
        echo "release guard build output is incomplete" >&2
        exit 1
    fi
done

if [ -n "$fixture_id" ]; then
    lease_result="$("$release_mode_source" begin-bootstrap-install --fixture-id "$fixture_id")"
else
    lease_result="$("$release_mode_source" begin-bootstrap-install)"
fi
case "$lease_result" in
    bootstrap:*) owner_token="${lease_result#bootstrap:}" ;;
    *)
        echo "release guard bootstrap lease result is invalid" >&2
        exit 1
        ;;
esac

mkdir -p "$library_root" "$bin_root" "$(dirname "$state_root")"
chmod 700 "$library_root" "$bin_root" "$(dirname "$state_root")"
if [ -n "$fixture_id" ]; then
    mkdir -p "${installation_root}/work"
    chmod 700 "$installation_root" "${installation_root}/work"
fi
mkdir -m 700 "$code_root"
for file in "${files[@]}"; do
    install -m 0444 "${source_root}/${file}" "${code_root}/${file}"
done
install -m 0555 "$container_launcher_source" "${code_root}/streaming-release-guard"
printf '%s\n' '{"type":"module"}' > "${code_root}/package.json"
chmod 0444 "${code_root}/package.json"
install -m 0555 "$launcher_source" "$launcher"
chmod 0555 "$code_root"
node - "$code_root" "$launcher" <<'NODE'
const fs = require('node:fs');
for (const path of process.argv.slice(2)) {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
NODE

"$launcher" install --state-root "$state_root" "$@"
if [ "$("$launcher" status --state-root "$state_root")" != legacy ]; then
    echo "release guard installation did not remain pristine" >&2
    exit 1
fi
if [ -n "$fixture_id" ]; then
    "$release_mode_source" finish-bootstrap "$owner_token" --fixture-id "$fixture_id" >/dev/null
else
    "$release_mode_source" finish-bootstrap "$owner_token" >/dev/null
fi
printf '%s\n' 'release guard installed in legacy mode'
