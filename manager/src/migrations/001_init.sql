-- Profiles registry. The single source of truth for which port_slot is in use.
-- port_slot is an integer 1-999 that deploy.sh's `--portSlot` consumes; each slot N
-- shifts every default *_PORT by N*10 (e.g. API_PORT 10000 → 10010 at slot 1,
-- 10020 at slot 2, ...). Service identity lives in the last digit of each default
-- (0-8), so slots never collide between services. 0 is reserved for "no slot" /
-- unmanaged deployments and is not stored here.

CREATE TABLE profiles (
  name           TEXT PRIMARY KEY,
  port_slot      SMALLINT NOT NULL UNIQUE,
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
  CONSTRAINT profiles_slot_range CHECK (port_slot BETWEEN 1 AND 999),
  CONSTRAINT profiles_kind_known CHECK (kind IN ('streamer', 'viewer', 'custom')),
  CONSTRAINT profiles_status_known CHECK (
    status IN ('DEPLOYING', 'RUNNING', 'STOPPING', 'STOPPED', 'REMOVING', 'ERROR')
  )
);

CREATE INDEX profiles_kind_idx ON profiles (kind);
CREATE INDEX profiles_status_idx ON profiles (status);
