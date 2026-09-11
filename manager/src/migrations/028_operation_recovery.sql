-- Historical operations keep NULL evidence. A path or an old commit is not
-- proof of the artifact whose previous config the operation can restore.
ALTER TABLE engine_config_operations
  ADD COLUMN recovery_descriptor JSONB,
  ADD COLUMN recovery_reference_id INTEGER UNIQUE CHECK (recovery_reference_id > 0),
  ADD COLUMN deployment_job_reference_id INTEGER UNIQUE CHECK (deployment_job_reference_id > 0),
  ADD CONSTRAINT operation_recovery_complete CHECK (
    (recovery_descriptor IS NULL AND recovery_reference_id IS NULL AND deployment_job_reference_id IS NULL)
    OR (recovery_descriptor IS NOT NULL AND recovery_reference_id IS NOT NULL AND deployment_job_reference_id IS NOT NULL)
  ),
  ADD CONSTRAINT operation_recovery_format CHECK (
    recovery_descriptor IS NULL OR COALESCE(
      jsonb_typeof(recovery_descriptor) = 'object'
      AND recovery_descriptor->>'format' = '1'
      AND recovery_descriptor->>'kind' IN ('immutable-build', 'legacy-unproven'), false)
  );

-- These are historical identities, not cascading foreign keys. Live holds
-- block version removal. Releasing them must not erase operation history.
CREATE FUNCTION preserve_operation_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.recovery_descriptor IS NOT NULL AND (
      NEW.recovery_descriptor IS DISTINCT FROM OLD.recovery_descriptor
      OR NEW.recovery_reference_id IS DISTINCT FROM OLD.recovery_reference_id) THEN
    RAISE EXCEPTION 'Operation recovery evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_recovery_immutable BEFORE UPDATE ON engine_config_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_operation_recovery();
