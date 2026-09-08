-- Who owns a config file rollout, durably.
--
-- A rollout used to live in a closure: the previous file, and a watch that
-- would put it back. A watch that woke after the operator had saved another
-- file, stopped the deployment, or removed and recreated it under the same
-- name acted on a deployment that was no longer the one it was started on,
-- and a manager restart forgot the rollout entirely, file applied and engine
-- never verified.
--
-- Three columns on the row say who a rollout may act on. instance_id is the
-- deployment as it exists now: a removed and recreated name is another
-- instance, and every existing row gets its own value here. Rows that were
-- deployed before this migration keep running as they are, on the template or
-- on the file they have, and their first rollout after it starts at revision
-- zero. engine_config_revision moves with every config file write, so a write
-- that expects an older revision finds nothing to update. intent_revision moves
-- whenever an operator acts on the deployment, stop, start, edit, remove, apply
-- or reset, so a rollout started under an older intent finds every one of its
-- later writes refused. engine_config_state mirrors the state of the
-- deployment's latest rollout, so the row that travels to the browser says
-- where the rollout stands without another read.
--
-- engine_config_operations is the rollout itself, one row per apply or reset:
-- the file to put back, the container the watch verified, the revisions the
-- rollout owns, and where it stands. The open states hold at most one
-- operation per instance, enforced by the partial unique index, so a second
-- rollout has to supersede the first before it can store anything. A removed
-- deployment keeps its history rows, which is why profile_name is not a
-- foreign key.
ALTER TABLE profiles ADD COLUMN instance_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE profiles ADD COLUMN engine_config_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN intent_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN engine_config_state TEXT
  CHECK (engine_config_state IN (
    'applying', 'watching', 'applied', 'reverting', 'reverted', 'failed', 'interrupted', 'superseded'
  ));

CREATE TABLE engine_config_operations (
  id SERIAL PRIMARY KEY,
  profile_name TEXT NOT NULL,
  profile_instance_id UUID NOT NULL,
  engine TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('apply', 'reset')),
  previous_config TEXT,
  previous_is_template BOOLEAN NOT NULL,
  applied_revision INTEGER NOT NULL,
  intent_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'applying', 'watching', 'applied', 'reverting', 'reverted', 'failed', 'interrupted', 'superseded'
  )),
  container_id TEXT,
  container_started_at TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recreate_finished_at TIMESTAMPTZ,
  watch_started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  message TEXT
);

CREATE UNIQUE INDEX engine_config_operations_one_open
  ON engine_config_operations (profile_instance_id)
  WHERE state IN ('applying', 'watching', 'reverting', 'interrupted');

CREATE INDEX engine_config_operations_by_profile
  ON engine_config_operations (profile_name, id DESC);
