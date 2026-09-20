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
const path = require('node:path');

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
const args = plan.arguments;
const target = args?.target;
const fixtureNetwork = args?.fixtureNetwork;
const guardInstallation = args?.guardInstallation;
const argumentKeys = args !== null && typeof args === 'object' && !Array.isArray(args)
  ? Object.keys(args).sort().join(',')
  : '';
const fixtureKeys = fixtureNetwork !== null && typeof fixtureNetwork === 'object' && !Array.isArray(fixtureNetwork)
  ? Object.keys(fixtureNetwork).sort().join(',')
  : '';
const expectedFixtureKeys = expectedPhase === 'preflight' ? 'fixtureId,name' : 'fixtureId,name,networkId';
const fixtureIsValid = fixtureNetwork === undefined || (
  fixtureKeys === expectedFixtureKeys &&
  typeof fixtureNetwork.fixtureId === 'string' &&
  /^srs-continuation-20260920-[a-z0-9]{8,16}$/.test(fixtureNetwork.fixtureId) &&
  fixtureNetwork.name === `${fixtureNetwork.fixtureId}-network` &&
  (expectedFixtureKeys === 'fixtureId,name' || /^[0-9a-f]{64}$/.test(fixtureNetwork.networkId))
);
const guardKeys = guardInstallation !== null && typeof guardInstallation === 'object' && !Array.isArray(guardInstallation)
  ? Object.keys(guardInstallation).sort().join(',')
  : '';
const guardIsValid = guardKeys === 'codeRoot,stateRoot' &&
  [guardInstallation.codeRoot, guardInstallation.stateRoot].every((value) =>
    typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value,
  );
if (
  (argumentKeys !== 'guardInstallation,target' && argumentKeys !== 'fixtureNetwork,guardInstallation,target') ||
  target === null ||
  typeof target !== 'object' ||
  Array.isArray(target) ||
  !fixtureIsValid ||
  !guardIsValid ||
  (fixtureNetwork !== undefined && target.mode !== 'isolated')
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
  if (
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
if (key.startsWith('fixtureNetwork:')) {
  const name = key.slice('fixtureNetwork:'.length);
  const value = fixtureNetwork?.[name] ?? '';
  if (typeof value !== 'string') process.exit(2);
  process.stdout.write(value);
  process.exit(0);
}
if (key.startsWith('guardInstallation:')) {
  const name = key.slice('guardInstallation:'.length);
  const value = guardInstallation[name];
  if (typeof value !== 'string') process.exit(2);
  process.stdout.write(value);
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
fixture_network_name="$(plan_value fixtureNetwork:name)"
fixture_id="$(plan_value fixtureNetwork:fixtureId)"
fixture_network_id="$(plan_value fixtureNetwork:networkId)"
manager_fixture_network_name="${project_name}-fixture-manager"
guard_code_root="$(plan_value guardInstallation:codeRoot)"
guard_state_root="$(plan_value guardInstallation:stateRoot)"
if ! node - "$guard_code_root" "$guard_state_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [codeRoot, stateRoot] = process.argv.slice(2);
try {
  for (const value of [codeRoot, stateRoot]) {
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value) !== value) process.exit(1);
  }
  const bindingPath = path.join(codeRoot, 'container-binding.json');
  const bindingStat = fs.lstatSync(bindingPath);
  if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || bindingStat.size < 1 || bindingStat.size > 4096) process.exit(1);
  const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  if (
    Object.keys(binding).sort().join(',') !== 'schemaVersion,stateRoot' ||
    binding.schemaVersion !== 1 ||
    binding.stateRoot !== stateRoot
  ) process.exit(1);
} catch {
  process.exit(1);
}
NODE
then
    echo "manager installed guard binding is invalid" >&2
    exit 1
fi
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

require_shared_fixture_network() {
    [ -n "$fixture_network_name" ] || return 0
    actual_fixture_network_id="$(docker network inspect --format '{{.Id}}' "$fixture_network_name")"
    if ! [[ "$actual_fixture_network_id" =~ ^[0-9a-f]{64}$ ]]; then
        echo "manager fixture network id is invalid" >&2
        exit 1
    fi
    if [ -n "$fixture_network_id" ] && [ "$actual_fixture_network_id" != "$fixture_network_id" ]; then
        echo "manager fixture network id does not match" >&2
        exit 1
    fi
    if [ "$(docker network inspect --format '{{.Internal}}' "$fixture_network_name")" != true ]; then
        echo "manager fixture network is not internal" >&2
        exit 1
    fi
    if [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.fixture"}}' "$fixture_network_name")" != "$fixture_id" ]; then
        echo "manager fixture network identity does not match" >&2
        exit 1
    fi
    if [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.managed"}}' "$fixture_network_name")" != true ]; then
        echo "manager fixture network is not managed" >&2
        exit 1
    fi
}

require_manager_fixture_network() {
    [ -n "$fixture_network_name" ] || return 0
    actual_manager_network_id="$(docker network inspect --format '{{.Id}}' "$manager_fixture_network_name")"
    if ! [[ "$actual_manager_network_id" =~ ^[0-9a-f]{64}$ ]]; then
        echo "manager private fixture network id is invalid" >&2
        exit 1
    fi
    if [ "$(docker network inspect --format '{{.Internal}}' "$manager_fixture_network_name")" != true ] ||
        [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.fixture"}}' "$manager_fixture_network_name")" != "$fixture_id" ] ||
        [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.managed"}}' "$manager_fixture_network_name")" != true ]; then
        echo "manager private fixture network identity does not match" >&2
        exit 1
    fi
}

require_fixture_container() {
    local container="$1"
    [ -n "$fixture_network_name" ] || return 0
    if [ "$(docker inspect --format '{{index .Config.Labels "org.solarpunk.srs-continuation.fixture"}}' "$container")" != "$fixture_id" ] ||
        [ "$(docker inspect --format '{{index .Config.Labels "org.solarpunk.srs-continuation.managed"}}' "$container")" != true ]; then
        echo "manager fixture container identity does not match" >&2
        exit 1
    fi
}

require_fixture_limits() {
    local container="$1"
    [ -n "$fixture_network_name" ] || return 0
    if [ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container")" != 1000000000 ] ||
        [ "$(docker inspect --format '{{.HostConfig.Memory}}' "$container")" != 1073741824 ] ||
        [ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" != 256 ]; then
        echo "manager fixture resource limits do not match" >&2
        exit 1
    fi
}

require_fixture_membership() {
    local container="$1"
    local role="$2"
    [ -n "$fixture_network_name" ] || return 0
    local networks
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$container")"
    if ! node - "$networks" "$role" "$manager_fixture_network_name" "$actual_manager_network_id" \
        "$fixture_network_name" "$actual_fixture_network_id" <<'NODE'
const [serialized, role, managerName, managerId, sharedName, sharedId] = process.argv.slice(2);
try {
  const networks = JSON.parse(serialized);
  const names = Object.keys(networks).sort();
  const expected = role === 'api' ? [managerName, sharedName].sort() : [managerName];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) process.exit(1);
  if (networks[managerName]?.NetworkID !== managerId) process.exit(1);
  if (role === 'api') {
    if (networks[sharedName]?.NetworkID !== sharedId) process.exit(1);
    const aliases = networks[sharedName]?.Aliases;
    if (!Array.isArray(aliases) || !aliases.includes('manager-api') || aliases.includes('api')) process.exit(1);
  }
} catch {
  process.exit(1);
}
NODE
    then
        echo "manager fixture network membership does not match" >&2
        exit 1
    fi
}

require_fixture_ports() {
    local container="$1"
    local role="$2"
    [ -n "$fixture_network_name" ] || return 0
    local ports
    ports="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$container")"
    if ! node - "$ports" "$role" "$POSTGRES_PORT" "$WEB_PORT" <<'NODE'
const [serialized, role, postgresPort, webPort] = process.argv.slice(2);
try {
  const ports = JSON.parse(serialized);
  const published = Object.entries(ports).flatMap(([containerPort, bindings]) =>
    Array.isArray(bindings) ? bindings.map((binding) => ({ containerPort, ...binding })) : [],
  );
  if (role === 'api') process.exit(published.length === 0 ? 0 : 1);
  const expectedContainerPort = role === 'postgres' ? '5432/tcp' : '80/tcp';
  const expectedHostPort = role === 'postgres' ? postgresPort : webPort;
  if (
    published.length !== 1 ||
    published[0].containerPort !== expectedContainerPort ||
    published[0].HostIp !== '127.0.0.1' ||
    published[0].HostPort !== expectedHostPort
  ) process.exit(1);
} catch {
  process.exit(1);
}
NODE
    then
        echo "manager fixture published ports do not match" >&2
        exit 1
    fi
}

require_fixture_volume() {
    [ -n "$fixture_network_name" ] || return 0
    if [ "$(docker volume inspect --format '{{.Name}}' "$postgres_volume_name")" != "$postgres_volume_name" ] ||
        [ "$(docker volume inspect --format '{{index .Labels "org.solarpunk.srs-continuation.fixture"}}' "$postgres_volume_name")" != "$fixture_id" ] ||
        [ "$(docker volume inspect --format '{{index .Labels "org.solarpunk.srs-continuation.managed"}}' "$postgres_volume_name")" != true ]; then
        echo "manager fixture database volume identity does not match" >&2
        exit 1
    fi
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
        require_shared_fixture_network
        node - "$output" "$guard_code_root" "$guard_state_root" "${actual_fixture_network_id:-}" <<'NODE'
const fs = require('node:fs');
const [output, codeRoot, stateRoot, fixtureNetworkId] = process.argv.slice(2);
const result = {
  schemaVersion: 1,
  ...(fixtureNetworkId ? { fixtureNetworkId } : {}),
  guardInstallation: { codeRoot, stateRoot },
};
fs.writeFileSync(output, `${JSON.stringify(result)}\n`, { mode: 0o600 });
NODE
        ;;
    build)
        require_shared_fixture_network
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
        require_shared_fixture_network
        api_image="$(plan_value image:api)"
        web_image="$(plan_value image:web)"
        tree_digest="$(plan_value treeDigest)"
        work_root="$(cd "$(dirname "$plan")" && pwd -P)"
        mkdir -p "$BEE_DATA_ROOT" "$STACK_VERSIONS_ROOT" "$MANAGER_SSH_DIR"
        chmod 700 "$MANAGER_SSH_DIR"
        override="$(dirname "$plan")/manager-image-override.yml"
        umask 077
        if [ -n "$fixture_network_name" ]; then
            cat > "$override" <<EOF
services:
  postgres:
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    networks:
      fixture_manager:
    ports: !override
      - "127.0.0.1:${POSTGRES_PORT}:5432"
    cpus: 1
    mem_limit: 1073741824
    pids_limit: 256
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
      RELEASE_GUARD_STATE_ROOT: ${guard_state_root}
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    networks:
      fixture_manager:
    ports: !reset []
    cpus: 1
    mem_limit: 1073741824
    pids_limit: 256
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
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    networks:
      fixture_manager:
    ports: !override
      - "127.0.0.1:${WEB_PORT}:80"
    cpus: 1
    mem_limit: 1073741824
    pids_limit: 256
volumes:
  manager-pg:
    name: ${postgres_volume_name}
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
networks:
  fixture_manager:
    name: ${manager_fixture_network_name}
    internal: true
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
EOF
        else
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
      RELEASE_GUARD_STATE_ROOT: ${guard_state_root}
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
        fi
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
        if [ -n "$fixture_network_name" ]; then
            require_manager_fixture_network
            api_container="$(compose -f "$override" ps -q api)"
            if ! [[ "$api_container" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
                echo "manager release adapter could not identify the api container for fixture attachment" >&2
                exit 1
            fi
            require_fixture_container "$api_container"
            api_networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$api_container")"
            shared_membership="$(node - "$api_networks" "$fixture_network_name" "$actual_fixture_network_id" <<'NODE'
const [serialized, name, id] = process.argv.slice(2);
try {
  const network = JSON.parse(serialized)[name];
  if (!network) process.stdout.write('missing');
  else if (network.NetworkID !== id) process.stdout.write('wrong');
  else {
    const aliases = network.Aliases;
    process.stdout.write(Array.isArray(aliases) && aliases.includes('manager-api') && !aliases.includes('api') ? 'exact' : 'wrong');
  }
} catch {
  process.stdout.write('wrong');
}
NODE
)"
            case "$shared_membership" in
                missing) docker network connect --alias manager-api "$actual_fixture_network_id" "$api_container" ;;
                exact) ;;
                *)
                    echo "manager fixture api has a conflicting shared-network attachment" >&2
                    exit 1
                    ;;
            esac
        fi
        ;;
    verify)
        require_shared_fixture_network
        override="$(dirname "$plan")/manager-image-override.yml"
        if [ ! -f "$override" ] || [ -L "$override" ]; then
            echo "manager release adapter image override is missing" >&2
            exit 1
        fi
        api_container="$(compose -f "$override" ps -q api)"
        web_container="$(compose -f "$override" ps -q web)"
        postgres_container="$(compose -f "$override" ps -q postgres)"
        if ! [[ "$api_container" =~ ^[A-Za-z0-9_.:-]+$ ]] ||
            ! [[ "$web_container" =~ ^[A-Za-z0-9_.:-]+$ ]] ||
            ! [[ "$postgres_container" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
            echo "manager release adapter could not identify one running container per service" >&2
            exit 1
        fi
        api_status="$(docker inspect --format '{{.State.Status}}' "$api_container")"
        web_status="$(docker inspect --format '{{.State.Status}}' "$web_container")"
        postgres_status="$(docker inspect --format '{{.State.Status}}' "$postgres_container")"
        web_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$web_container")"
        postgres_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")"
        if [ "$api_status" != running ] || [ "$web_status" != running ] || [ "$postgres_status" != running ] ||
            [ "$web_health" != healthy ] || [ "$postgres_health" != healthy ]; then
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
        if [ -n "$fixture_network_name" ]; then
            require_manager_fixture_network
            require_fixture_container "$api_container"
            require_fixture_limits "$api_container"
            require_fixture_membership "$api_container" api
            require_fixture_ports "$api_container" api
            require_fixture_container "$web_container"
            require_fixture_limits "$web_container"
            require_fixture_membership "$web_container" web
            require_fixture_ports "$web_container" web
            require_fixture_container "$postgres_container"
            require_fixture_limits "$postgres_container"
            require_fixture_membership "$postgres_container" postgres
            require_fixture_ports "$postgres_container" postgres
            require_fixture_volume
        fi
        write_images "$api_image" "$web_image"
        ;;
esac
