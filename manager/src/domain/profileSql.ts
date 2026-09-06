import { BUNDLED_VERSION_NAME } from '@streaming-infra-manager/common';

/**
 * SQL fragments shared by every repository that reads or writes `profiles`.
 *
 * These lived as private copies in ProfileRepository and
 * DeploymentGroupRepository, and the copies drifted: `bee_publishers` and
 * `bee_url` were added to one and not the other, so a group config PATCH
 * returned member rows with both fields `undefined`. Those rows go straight
 * into `startDeploy`, and `writeProfileEnv` rebuilds `.env.<profile>` from a
 * fresh copy of the base `.env` — so a column missing from this list is not
 * merely absent from the row, it is dropped from the deployed environment
 * while the database and the UI still show it set.
 *
 * One definition, so the next column added cannot repeat that.
 */
export const PROFILE_COLUMNS = `
  name, port_slot, kind, notes,
  components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
  bee_publishers, bee_url, srt_passphrase, engine_settings,
  status, last_error, last_error_at,
  created_at, updated_at, group_id, stack_version_id
`;

/** Advisory-lock key guarding port-slot allocation. ASCII "prof". */
export const PROFILE_SLOT_LOCK_KEY = 0x70726f66;

/**
 * The stack version a newly created deployment is put on.
 *
 * The bundled row by name, and deliberately not the row marked as the default.
 * Setting a default decides what the new deployment wizard will preselect, and
 * that wizard cannot choose a version yet, so reading is_default here would
 * make Set as default quietly move every deployment created after it onto a
 * version whose scripts have never run on this host. The next pull request adds
 * the select, and this becomes the version the operator picked.
 */
export const NEW_PROFILE_STACK_VERSION_SQL = `(SELECT id FROM stack_versions WHERE name = '${BUNDLED_VERSION_NAME}')`;
