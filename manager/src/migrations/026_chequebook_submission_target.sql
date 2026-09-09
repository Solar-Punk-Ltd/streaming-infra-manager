-- Historical operations keep NULL. A current same-name deployment cannot supply their missing proof.
ALTER TABLE chequebook_operations ADD COLUMN submission_target JSONB
  CHECK (submission_target IS NULL OR jsonb_typeof(submission_target) = 'object');
