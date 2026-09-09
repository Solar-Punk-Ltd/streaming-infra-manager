-- The shipment journal recorded packages a manager deploy sealed on the
-- operator's machine and shipped to the host. The host now fetches and builds
-- the stack commit the manager pins, so there is no shipment to journal.
--
-- publication_revision and its trigger arrived in the same migration and stay:
-- every version row advances that revision when its published identity changes,
-- and other code reads it.
DROP TRIGGER IF EXISTS bundled_shipment_identity ON bundled_shipments;
DROP TABLE IF EXISTS bundled_shipments;
DROP FUNCTION IF EXISTS preserve_bundled_shipment_identity();
