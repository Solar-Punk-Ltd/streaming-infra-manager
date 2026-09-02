-- 004 created this alongside the kind column out of habit; nothing reads it.
--
-- No query filters deployment_groups by kind — they are listed whole and split
-- in the client — and on a two-value column over a handful of rows the planner
-- would not choose an index scan even if one did.
--
-- Its own migration rather than a line in 005: 005 has already been applied, so
-- an edit there would never run.

DROP INDEX IF EXISTS deployment_groups_kind_idx;
