-- One physical port can be held by both an old stopped service and a newly admitted service.
ALTER TABLE port_reservations ADD COLUMN held_services TEXT[] NOT NULL DEFAULT ARRAY[NULL]::TEXT[];
UPDATE port_reservations SET held_services = ARRAY[service];
