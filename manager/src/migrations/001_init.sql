-- Profiles registry. The single source of truth for which port_prefix is in use.
-- port_prefix is constrained to 1-9 because deploy.sh's `--portPrefix` accepts a
-- single digit and prepends it to the default port (e.g. "2" + "1633" = "21633").
-- 0 is reserved for "no prefix" / unmanaged deployments.

CREATE TABLE profiles (
  name         TEXT PRIMARY KEY,
  port_prefix  SMALLINT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'custom',
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT profiles_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT profiles_prefix_range CHECK (port_prefix BETWEEN 1 AND 9),
  CONSTRAINT profiles_kind_known CHECK (kind IN ('streamer', 'viewer', 'custom'))
);

CREATE INDEX profiles_kind_idx ON profiles (kind);
