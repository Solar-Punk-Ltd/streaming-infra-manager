-- A target introduced after boot must finish its own inventory before allocation.
CREATE TABLE reservation_daemon_inventory (
  daemon_id TEXT PRIMARY KEY,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
