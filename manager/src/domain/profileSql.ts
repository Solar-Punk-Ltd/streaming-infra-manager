/**
 * SQL fragments shared by every repository that reads or writes `profiles`.
 *
 * These lived as private copies in ProfileRepository and
 * DeploymentGroupRepository, and the copies drifted: `bee_publishers` and
 * `bee_url` were added to one and not the other, so a group config PATCH
 * returned member rows with both fields `undefined`. Those rows go straight
 * into `startDeploy`, and `writeProfileEnv` rebuilds `.env.<profile>` from a
 * fresh copy of the base `.env`, so a column missing from this list is not
 * merely absent from the row, it is dropped from the deployed environment
 * while the database and the UI still show it set.
 *
 * One definition, so the next column added cannot repeat that.
 *
 * What the list leaves out matters as much as what it carries. A row travels:
 * every profile read answers it to the browser and every `profile.changed`
 * event publishes it to every subscriber, so a secret selected here reaches
 * every signed-in user on every list and every status change. `private_key`,
 * `stack_secrets`, `engine_config` and `srt_passphrase` are read on their own
 * instead, and the row carries only whether each is set.
 *
 * The passphrase is the one of those a page has to see, because it goes in the
 * broadcaster's SRT URL. It asks for that one deployment's through
 * `GET /profiles/:name/srt-passphrase` when an operator is about to publish,
 * rather than every page holding every deployment's at all times.
 */
export const PROFILE_COLUMNS = `
  name, port_slot, kind, notes, notes_revision,
  components, host, feed_owner, feed_topic, public_key, stamp_id,
  (private_key IS NOT NULL) AS has_private_key,
  bee_publishers, bee_url, rpc_endpoint, engine_settings,
  (srt_passphrase IS NOT NULL) AS has_srt_passphrase,
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
