-- The shape a feed topic has to have, which until now only the request knew.
--
-- The manager hands the topic to the stack's deploy script as
-- `--feed-topic=<value>`, and _lib.sh's require_override_shape refuses the flag
-- for anything outside this pattern. The request schema refuses the same values
-- (schemas/profile.ts, FEED_TOPIC_RE), so nothing the manager accepts today can
-- break a deploy. The column had no rule at all, so a row written by anything
-- but that path still could.
--
-- NOT VALID on purpose. An existing row outside the shape is a deployment
-- somebody is running, and a migration that refuses to apply until it is fixed
-- turns an upgrade into an outage over a field no drawer renders. NOT VALID
-- holds every new write to the rule and leaves what is already stored where it
-- is. An operator who wants the constraint validated runs this census first and
-- corrects what it names:
--
--   SELECT name, feed_topic FROM profiles
--    WHERE feed_topic IS NOT NULL AND feed_topic !~ '^[A-Za-z0-9._-]{1,64}$';
--
-- then `ALTER TABLE profiles VALIDATE CONSTRAINT profiles_feed_topic_shape;`,
-- which takes no write lock on the table.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_feed_topic_shape
  CHECK (feed_topic IS NULL OR feed_topic ~ '^[A-Za-z0-9._-]{1,64}$')
  NOT VALID;
