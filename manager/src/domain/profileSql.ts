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
  bee_publishers, bee_url,
  status, last_error, last_error_at,
  created_at, updated_at, group_id
`;

/** Advisory-lock key guarding port-slot allocation. ASCII "prof". */
export const PROFILE_SLOT_LOCK_KEY = 0x70726f66;
