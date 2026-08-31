-- What a deployment group *is*, as opposed to what its members currently look
-- like.
--
-- An ABR ladder was previously recognised by parsing member names for a rung
-- suffix. That works while the ladder is intact and fails exactly when it is not:
-- remove one rung and the group stops looking like a ladder, so the UI stops
-- offering the ladder view — at the moment the operator most needs it to say
-- "1080p is missing". Intent belongs in a column; current shape stays derived.
--
-- Existing groups are plain fan-out, which is what the default records.

ALTER TABLE deployment_groups
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE deployment_groups
  ADD CONSTRAINT deployment_groups_kind_known
  CHECK (kind IN ('standard', 'abr-ladder'));

CREATE INDEX deployment_groups_kind_idx ON deployment_groups (kind);
