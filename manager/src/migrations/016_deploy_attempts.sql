-- Every deploy attempt, durably: the project guard and the daemon lock.
--
-- The stack names its built images by service alone, so two deployments
-- building at once move one shared tag and a container can be created from
-- the other project's image (R04, reproduced). Every attempt holds its
-- Compose project until it resolves, so nothing else creates containers in
-- that project meanwhile, and an attempt on a version that builds shared
-- tags holds the daemon against every other such attempt.
--
-- An attempt resolves by evidence only: pre_job_container_ids is every
-- container of the project, all states, before the attempt spawned, and the
-- attempt is released once every service it touched shows a container id
-- that is not in that set. Compose creates every container after every
-- build, so that proves the build finished. Anything less is blocked, with
-- the reason, and a person who checked the host releases it, recorded in
-- released_by. Elapsed time never releases anything.
CREATE TABLE deploy_attempts (
  id                     SERIAL PRIMARY KEY,
  daemon_id              TEXT NOT NULL,
  project                TEXT NOT NULL,
  job_id                 TEXT NOT NULL UNIQUE,
  kind                   TEXT NOT NULL CHECK (kind IN ('shared', 'fixed')),
  services               TEXT[] NOT NULL DEFAULT '{}',
  pre_job_container_ids  TEXT[] NOT NULL DEFAULT '{}',
  state                  TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'released', 'blocked')),
  reason                 TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMPTZ,
  released_by            TEXT
);

CREATE INDEX deploy_attempts_unresolved ON deploy_attempts (daemon_id, project) WHERE state <> 'released';
