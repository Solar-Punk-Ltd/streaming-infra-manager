ALTER TABLE engine_config_operations
  DROP CONSTRAINT engine_config_operations_kind_check,
  ADD CONSTRAINT engine_config_operations_kind_check CHECK (kind IN ('apply', 'reset', 'restore-previous')),
  ADD COLUMN source_operation_id INTEGER,
  ADD CONSTRAINT operation_restore_source CHECK (
    (kind = 'restore-previous' AND source_operation_id IS NOT NULL AND source_operation_id > 0 AND source_operation_id < id)
    OR (kind <> 'restore-previous' AND source_operation_id IS NULL)
  );

-- A historical NULL is absence of evidence. It must not acquire an invented
-- ancestor after insertion, even when a later operator chooses to restore.
CREATE FUNCTION preserve_operation_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_operation_id IS DISTINCT FROM OLD.source_operation_id THEN
    RAISE EXCEPTION 'Operation source lineage is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_lineage_immutable BEFORE UPDATE ON engine_config_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_operation_lineage();
