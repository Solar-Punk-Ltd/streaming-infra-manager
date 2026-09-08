/**
 * A deploy attempt as the pages see it, and the two rules the manager and
 * the pages apply the same way.
 *
 * The stack still names its built images by service alone, so two
 * deployments building at once move one shared tag. The manager keeps a
 * durable row per deploy attempt: every attempt holds its own deployment
 * until it resolves, and an attempt on a version with shared image tags
 * holds the whole daemon against every other such attempt. An attempt
 * resolves by evidence only, a container created after it started for every
 * service it touched, and anything less leaves it blocked until a person
 * who checked the host releases it by typing its job id back.
 */
export type DeployAttemptKind = 'shared' | 'fixed';

export type DeployAttemptState = 'open' | 'released' | 'blocked';

/** One attempt as `GET /versions/attempts` answers it. */
export interface DeployAttemptView {
  id: number;
  /** The deployment, which is the Compose project. */
  project: string;
  jobId: string;
  /** Shared: its images move tags every deployment's build touches. */
  kind: DeployAttemptKind;
  /** The services the attempt touched. */
  services: string[];
  state: DeployAttemptState;
  /** Why it is blocked, or null. */
  reason: string | null;
  /** ISO. */
  startedAt: string;
  /** ISO, or null while the attempt is open. */
  resolvedAt: string | null;
  /** Who released a blocked attempt by hand, or null. */
  releasedBy: string | null;
}

/** An attempt still holding something: open or blocked. */
export function isAttemptUnresolved(attempt: Pick<DeployAttemptView, 'state'>): boolean {
  return attempt.state !== 'released';
}

/**
 * Why the typed job id does not release this attempt, or null when it does.
 * The manager applies it to the request and the dialog to the field, so a
 * refusal seen in the page is the refusal the manager gives.
 */
export function attemptReleaseProblem(
  typed: string,
  attempt: Pick<DeployAttemptView, 'jobId'>,
): string | null {
  const jobId = typed.trim();
  if (jobId === '') return 'Type the job id of the attempt to release it.';
  if (jobId !== attempt.jobId) {
    return `The job id typed does not match. This attempt is ${attempt.jobId}.`;
  }
  return null;
}

const HOLD_STATE: Record<DeployAttemptState, string> = {
  open: 'Running.',
  blocked: 'Blocked.',
  released: 'Released.',
};

/**
 * What an attempt holds, in one line: `Blocked. It holds stage, and every
 * deploy of a version with shared image tags on this host.`
 */
export function describeAttemptHold(attempt: DeployAttemptView): string {
  const state = HOLD_STATE[attempt.state];
  if (attempt.state === 'released') return `${state} Nothing is held now.`;
  const daemon =
    attempt.kind === 'shared'
      ? ', and every deploy of a version with shared image tags on this host'
      : '';
  return `${state} It holds ${attempt.project}${daemon}.`;
}
