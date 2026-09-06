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
