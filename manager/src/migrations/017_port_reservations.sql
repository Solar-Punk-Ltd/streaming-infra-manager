-- Every port a deployment binds, reserved on the daemon that owns it.
--
-- The allocator counted slot numbers, and a slot number said nothing about
-- the ports: two versions with different port tables can put two slots on
-- one port, and a remote target alias could open a second namespace for
-- one daemon. A reservation is one transport, one port number and one
-- daemon, unique, held by one deployment for one of its services.
-- Allocation inserts the whole shifted table of the slot in the same
-- transaction that inserts the deployment, under the profile slot lock, so
-- a group's members are all reserved or none.
--
-- planned is what admission wrote, active what inspection found a container
-- bound to, releasing what inspection found unbound after the deployment's
-- plan stopped naming it. A row goes only when no plan needs it. A stopped
-- deployment keeps its rows, because it may start again on the same ports.
CREATE TABLE port_reservations (
  id            SERIAL PRIMARY KEY,
  daemon_id     TEXT NOT NULL,
  protocol      TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp')),
  port          INTEGER NOT NULL CHECK (port > 0 AND port < 65536),
  profile_name  TEXT NOT NULL,
  service       TEXT,
  port_var      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'active', 'releasing')),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (daemon_id, protocol, port)
);

CREATE INDEX port_reservations_profile ON port_reservations (profile_name);

-- Which daemon a deploy target alias reaches. The local daemon's id is read
-- from docker info at boot. A remote alias is verified over the same ssh
-- path the stack's deploy script uses, on first use and on demand, and an
-- alias without a daemon id refuses new allocation rather than opening a
-- namespace from its spelling.
CREATE TABLE deploy_targets (
  alias        TEXT PRIMARY KEY,
  daemon_id    TEXT,
  verified_at  TIMESTAMPTZ,
  last_error   TEXT
);

-- The one-time seeding of existing deployments' reservations. Until it has
-- completed, new allocation refuses, because a port an existing container
-- binds is a port the table does not know yet.
CREATE TABLE reservation_inventory (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  seeded_at  TIMESTAMPTZ
);
INSERT INTO reservation_inventory (id, seeded_at) VALUES (1, NULL);

-- Every job persists the alias it was given, beside the daemon id it ran on.
ALTER TABLE deploy_attempts ADD COLUMN target TEXT;
