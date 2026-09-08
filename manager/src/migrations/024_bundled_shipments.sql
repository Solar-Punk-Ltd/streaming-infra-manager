-- Existing rows begin at the protocol's initial revision, not a reconstructed history.
ALTER TABLE stack_versions ADD COLUMN publication_revision BIGINT NOT NULL DEFAULT 0
  CHECK (publication_revision >= 0);

CREATE FUNCTION advance_stack_publication_revision() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.publication_revision IS NULL OR
     (NEW.publication_revision IS DISTINCT FROM OLD.publication_revision AND
      NEW.publication_revision <> OLD.publication_revision + 1) THEN
    RAISE EXCEPTION 'publication revision must stay unchanged or advance by one';
  END IF;

  IF ROW(NEW.name, NEW.root_path, NEW.layout, NEW.build_id, NEW.commit_sha, NEW.contract)
     IS DISTINCT FROM
     ROW(OLD.name, OLD.root_path, OLD.layout, OLD.build_id, OLD.commit_sha, OLD.contract) THEN
    NEW.publication_revision := OLD.publication_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stack_publication_revision
BEFORE UPDATE ON stack_versions
FOR EACH ROW EXECUTE FUNCTION advance_stack_publication_revision();
