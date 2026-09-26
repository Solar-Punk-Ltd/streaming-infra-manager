-- A deployment's own values for the keys its stack version declares, which the
-- deploy writes into `.env.<profile>` over the version's base `.env`. Levi ruled
-- on 2026-09-25 that every setting a deployment reads is editable per
-- deployment, with the version's value as the default.
--
-- Two columns, split by the rule the settings page masks by, so a query can
-- read the plain values and only the names of the secret keys, which is what
-- the settings page lists as stored. The secret values are read on their own,
-- for the deploy and for what the next deploy would write, the way
-- `stack_secrets` is. Neither column is in PROFILE_COLUMNS (profileSql.ts), the
-- row every signed-in page and every event carries. A key held in neither is a
-- key the deployment takes from its version. A key held with an empty string
-- is an explicit `KEY=` line.
--
-- `settings_revision` moves on every change to either column, and a save names
-- the revision it was made against, so two operators editing at once cannot
-- overwrite each other unseen.
--
-- Going back to an older manager needs no step: it never reads the columns, so
-- its deploys write the version's values again.
ALTER TABLE profiles
  ADD COLUMN stack_settings JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(stack_settings) = 'object');

ALTER TABLE profiles
  ADD COLUMN stack_settings_secret JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(stack_settings_secret) = 'object');

ALTER TABLE profiles
  ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0
  CHECK (settings_revision >= 0);
