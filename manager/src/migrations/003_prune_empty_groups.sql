-- Prune deployment_groups that have no member profiles.
DELETE FROM deployment_groups g
WHERE NOT EXISTS (
  SELECT 1 FROM profiles p WHERE p.group_id = g.id
);
