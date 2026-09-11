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
  name, port_slot, kind, notes, notes_revision,
  components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
  bee_publishers, bee_url, srt_passphrase, engine_settings,
  (engine_config IS NOT NULL) AS has_engine_config, engine_config_error, engine_config_state,
  instance_id, engine_config_revision, intent_revision,
  status, deployment_phase, last_error, last_error_at, last_full_deploy_commit,
  created_at, updated_at, group_id, stack_version_id
`;

/** Advisory-lock key guarding port-slot allocation. ASCII "prof". */
export const PROFILE_SLOT_LOCK_KEY = 0x70726f66;

/** The enclosing query names its profile `owner`. Partial historical ownership cannot prove an unrelated instance. */
export const OPERATION_HOLD_FOR_OWNER_SQL = `holder_kind = 'operation' AND resolved_at IS NULL
  AND (profile_instance_id IS NULL OR intent_revision IS NULL OR profile_instance_id = owner.instance_id)`;

/** Evaluated in the status UPDATE, against the row that wins the transition. */
export const DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL = `CASE
  WHEN status = 'RUNNING' THEN 'restarting'
  WHEN status = 'STOPPED' THEN 'starting'
  ELSE NULL END`;
