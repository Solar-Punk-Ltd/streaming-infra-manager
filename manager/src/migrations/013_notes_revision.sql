-- A counter that moves with every change of the notes, so a note saved from a
-- page that loaded before another save cannot overwrite that save without
-- knowing. The Notes card and the Edit drawer both send the revision they
-- loaded, and a write whose revision has moved is refused as a conflict
-- rather than applied.
ALTER TABLE profiles ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0;
