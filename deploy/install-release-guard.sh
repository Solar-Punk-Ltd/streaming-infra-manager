#!/usr/bin/env bash

set -euo pipefail
umask 077

if [ $(( $# % 2 )) -ne 0 ]; then
    echo "release guard installer arguments must be target name/value pairs" >&2
    exit 2
fi
for ((index = 1; index <= $#; index += 2)); do
    name="${!index}"
    case "$name" in
        --manager-mode | --manager-project-name | --manager-postgres-volume-name | --manager-postgres-port | --manager-web-port | --admin-project-name | --admin-postgres-volume-name | --admin-web-port | --uploader-profile | --uploader-port-slot | --uploader-services | --viewer-profile | --viewer-port-slot | --viewer-services) ;;
        *)
            echo "release guard installer target argument is invalid" >&2
            exit 2
            ;;
    esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_root="${repo_root}/manager/dist/releaseGuard"
library_root="${HOME}/.local/lib/streaming-release-guard"
code_root="${library_root}/current"
bin_root="${HOME}/.local/bin"
launcher="${bin_root}/streaming-release-guard"
state_root="${HOME}/.local/state/streaming-release-guard"
launcher_source="${repo_root}/deploy/release-guard/streaming-release-guard"
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

lease_result="$("$release_mode_source" begin-bootstrap-install)"
case "$lease_result" in
    bootstrap:*) owner_token="${lease_result#bootstrap:}" ;;
    *)
        echo "release guard bootstrap lease result is invalid" >&2
        exit 1
        ;;
esac

mkdir -p "$library_root" "$bin_root" "$(dirname "$state_root")"
chmod 700 "$library_root" "$bin_root" "$(dirname "$state_root")"
mkdir -m 700 "$code_root"
for file in "${files[@]}"; do
    install -m 0444 "${source_root}/${file}" "${code_root}/${file}"
done
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
"$release_mode_source" finish-bootstrap "$owner_token" >/dev/null
printf '%s\n' 'release guard installed in legacy mode'
