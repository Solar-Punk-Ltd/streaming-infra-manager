/**
 * What a deployment runs, as its containers were seen: one commit when every
 * container agrees, mixed naming each service when they do not, unknown when
 * nothing was observed.
 */
export interface ObservedContainer {
  service: string;
  buildCommit: string | null;
}

export type RunningCommit =
  | { kind: 'one'; commit: string }
  | { kind: 'mixed'; byService: { service: string; commit: string | null }[] }
  | { kind: 'unknown' };

export function runningCommitOf(containers: readonly ObservedContainer[]): RunningCommit {
  if (containers.length === 0) return { kind: 'unknown' };
  const commits = new Set(containers.map((container) => container.buildCommit));
  const [only] = commits;
  if (commits.size === 1 && only) return { kind: 'one', commit: only };
  if (commits.size === 1) return { kind: 'unknown' };
  return {
    kind: 'mixed',
    byService: containers.map((container) => ({ service: container.service, commit: container.buildCommit })),
  };
}
