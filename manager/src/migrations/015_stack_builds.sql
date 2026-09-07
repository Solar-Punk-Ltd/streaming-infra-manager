-- One immutable directory per build, and the row as the reference to it.
--
-- The build script used to move a version's checkout to the new commit,
-- build in place and copy over the flat root, so a failed update left a
-- mixed tree, a deploy admitted during the update ran on it, and a container
-- restart picked up new files under an old container.
--
-- layout says where a version deploys from. legacy is every row that exists
-- when this migration runs: its flat root, exactly as before, until its first
-- publication under the new layout flips it to builds in the same row update
-- that publishes. builds deploys from <name>.builds/<build_id>, one immutable
-- directory per build, and never from the flat root, which keeps only the
-- host-owned inputs from then on. build_id is the commit, or <commit>-r<n>
-- for the same commit published again with other inputs. previous_build_id
-- is the build the current one replaced, kept for recovery until nothing
-- references it.
--
-- build_references is what keeps a build directory alive: a deploy claim
-- inserts a job reference for the build it will run, the success hook writes
-- one snapshot reference per service from what the containers actually
-- mount, and a job reference resolves only when newer observed snapshots
-- cover every service it named. Failure, a failed snapshot and a crash leave
-- it unresolved. Prune protects every build with an unresolved job reference
-- or a snapshot reference, and the current and previous builds, which are
-- the row's own columns rather than rows here.
ALTER TABLE stack_versions ADD COLUMN layout TEXT NOT NULL DEFAULT 'legacy'
  CHECK (layout IN ('legacy', 'builds'));
ALTER TABLE stack_versions ADD COLUMN build_id TEXT;
ALTER TABLE stack_versions ADD COLUMN previous_build_id TEXT;

CREATE TABLE build_references (
  id            SERIAL PRIMARY KEY,
  version_id    INTEGER NOT NULL REFERENCES stack_versions(id) ON DELETE CASCADE,
  build_id      TEXT NOT NULL,
  holder_kind   TEXT NOT NULL CHECK (holder_kind IN ('job', 'snapshot', 'operation')),
  holder_id     TEXT NOT NULL,
  services      TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX build_references_open ON build_references (version_id, build_id) WHERE resolved_at IS NULL;
CREATE INDEX build_references_holder ON build_references (holder_kind, holder_id);
