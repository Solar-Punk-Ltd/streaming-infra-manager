/** Bindings: $2 build id, $3 commit, $4 contract, $5 optional root anchor. */
export const STACK_PUBLICATION_ASSIGNMENTS = `
  status = 'ready',
  publication_revision = publication_revision + 1,
  layout = 'builds',
  previous_build_id = CASE
    WHEN build_id IS NOT NULL AND build_id <> $2 THEN build_id
    ELSE previous_build_id
  END,
  tested = tested AND build_id IS NOT DISTINCT FROM $2,
  build_id = $2,
  commit_sha = $3,
  contract = $4::jsonb,
  root_path = COALESCE($5, root_path),
  built_at = NOW(),
  last_error = NULL
`;
