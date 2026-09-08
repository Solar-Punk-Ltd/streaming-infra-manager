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

CREATE TABLE bundled_shipments (
  shipment_id UUID PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES stack_versions(id) ON DELETE RESTRICT,
  package_digest TEXT NOT NULL CHECK (package_digest ~ '^[a-f0-9]{64}$'),
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  expected_publication_revision BIGINT NOT NULL CHECK (expected_publication_revision >= 0),
  root_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'registered' CHECK (state IN ('registered', 'prepared', 'published', 'superseded')),
  candidate_build_id TEXT CHECK (candidate_build_id ~ '^[a-f0-9]{40}(-r[1-9][0-9]*)?$'),
  candidate_kind TEXT CHECK (candidate_kind IN ('new', 'reuse')),
  candidate_manifest JSONB,
  artifact_digest TEXT CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  candidate_contract JSONB,
  receipt_revision BIGINT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (candidate_build_id IS NULL AND candidate_kind IS NULL AND candidate_manifest IS NULL) OR
    (candidate_build_id IS NOT NULL AND candidate_kind IS NOT NULL AND candidate_manifest IS NOT NULL
     AND jsonb_typeof(candidate_manifest) = 'object'
     AND candidate_manifest->>'buildId' IS NOT DISTINCT FROM candidate_build_id
     AND candidate_manifest->>'commit' IS NOT DISTINCT FROM commit_sha)
  ),
  CHECK ((artifact_digest IS NULL) = (candidate_contract IS NULL)),
  CHECK (candidate_contract IS NULL OR jsonb_typeof(candidate_contract) = 'object'),
  CHECK (artifact_digest IS NULL OR candidate_build_id IS NOT NULL),
  CHECK (state NOT IN ('prepared', 'published') OR artifact_digest IS NOT NULL),
  CHECK (state <> 'registered' OR artifact_digest IS NULL),
  CHECK (
    (state = 'published' AND receipt_revision IS NOT NULL AND published_at IS NOT NULL) OR
    (state <> 'published' AND receipt_revision IS NULL AND published_at IS NULL)
  ),
  CHECK (receipt_revision IS NULL OR receipt_revision = expected_publication_revision + 1)
);

CREATE UNIQUE INDEX bundled_shipment_candidate_owner ON bundled_shipments (version_id, candidate_build_id)
  WHERE candidate_kind = 'new';
CREATE INDEX bundled_shipment_pending_build ON bundled_shipments (version_id, candidate_build_id)
  WHERE state IN ('registered', 'prepared') AND candidate_build_id IS NOT NULL;

CREATE FUNCTION preserve_bundled_shipment_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.shipment_id, NEW.version_id, NEW.package_digest, NEW.commit_sha,
         NEW.expected_publication_revision, NEW.root_path, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.shipment_id, OLD.version_id, OLD.package_digest, OLD.commit_sha,
         OLD.expected_publication_revision, OLD.root_path, OLD.created_at) THEN
    RAISE EXCEPTION 'registered shipment identity cannot change';
  END IF;
  IF OLD.candidate_build_id IS NOT NULL AND
     ROW(NEW.candidate_build_id, NEW.candidate_kind, NEW.candidate_manifest)
     IS DISTINCT FROM ROW(OLD.candidate_build_id, OLD.candidate_kind, OLD.candidate_manifest) THEN
    RAISE EXCEPTION 'reserved shipment candidate cannot change';
  END IF;
  IF OLD.artifact_digest IS NOT NULL AND
     ROW(NEW.artifact_digest, NEW.candidate_contract)
     IS DISTINCT FROM ROW(OLD.artifact_digest, OLD.candidate_contract) THEN
    RAISE EXCEPTION 'prepared shipment identity cannot change';
  END IF;
  IF OLD.state IN ('published', 'superseded') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'resolved shipment receipt cannot change';
  END IF;
  IF OLD.state = 'prepared' AND NEW.state = 'registered' THEN
    RAISE EXCEPTION 'prepared shipment cannot become unprepared';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bundled_shipment_identity
BEFORE UPDATE ON bundled_shipments
FOR EACH ROW EXECUTE FUNCTION preserve_bundled_shipment_identity();
