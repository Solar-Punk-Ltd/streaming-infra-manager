/**
 * The two labels docker compose puts on every container it creates, and the
 * only way the manager can find one.
 *
 * A deployment's compose project is its profile name and its service is the
 * name in `deploy/docker-compose.yml`, so the pair identifies exactly one
 * container. Container names are not usable for this: compose appends its own
 * index and the separator has changed between compose versions.
 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/**
 * Where the compose project was started from: the directory of the compose
 * file, which for a stack is `<root>/deploy`. It is how the manager learns
 * which build a running container was created from, from the container
 * itself rather than from what a deploy planned.
 */
export const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
