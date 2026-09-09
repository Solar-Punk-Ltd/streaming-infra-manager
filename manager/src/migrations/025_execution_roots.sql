-- A name-only historical job hold still protects its build, but cannot prove
-- which deployment instance or operator intent may launch a writable copy.
ALTER TABLE build_references ADD COLUMN profile_instance_id UUID;
ALTER TABLE build_references ADD COLUMN intent_revision INTEGER CHECK (intent_revision >= 0);
ALTER TABLE build_references DROP CONSTRAINT build_references_holder_kind_check;
ALTER TABLE build_references ADD CONSTRAINT build_references_holder_kind_check
  CHECK (holder_kind IN ('job', 'snapshot', 'operation', 'execution'));

-- Identity survives profile removal. These recorded ids are historical facts,
-- not cascading ownership of a profile or reference row. Registration validates
-- them under locks and creates a separate live build hold in the same commit.
CREATE TABLE execution_roots (
  execution_id UUID PRIMARY KEY,
  version_id INTEGER NOT NULL,
  build_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  source_root TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  profile_name TEXT NOT NULL,
  profile_instance_id UUID NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision >= 0),
  profile_status TEXT NOT NULL,
  job_reference_id INTEGER NOT NULL UNIQUE,
  target_alias TEXT NOT NULL,
  daemon_id TEXT NOT NULL,
  project TEXT NOT NULL CHECK (project = profile_name),
  action TEXT NOT NULL CHECK (action IN ('deploy', 'stop', 'remove', 'health')),
  services TEXT[] NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  reference_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'registered'
    CHECK (state IN ('registered', 'copying', 'ready', 'launch-uncertain', 'deleting', 'released')),
  copy_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state NOT IN ('copying', 'ready', 'launch-uncertain') OR copy_token IS NOT NULL)
);

CREATE INDEX execution_roots_unreleased ON execution_roots (version_id, build_id)
  WHERE state <> 'released';
