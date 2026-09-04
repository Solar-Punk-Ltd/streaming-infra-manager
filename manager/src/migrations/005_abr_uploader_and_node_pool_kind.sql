-- Publishing to an ABR node pool, and naming an external bee node.
--
-- 1. `profiles.bee_publishers` — a pasted BEE_PUBLISHERS. The pool usually lives
--    on another machine under another manager, so a foreign key to its group is
--    not expressible; the string itself is what crosses between them. Written
--    into .env.<profile> at deploy. NULL: publish through your own node.
--
-- 2. `profiles.bee_url` — an explicit bee API URL. deploy.sh's resolve_bee_url
--    overwrites BEE_URL whenever a local bee-uploader is enabled and prints
--    nothing when it is not, so an explicit value only has effect for a profile
--    that runs no Bee node — which is exactly when an operator needs to name one.
--
-- 3. The profile kind 'abr-uploader': srs + stream-uploader and no Bee node, with
--    no postage of its own because the pool's rungs hold it.
--
-- 4. The group kind 'abr-ladder' becomes 'abr-node-pool', which is what the thing
--    is called everywhere an operator sees it: a pool of Bee nodes, and no
--    uploader in it. "Ladder" stays the word for its shape.

ALTER TABLE profiles
  ADD COLUMN bee_publishers TEXT;

ALTER TABLE profiles
  ADD COLUMN bee_url TEXT;

-- Widening only, so no existing row can violate it and no data has to move.
ALTER TABLE profiles
  DROP CONSTRAINT profiles_kind_known;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_kind_known
  CHECK (kind IN ('streamer', 'viewer', 'custom', 'abr-uploader'));

-- Order matters here, unlike above: this one *renames a value*, so the old
-- CHECK has to come off before the rows are rewritten. Updating first fails on
-- the constraint still in force — 'abr-node-pool' is not one of its allowed
-- values — which aborts the whole migration.
ALTER TABLE deployment_groups
  DROP CONSTRAINT deployment_groups_kind_known;

UPDATE deployment_groups
  SET kind = 'abr-node-pool'
  WHERE kind = 'abr-ladder';

ALTER TABLE deployment_groups
  ADD CONSTRAINT deployment_groups_kind_known
  CHECK (kind IN ('standard', 'abr-node-pool'));
