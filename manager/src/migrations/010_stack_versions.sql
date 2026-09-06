-- Several versions of the streaming stack side by side.
--
-- A version is a git ref pinned to a commit, checked out once and built once.
-- `contract` holds what the manager read out of that checkout instead of
-- assuming it: the port table, the port slot ceiling, the secrets the
-- containers refuse to start without, and the engine defaults.
--
-- root_path NULL means the bundled version, the checkout the manager ships
-- with. Only the running manager knows where that is (SHLS_ROOT, or the
-- submodule next to its own source), so a migration cannot write it and the
-- manager resolves it instead. commit_sha is filled at boot for the same
-- reason: on the deploy host the tree arrives over rsync without a .git, so the
-- commit is read from manager/.stack-commit, which deploy/deploy.sh writes.
CREATE TABLE stack_versions (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  git_ref      TEXT NOT NULL,
  commit_sha   TEXT,
  status       TEXT NOT NULL DEFAULT 'building',
  root_path    TEXT,
  contract     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  tested       BOOLEAN NOT NULL DEFAULT false,
  built_at     TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stack_versions_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT stack_versions_status_known CHECK (status IN ('building', 'ready', 'failed'))
);

-- A partial unique index over a boolean: only the true rows are indexed, so
-- exactly one version can be the default and any number can be not.
CREATE UNIQUE INDEX stack_versions_one_default ON stack_versions (is_default) WHERE is_default;

-- Tested from the start: this is the version every deployment on the host has
-- been running, so the one real deployment the flag stands for has happened
-- many times over. Only a tested version can be made the default.
INSERT INTO stack_versions (name, git_ref, status, root_path, is_default, tested)
VALUES ('bundled', 'main-v2', 'ready', NULL, true, true);

ALTER TABLE profiles ADD COLUMN stack_version_id INTEGER REFERENCES stack_versions(id);
UPDATE profiles SET stack_version_id = (SELECT id FROM stack_versions WHERE name = 'bundled');
ALTER TABLE profiles ALTER COLUMN stack_version_id SET NOT NULL;

-- The per deployment values a version's contract lists as required secrets, for
-- example API_AUTH_TOKEN and SRS_WEBHOOK_TOKEN on main-v3. Added now so the
-- column exists before anything needs it. Nothing writes or reads it in this
-- change: the third stack versions pull request generates the values, writes
-- them into .env.<profile> at deploy, and never returns them from the API.
ALTER TABLE profiles ADD COLUMN stack_secrets JSONB NOT NULL DEFAULT '{}'::jsonb;
