-- Historical approval loss had no recorded timestamp. Leave it unknown.
ALTER TABLE stack_versions ADD COLUMN tested_invalidated_at TIMESTAMPTZ;
