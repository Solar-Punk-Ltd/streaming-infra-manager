-- Per-deployment SRT passphrase for the SRS engine.
--
-- SRS reads SRT_PASSPHRASE from the env file the deploy hands compose, and
-- encrypts its SRT listener with it. That value existed already, but only as a
-- single key in the submodule's base .env — one passphrase for every deployment
-- on the host, editable only by hand on the box. It belongs next to the other
-- per-deployment parameters instead, so each streamer can carry its own.
--
-- NULL means "not set here": the deploy falls back to whatever the base .env
-- carries, which is what every existing row did before this column existed.
--
-- The CHECK mirrors common/src/srtPassphrase.ts. The bounds are libsrt's, which
-- rejects a passphrase outside 10-79 characters; the character set is the RFC
-- 3986 unreserved one, because the value is spliced through a sed expression, an
-- env file, an srs.conf directive and a URL query, and that set is what survives
-- all four unescaped.
ALTER TABLE profiles
  ADD COLUMN srt_passphrase TEXT;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_srt_passphrase_format
  CHECK (srt_passphrase IS NULL OR srt_passphrase ~ '^[A-Za-z0-9._~-]{10,79}$');
