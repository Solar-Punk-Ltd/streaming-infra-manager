-- Profiles registry. The single source of truth for which port_prefix is in use.
-- port_prefix is constrained to 1-9 because deploy.sh's `--portPrefix` accepts a
-- single digit and prepends it to the default port (e.g. "2" + "1633" = "21633").
-- 0 is reserved for "no prefix" / unmanaged deployments.

CREATE TABLE profiles (
  name           TEXT PRIMARY KEY,
  port_prefix    SMALLINT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'custom',
  notes          TEXT,
  -- Lifecycle status. Transitions are driven by HTTP triggers + async script runs.
  -- Transitional states (DEPLOYING/STOPPING/REMOVING) reject concurrent triggers
  -- with 409. On manager restart, any row stuck in a transitional state is reset
  -- to ERROR (the in-process orchestrator that would update it is gone).
  status         TEXT NOT NULL DEFAULT 'DEPLOYING',
  last_error     TEXT,
  last_error_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT profiles_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT profiles_prefix_range CHECK (port_prefix BETWEEN 1 AND 9),
  CONSTRAINT profiles_kind_known CHECK (kind IN ('streamer', 'viewer', 'custom')),
  CONSTRAINT profiles_status_known CHECK (
    status IN ('DEPLOYING', 'RUNNING', 'STOPPING', 'STOPPED', 'REMOVING', 'ERROR')
  )
);

CREATE INDEX profiles_kind_idx ON profiles (kind);
CREATE INDEX profiles_status_idx ON profiles (status);
