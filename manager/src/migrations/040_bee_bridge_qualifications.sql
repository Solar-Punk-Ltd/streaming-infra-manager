-- The Bee image and Docker engine pairs the manager checked itself before any
-- transfer went through a bridge in them. The catalog in
-- src/domain/chequebook/beeBridgeQualification.ts stays as the seed, and this
-- table holds every other pair: a check that reads, and never writes, whether
-- the four paths the bridge script runs are there and executable and whether
-- bash has /dev/tcp.
--
-- A pass qualifies exactly its tuple, under the check revision that made it.
-- A failure is kept as history with the check it failed, and qualifies
-- nothing: a later transfer checks again. Two first transfers racing on a new
-- tuple both check, and the partial unique index below lets one pass land
-- without failures ever colliding with it or with each other.
--
-- Numbered 040 because the deployment settings branches open at the time of
-- writing take 036 to 038.
CREATE TABLE bee_bridge_qualifications (
  id BIGSERIAL PRIMARY KEY,
  image_id TEXT NOT NULL CHECK (image_id ~ '^sha256:[a-f0-9]{64}$'),
  engine_version TEXT NOT NULL CHECK (engine_version ~ '^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$'),
  platform_os TEXT NOT NULL CHECK (platform_os ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  platform_architecture TEXT NOT NULL CHECK (platform_architecture ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  platform_variant TEXT NOT NULL CHECK (platform_variant = '' OR platform_variant ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  bridge_revision TEXT NOT NULL CHECK (bridge_revision ~ '^sha256:[a-f0-9]{64}$'),
  harness_revision TEXT NOT NULL CHECK (harness_revision ~ '^sha256:[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  failed_check TEXT CHECK (failed_check IN ('env', 'timeout', 'bash', 'cat', 'dev_tcp', 'answer')),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  host_alias TEXT NOT NULL CHECK (host_alias ~ '^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$'),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((outcome = 'passed') = (failed_check IS NULL))
);

CREATE UNIQUE INDEX bee_bridge_qualifications_one_pass ON bee_bridge_qualifications
  (image_id, engine_version, platform_os, platform_architecture, platform_variant, bridge_revision, harness_revision)
  WHERE outcome = 'passed';
