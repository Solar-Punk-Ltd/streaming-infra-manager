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
if (key === 'treeDigest') {
  if (typeof plan.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(plan.treeDigest)) process.exit(2);
  process.stdout.write(plan.treeDigest);
  process.exit(0);
}
if (key.startsWith('target:')) {
  const target = plan.arguments?.target;
  if (
    target === null ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    Object.keys(target).sort().join(',') !== 'mode,postgresPort,postgresVolumeName,projectName,webPort' ||
    (target.mode !== 'production' && target.mode !== 'isolated') ||
    typeof target.projectName !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.projectName) ||
    typeof target.postgresVolumeName !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.postgresVolumeName) ||
    !Number.isSafeInteger(target.postgresPort) ||
    target.postgresPort < 1 ||
    target.postgresPort > 65535 ||
    !Number.isSafeInteger(target.webPort) ||
    target.webPort < 1 ||
    target.webPort > 65535 ||
    (target.mode === 'isolated' && (
      target.postgresPort === 5432 ||
      target.webPort === 8080 ||
      target.postgresPort === target.webPort
    ))
  ) process.exit(2);
  const name = key.slice('target:'.length);
  const value = target[name];
  if (typeof value !== 'string' && typeof value !== 'number') process.exit(2);
  process.stdout.write(String(value));
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

release_commit_file="${candidate_root}/.release-commit"
if [ ! -f "$release_commit_file" ] || [ -L "$release_commit_file" ]; then
    echo "manager release adapter source commit is missing" >&2
    exit 2
fi
release_commit="$(tr -d '\r\n' < "$release_commit_file")"
if ! [[ "$release_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
    echo "manager release adapter source commit is invalid" >&2
    exit 2
fi

deployment_mode="$(plan_value target:mode)"
project_name="$(plan_value target:projectName)"
postgres_volume_name="$(plan_value target:postgresVolumeName)"
export MANAGER_ROOT="$candidate_root"
export POSTGRES_PORT WEB_PORT
POSTGRES_PORT="$(plan_value target:postgresPort)"
WEB_PORT="$(plan_value target:webPort)"
guard_code_root="${HOME}/.local/lib/streaming-release-guard/current"
guard_state_root="${HOME}/.local/state/streaming-release-guard"
export PUBLIC_HOST BEE_DATA_ROOT STACK_VERSIONS_ROOT MANAGER_SSH_DIR
if [ "$deployment_mode" = isolated ]; then
    isolation_root="${guard_state_root}/isolation/${project_name}"
    PUBLIC_HOST=""
    BEE_DATA_ROOT="${isolation_root}/data"
    STACK_VERSIONS_ROOT="${isolation_root}/versions"
    MANAGER_SSH_DIR="${isolation_root}/ssh"
else
    PUBLIC_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
    BEE_DATA_ROOT="${HOME}/streaming-infra-manager-data"
    STACK_VERSIONS_ROOT="${HOME}/streaming-infra-manager-versions"
    configured_ssh_dir="$(sed -n 's/^MANAGER_SSH_DIR=//p' "${manager_root}/.env" 2>/dev/null | tail -n 1 | tr -d '\r"' | tr -d "'")"
    MANAGER_SSH_DIR="${configured_ssh_dir:-${HOME}/manager-ssh}"
fi

port_available() {
    node - "$1" <<'NODE'
const net = require('node:net');
const port = Number(process.argv[2]);
const server = net.createServer();
server.once('error', () => process.exit(1));
server.listen({ host: '127.0.0.1', port }, () => server.close(() => process.exit(0)));
NODE
}

compose() {
    docker compose \
        --project-name "$project_name" \
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
        tree_digest="$(plan_value treeDigest)"
        work_root="$(cd "$(dirname "$plan")" && pwd -P)"
        mkdir -p "$BEE_DATA_ROOT" "$STACK_VERSIONS_ROOT" "$MANAGER_SSH_DIR"
        chmod 700 "$MANAGER_SSH_DIR"
        override="$(dirname "$plan")/manager-image-override.yml"
        umask 077
        cat > "$override" <<EOF
services:
  api:
    image: ${api_image}
    pull_policy: never
    environment:
      SHLS_ROOT: ${candidate_root}/manager/swarm-hls-stream
      MANAGER_ROOT: ${candidate_root}
      POSTGRES_PORT: "${POSTGRES_PORT}"
      WEB_PORT: "${WEB_PORT}"
      BEE_DATA_ROOT: ${BEE_DATA_ROOT}
      STACK_VERSIONS_ROOT: ${STACK_VERSIONS_ROOT}
      MANAGER_SSH_DIR: ${MANAGER_SSH_DIR}
    volumes:
      - type: bind
        source: ${candidate_root}
        target: ${candidate_root}
        read_only: true
      - type: bind
        source: ${work_root}
        target: ${work_root}
      - type: bind
        source: ${guard_code_root}
        target: /opt/streaming-release-guard
        read_only: true
      - type: bind
        source: ${guard_state_root}
        target: ${guard_state_root}
  web:
    image: ${web_image}
    pull_policy: never
volumes:
  manager-pg:
    name: ${postgres_volume_name}
EOF
        manager_domain="$(
            sed -n 's/^MANAGER_DOMAIN=//p' "${manager_root}/.env" 2>/dev/null |
                tail -n 1 |
                tr -d '\r' |
                tr '[:upper:]' '[:lower:]' |
                sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
                sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
        )"
        if [ "$deployment_mode" = isolated ] && [ -n "$manager_domain" ]; then
            echo "isolated manager release cannot enable the public edge" >&2
            exit 1
        fi
        postgres_volume="$postgres_volume_name"
        data_volume="$(docker volume ls -q --filter "name=^${postgres_volume}$")"
        api_containers="$(docker ps -aq \
            --filter "label=com.docker.compose.project=${project_name}" \
            --filter 'label=com.docker.compose.service=api' \
            --filter 'label=com.docker.compose.oneoff=False')"
        postgres_containers="$(docker ps -aq \
            --filter "label=com.docker.compose.project=${project_name}" \
            --filter 'label=com.docker.compose.service=postgres' \
            --filter 'label=com.docker.compose.oneoff=False')"
        if [ "$deployment_mode" = isolated ] && [ -z "$api_containers" ] && [ -z "$postgres_containers" ]; then
            if ! port_available "$POSTGRES_PORT" || ! port_available "$WEB_PORT"; then
                echo "manager isolated release port is already occupied" >&2
                exit 1
            fi
        fi
        is_first_use=false
        if [ -z "$data_volume" ]; then
            if [ -n "$api_containers" ]; then
                echo "manager release adapter found an api container without its database volume" >&2
                exit 1
            fi
            if [ -z "$postgres_containers" ]; then
                is_first_use=true
            fi
        fi
        upgrade_args=(
            node dist/cli.js manager:upgrade \
            --manager-commit "$release_commit" \
            --manager-digest "$tree_digest" \
            --image-id "$api_image" \
            --project "$project_name" \
            --compose-file "$compose_file" \
            --compose-override "$override" \
            --postgres-volume-name "$postgres_volume_name" \
            --mutable-root "$candidate_root"
        )
        if [ "$is_first_use" = true ]; then
            upgrade_args+=(--first-use)
        fi
        if [ -n "$manager_domain" ]; then
            upgrade_args+=(--public-edge)
        fi
        compose -f "$override" run --rm --no-deps -T api "${upgrade_args[@]}" < /dev/null
        ;;
    verify)
        api_container="$(compose ps -q api)"
        web_container="$(compose ps -q web)"
        postgres_container="$(compose ps -q postgres)"
        if ! [[ "$api_container" =~ ^[A-Za-z0-9_.:-]+$ ]] ||
            ! [[ "$web_container" =~ ^[A-Za-z0-9_.:-]+$ ]] ||
            ! [[ "$postgres_container" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
            echo "manager release adapter could not identify one running container per service" >&2
            exit 1
        fi
        api_status="$(docker inspect --format '{{.State.Status}}' "$api_container")"
        web_status="$(docker inspect --format '{{.State.Status}}' "$web_container")"
        web_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$web_container")"
        if [ "$api_status" != running ] || [ "$web_status" != running ] || [ "$web_health" != healthy ]; then
            echo "manager release adapter did not verify running healthy services" >&2
            exit 1
        fi
        api_image="$(docker inspect --format '{{.Image}}' "$api_container")"
        web_image="$(docker inspect --format '{{.Image}}' "$web_container")"
        manager_mount="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"${candidate_root}\"}}{{.Source}}{{end}}{{end}}" "$api_container")"
        data_mount="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"${BEE_DATA_ROOT}\"}}{{.Source}}{{end}}{{end}}" "$api_container")"
        versions_mount="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"${STACK_VERSIONS_ROOT}\"}}{{.Source}}{{end}}{{end}}" "$api_container")"
        ssh_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/root/.ssh"}}{{.Source}}{{end}}{{end}}' "$api_container")"
        if [ "$manager_mount" != "$candidate_root" ] ||
            [ "$data_mount" != "$BEE_DATA_ROOT" ] ||
            [ "$versions_mount" != "$STACK_VERSIONS_ROOT" ] ||
            [ "$ssh_mount" != "$MANAGER_SSH_DIR" ]; then
            echo "manager release adapter did not verify the bound manager mounts" >&2
            exit 1
        fi
        postgres_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$postgres_container")"
        if [ "$postgres_mount" != "$postgres_volume_name" ]; then
            echo "manager release adapter did not verify the bound database volume" >&2
            exit 1
        fi
        write_images "$api_image" "$web_image"
        ;;
esac
