-- The chain endpoint a deployment's Bee nodes use, or NULL to take the one its
-- stack version carries. Until now the version was the only place to set it, so
-- every deployment on a version shared one endpoint, and the shipped default is
-- a public RPC that answered a single node 4568 HTTP 429s in two hours on the
-- deployment host on 2026-09-15.
--
-- NULL for every existing row, which is that rule applied to the past: a
-- deployment that names none keeps behaving exactly as it did.
ALTER TABLE profiles
  ADD COLUMN rpc_endpoint TEXT
  CHECK (rpc_endpoint IS NULL OR rpc_endpoint ~ '^https?://[^[:space:]]+$');
