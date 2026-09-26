-- The web2 admin link every new uploader deployment starts with, set once for
-- the whole manager on its Manager settings page. Levi ruled on 2026-09-25 that
-- linking an uploader to the web2 admin works out of the box on any host a
-- clone of the repository deploys to.
--
-- One row, always there, so a save names the revision it read and two
-- operators editing at once cannot overwrite each other unseen. No address is
-- no default, and new deployments start standalone.
--
-- The token is kept the way a deployment's own secrets are, in a column no
-- answer selects: pages learn only whether one is stored. Two things read it,
-- the insert that copies it into a new deployment's secret settings and Test
-- connection, which presents it to the admin.
--
-- It applies to deployments created after it is set. A deployment keeps what
-- it was created with in its own settings, so a change here changes none that
-- exists.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE manager_admin_link (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  url         TEXT CHECK (url IS NULL OR url <> ''),
  token       TEXT CHECK (token IS NULL OR (url IS NOT NULL AND length(token) >= 32)),
  revision    INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

INSERT INTO manager_admin_link DEFAULT VALUES;
