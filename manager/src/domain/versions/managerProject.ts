/**
 * What the manager's own Compose project calls the parts an upgrade has to ask
 * Docker about.
 *
 * Declared in `manager/docker-compose.yml` and named here again, because the
 * upgrade runs against a host it cannot ask what that file says. A rename on
 * one side and not the other is only found out by a deploy, so the two are
 * changed together.
 */

/** The volume holding the database, without the project name Compose prefixes it with. */
export const MANAGER_POSTGRES_VOLUME = 'manager-pg';
