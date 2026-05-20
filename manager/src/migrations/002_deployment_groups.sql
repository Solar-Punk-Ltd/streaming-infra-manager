CREATE TABLE deployment_groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deployment_groups_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT deployment_groups_size_positive CHECK (size >= 1)
);

ALTER TABLE profiles
  ADD COLUMN group_id INTEGER REFERENCES deployment_groups(id) ON DELETE SET NULL;

CREATE INDEX profiles_group_idx ON profiles (group_id);
