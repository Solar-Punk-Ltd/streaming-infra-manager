/**
 * A deploy attempt and the two rules that keep concurrent deploys apart.
 *
 * The stack still names its built images by service alone, so two
 * deployments building at once move one shared tag, and a container can be
 * created from the other project's image. Two guards close that, both
 * durable rows so a manager that comes back finds them:
 *
 * The project guard: every attempt, whatever its tags, holds its Compose
 * project until it resolves, so nothing else creates containers in that
 * project meanwhile. That is what makes a new container id attributable to
 * the attempt.
 *
 * The daemon lock: an attempt on a version that builds shared tags holds
 * the daemon against every other such attempt through Compose's completion.
 * Fixed-image attempts of other projects run beside it.
 *
 * An attempt resolves only by evidence, never by time: a container id that
 * did not exist before it started, for every service it touched. Compose
 * creates every container after every build, so that proves the build
 * phase finished and no delayed export can follow. Anything less blocks,
 * and a person who checked the host releases it.
 */
import type {
  DeployAttemptKind,
  DeployAttemptState,
} from '@streaming-infra-manager/common';

export type { DeployAttemptKind, DeployAttemptState };

export interface DeployAttempt {
  id: number;
  /** The Docker daemon, from `docker info`, so a lock never crosses hosts. */
  daemonId: string;
  /** The Compose project, which is the profile name. */
  project: string;
  jobId: string;
  kind: DeployAttemptKind;
  /** The services the attempt touches. */
  services: readonly string[];
  /** Every container id of the project, all states, before the attempt spawned. */
  preJobContainerIds: readonly string[];
  state: DeployAttemptState;
  /** Why it is blocked, or null. */
  reason: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
  /** Who released a blocked attempt by hand, or null. */
  releasedBy: string | null;
}

export interface AttemptOutcome {
  state: 'released' | 'blocked';
  reason: string | null;
}

export interface AdmissionRequest {
  daemonId: string;
  project: string;
  kind: DeployAttemptKind;
}

/**
 * What the containers say about the attempt: released when every touched
 * service shows a container id from after the attempt started, blocked
 * naming the services that do not.
 */
export function attemptOutcome(
  attempt: DeployAttempt,
  observed: ReadonlyMap<string, readonly string[]>,
): AttemptOutcome {
  const before = new Set(attempt.preJobContainerIds);
  const unseen = attempt.services.filter(
    (service) => !(observed.get(service) ?? []).some((id) => !before.has(id)),
  );
  if (unseen.length === 0) return { state: 'released', reason: null };
  return {
    state: 'blocked',
    reason:
      `${unseen.join(', ')} of ${attempt.project} was never seen with a container created by attempt ${attempt.jobId}. ` +
      'Compose creates every container after every build, so that build may still be running, or it never got that far. Check the host, then release the attempt.',
  };
}

/** Why a new attempt may not start now, in one sentence naming what holds it, or null. */
export function whyAdmissionIsRefused(
  request: AdmissionRequest,
  attempts: readonly DeployAttempt[],
): string | null {
  const unresolved = attempts.filter(
    (attempt) => attempt.daemonId === request.daemonId && attempt.state !== 'released',
  );
  const sameProject = unresolved.find((attempt) => attempt.project === request.project);
  if (sameProject) {
    // A judged attempt is never judged again, so only a running one can end
    // without a person.
    if (sameProject.state === 'blocked') {
      return (
        `${request.project} has a blocked deploy attempt, ${sameProject.jobId}: ${sameProject.reason} ` +
        'A person releases it after checking the host.'
      );
    }
    return (
      `${request.project} has a deploy attempt still running, ${sameProject.jobId}. ` +
      'It resolves on its own once every service it touched has a new container, or a person releases it after checking the host.'
    );
  }
  if (request.kind === 'shared') {
    const holder = unresolved.find((attempt) => attempt.kind === 'shared');
    if (holder) {
      return (
        `A deploy of ${holder.project} (attempt ${holder.jobId}) is building on this daemon, ` +
        'and this version builds shared image tags, so its deploys wait for each other.'
      );
    }
  }
  return null;
}
