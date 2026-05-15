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
  components     TEXT[],
  host           TEXT,
  feed_owner     TEXT,
  feed_topic     TEXT,
  private_key    TEXT,
  public_key     TEXT,
  stamp_id       TEXT,
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

CREATE TABLE containers (
  profile_name   TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
  service        TEXT NOT NULL,
  ports          JSONB NOT NULL DEFAULT '{}'::jsonb,
  env            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_name, service)
);

CREATE INDEX containers_profile_idx ON containers (profile_name);
