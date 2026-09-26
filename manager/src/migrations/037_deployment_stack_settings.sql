-- A deployment's own values for the keys its stack version declares, which the
-- deploy writes into `.env.<profile>` over the version's base `.env`. Levi ruled
-- on 2026-09-25 that every setting a deployment reads is editable per
-- deployment, with the version's value as the default.
--
-- Two columns, split by the rule the settings page masks by, because a row's
-- ordinary columns reach every signed-in page and every event (PROFILE_COLUMNS
-- in profileSql.ts), and a secret must not. `stack_settings_secret` is read on
-- its own, by the deploy, the way `stack_secrets` is. A key held in neither is
-- a key the deployment takes from its version. A key held with an empty string
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
