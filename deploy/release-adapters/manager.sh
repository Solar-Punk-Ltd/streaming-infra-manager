#!/usr/bin/env bash

set -euo pipefail

phase="${1:-}"
if [ "$phase" = transition ]; then
    if [ "$#" -ne 3 ] || [ "$2" != --plan ]; then
        echo "manager release adapter received invalid transition arguments" >&2
        exit 2
    fi
    plan="$3"
    output=""
else
    if [ "$#" -ne 5 ] || [ "$2" != --plan ] || [ "$4" != --output ]; then
        echo "manager release adapter received invalid phase arguments" >&2
        exit 2
    fi
    plan="$3"
    output="$5"
fi

case "$phase" in
    preflight | build | transition | verify) ;;
    *)
        echo "manager release adapter phase is invalid" >&2
        exit 2
        ;;
esac

candidate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
manager_root="${candidate_root}/manager"
compose_file="${manager_root}/docker-compose.yml"

plan_value() {
    node - "$plan" "$phase" "$1" <<'NODE'
const fs = require('node:fs');

const [planPath, expectedPhase, key] = process.argv.slice(2);
let plan;
try {
  plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
} catch {
  process.stderr.write('manager release adapter plan is unreadable\n');
  process.exit(2);
}
if (
  plan === null ||
  typeof plan !== 'object' ||
  plan.schemaVersion !== 1 ||
  plan.phase !== expectedPhase ||
  plan.slot?.role !== 'manager' ||
  plan.slot?.id !== 'default'
) {
  process.stderr.write('manager release adapter plan is invalid\n');
  process.exit(2);
}
if (key === 'candidateRoot') {
  if (typeof plan.candidateRoot !== 'string') process.exit(2);
  process.stdout.write(plan.candidateRoot);
  process.exit(0);
}
if (key === 'temporaryProject') {
  if (typeof plan.temporaryProject !== 'string' || !/^release-[0-9a-f]{20}$/.test(plan.temporaryProject)) process.exit(2);
  process.stdout.write(plan.temporaryProject);
  process.exit(0);
}
if (key.startsWith('image:')) {
  const service = key.slice('image:'.length);
  const image = Array.isArray(plan.images)
    ? plan.images.find((entry) => entry?.service === service)
    : undefined;
  if (!image || typeof image.imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(image.imageId)) process.exit(2);
  process.stdout.write(image.imageId);
  process.exit(0);
}
process.exit(2);
NODE
}

if [ "$(plan_value candidateRoot)" != "$candidate_root" ]; then
    echo "manager release adapter candidate root does not match its plan" >&2
    exit 2
fi

if [ ! -f "$compose_file" ] || [ -L "$compose_file" ]; then
    echo "manager release adapter compose file is missing" >&2
    exit 2
fi

export PUBLIC_HOST
PUBLIC_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
export BEE_DATA_ROOT="${HOME}/streaming-infra-manager-data"
export STACK_VERSIONS_ROOT="${HOME}/streaming-infra-manager-versions"

compose() {
    docker compose \
        --project-name manager \
        --project-directory "$manager_root" \
        -f "$compose_file" \
        "$@"
}

write_images() {
    local api_image="$1"
    local web_image="$2"
    local temporary="${output}.tmp.$$"
    umask 077
    printf '{"schemaVersion":1,"images":[{"service":"api","imageId":"%s"},{"service":"web","imageId":"%s"}]}\n' \
        "$api_image" "$web_image" > "$temporary"
    mv "$temporary" "$output"
}

case "$phase" in
    preflight)
        umask 077
        printf '%s\n' '{"schemaVersion":1}' > "$output"
        ;;
    build)
        temporary_project="$(plan_value temporaryProject)"
        docker compose \
            --project-name "$temporary_project" \
            --project-directory "$manager_root" \
            -f "$compose_file" \
            build api web
        api_image="$(docker image inspect --format '{{.Id}}' "${temporary_project}-api")"
        web_image="$(docker image inspect --format '{{.Id}}' "${temporary_project}-web")"
        write_images "$api_image" "$web_image"
        ;;
    transition)
        api_image="$(plan_value image:api)"
        web_image="$(plan_value image:web)"
        override="$(dirname "$plan")/manager-image-override.yml"
        umask 077
        cat > "$override" <<EOF
services:
  api:
    image: ${api_image}
  web:
    image: ${web_image}
EOF
        compose -f "$override" up -d --no-build api web
        ;;
    verify)
        api_container="$(compose ps -q api)"
        web_container="$(compose ps -q web)"
        if ! [[ "$api_container" =~ ^[A-Za-z0-9_.:-]+$ ]] || ! [[ "$web_container" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
            echo "manager release adapter could not identify one running container per service" >&2
            exit 1
        fi
        api_image="$(docker inspect --format '{{.Image}}' "$api_container")"
        web_image="$(docker inspect --format '{{.Image}}' "$web_container")"
        write_images "$api_image" "$web_image"
        ;;
esac
