-- What a container record needs to answer "was this container started with
-- this value", for every key its service reads, secrets included, without
-- holding a secret: a digest of each value under a salt of the record's own.
-- The page compares the value a deployment would get now against it, to say how
-- many of its settings the running copy is behind on, which Levi okayed on
-- 2026-09-25.
--
-- A record written before this has no salt, and the page reads its keys as not
-- known rather than as changed. Its next deploy writes both columns.
--
-- Going back to an older manager needs no step: it never reads the columns and
-- leaves them as they are.
ALTER TABLE containers ADD COLUMN env_salt TEXT;

ALTER TABLE containers
  ADD COLUMN env_digests JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(env_digests) = 'object');
