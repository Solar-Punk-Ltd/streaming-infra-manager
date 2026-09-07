/**
 * Deploy attempts, for the mock manager.
 *
 * The manager keeps a row per deploy attempt: it holds its deployment until
 * the manager can prove the build finished, and an attempt on a version with
 * shared image tags holds every such deploy on the host. Here a deploy opens
 * one and releases it when the deploy lands, and one blocked attempt is
 * seeded on the deployment whose last deploy failed, so the refusal, the
 * card and the typed release can be seen without a host.
 */
import { attemptReleaseProblem } from '@streaming-infra-manager/common';

import { send } from './mock-http.mjs';
import { hex, state } from './mock-seed.mjs';

let nextId = 1;

const jobId = () => `job-${hex(6)}`;

function makeAttempt({ project, services, kind = 'shared', startedAt }) {
  const attempt = {
    id: nextId++,
    project,
    jobId: jobId(),
    kind,
    services,
    state: 'open',
    reason: null,
    startedAt: startedAt ?? new Date().toISOString(),
    resolvedAt: null,
    releasedBy: null,
  };
  state.attempts.push(attempt);
  return attempt;
}

/** The manager's words for a service the attempt never proved a container for. */
function blockedReason(attempt, service) {
  return (
    `${service} of ${attempt.project} was never seen with a container created by attempt ${attempt.jobId}. ` +
    'Compose creates every container after every build, so that build may still be running, or it never got that far. Check the host, then release the attempt.'
  );
}

export function seedAttempts() {
  nextId = 1;
  state.attempts = [];
  // The deployment whose last deploy failed on a port: its attempt never saw
  // a new container for the engine, so it is blocked until a person ends it.
  const failed = state.profiles.find((profile) => profile.status === 'ERROR');
  if (!failed) return;
  const attempt = makeAttempt({
    project: failed.name,
    services: ['srs', 'client', 'bee-gateway'],
    startedAt: failed.last_error_at ?? undefined,
  });
  attempt.state = 'blocked';
  attempt.resolvedAt = failed.last_error_at ?? new Date().toISOString();
  attempt.reason = blockedReason(attempt, 'srs');
}

export function unresolvedAttempts() {
  return state.attempts.filter((attempt) => attempt.state !== 'released');
}

/**
 * The refusal the manager sends for a deploy of a deployment an attempt
 * still holds, worded the same way, or null.
 */
export function attemptRefusal(profile) {
  const holder = unresolvedAttempts().find((attempt) => attempt.project === profile.name);
  if (!holder) return null;
  const message =
    holder.state === 'blocked'
      ? `${profile.name} has a blocked deploy attempt, ${holder.jobId}: ${holder.reason} A person releases it after checking the host.`
      : `${profile.name} has a deploy attempt still running, ${holder.jobId}. It resolves on its own once every service it touched has a new container, or a person releases it after checking the host.`;
  return { error: 'deploy_attempt_refused', name: profile.name, message };
}

/** The attempt a deploy opens before anything runs. */
export function openAttempt(profile, services, publish) {
  const attempt = makeAttempt({ project: profile.name, services });
  publish({ type: 'attempt.changed' });
  return attempt;
}

/** The deploy landed with a new container per service, so the attempt resolves released. */
export function resolveAttempt(attempt, publish) {
  attempt.state = 'released';
  attempt.resolvedAt = new Date().toISOString();
  publish({ type: 'attempt.changed' });
}

export function attemptRoutes(readBody, publish) {
  return [
    [
      'GET',
      /^\/versions\/attempts$/,
      (_req, res) => send(res, 200, { attempts: unresolvedAttempts() }),
    ],
    [
      'POST',
      /^\/versions\/attempts\/(\d+)\/release$/,
      async (req, res, [id]) => {
        const attempt = unresolvedAttempts().find((entry) => entry.id === Number(id));
        if (!attempt) return send(res, 404, { error: 'attempt_not_found', id });
        const body = await readBody(req);
        // The same rule the manager applies, from the same module.
        const problem = attemptReleaseProblem(
          typeof body.jobId === 'string' ? body.jobId : '',
          attempt,
        );
        if (problem) {
          return send(res, 400, { error: 'validation_error', errors: [problem] });
        }
        attempt.state = 'released';
        attempt.resolvedAt = new Date().toISOString();
        attempt.releasedBy = 'dev';
        publish({ type: 'attempt.changed' });
        send(res, 200, { attempt });
      },
    ],
  ];
}
