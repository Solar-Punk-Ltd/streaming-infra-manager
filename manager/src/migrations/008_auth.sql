-- Sign-in: the people who may use the manager, and their open sessions.
--
-- There is no sign-up route. The first user is created on the host with
-- `node dist/cli.js user:add <username>`, which prompts for the password with
-- echo off and writes only the hash. While this table is empty the API answers
-- nothing but /health and the sign-in refusal.
--
-- password_hash is `scrypt$N$r$p$<salt b64>$<key b64>`: the cost parameters
-- travel with the hash, so they can be raised later and old hashes still verify.
--
-- The username CHECK mirrors the yup schema in src/schemas/auth.ts.
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$')
);

-- token_hash is the SHA-256 of the cookie value, never the value itself, so a
-- dump of this table signs nobody in. expires_at is the absolute deadline
-- (created_at + 14 days); the sliding 12 hour idle limit is measured from
-- last_seen_at, which is refreshed at most once a minute.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
