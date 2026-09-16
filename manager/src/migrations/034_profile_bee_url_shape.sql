-- The shape the address of an external Bee node has to have, which until now
-- only the request knew, and less well than it thought.
--
-- The manager writes this value into `.env.<profile>` as a bare BEE_URL line,
-- and that file is read by docker compose as an env file and by the stack's
-- deploy script as its defaults. The check in front of the write parsed the
-- value with the URL constructor, which strips every tab, carriage return and
-- line feed out of its input before it parses, so an address carrying one came
-- back sound and the raw string reached the file, where the line break became a
-- second key. rpc_endpoint got this rule as a CHECK when its column was added
-- in 032, and the column that has held an address since 005 had none.
--
-- NOT VALID on purpose, as in 033. A row already outside the shape is a
-- deployment somebody is running, and a migration that refuses to apply until
-- it is fixed turns an upgrade into an outage. New writes are held to the rule
-- and what is stored stays where it is. An operator who wants the constraint
-- validated runs this census first and corrects what it names, remembering that
-- a row it names also fails its next edit:
--
--   SELECT name, bee_url FROM profiles
--    WHERE bee_url IS NOT NULL AND bee_url !~ '^https?://[^[:space:]]+$';
--
-- then `ALTER TABLE profiles VALIDATE CONSTRAINT profiles_bee_url_shape;`,
-- which takes no write lock on the table.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_bee_url_shape
  CHECK (bee_url IS NULL OR bee_url ~ '^https?://[^[:space:]]+$')
  NOT VALID;
