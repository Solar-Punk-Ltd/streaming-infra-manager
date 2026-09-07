import { Request, Response, Router } from 'express';

import type { DeploymentOrchestrator } from '../../domain/DeploymentOrchestrator.js';
import type { DeployAttempt } from '../../domain/deployAttempts.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/** What a page may see of an attempt: the container ids stay in the manager. */
function toApiAttempt(attempt: DeployAttempt) {
  return {
    id: attempt.id,
    project: attempt.project,
    jobId: attempt.jobId,
    kind: attempt.kind,
    services: attempt.services,
    state: attempt.state,
    reason: attempt.reason,
    startedAt: attempt.startedAt.toISOString(),
    resolvedAt: attempt.resolvedAt ? attempt.resolvedAt.toISOString() : null,
    releasedBy: attempt.releasedBy,
  };
}

/**
 * The deploy attempts that still hold a project or the daemon, and the
 * typed release that ends a blocked one. The release names the job id, and
 * the operator types it back, because releasing an attempt whose build is
 * still running is what the guard exists to prevent, and a person who
 * checked the host is the only one who can know.
 */
export function createAttemptsRouter(
  orchestrator: DeploymentOrchestrator,
  whoIs: (req: Request) => string,
): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const attempts = await orchestrator.unresolvedAttempts();
      res.json({ attempts: attempts.map(toApiAttempt) });
    }),
  );

  router.post(
    '/:id/release',
    asyncHandler(async (req: Request, res: Response) => {
      const id = Number.parseInt(req.params.id as string, 10);
      const typed = (req.body as { jobId?: unknown } | undefined)?.jobId;
      if (!Number.isInteger(id) || typeof typed !== 'string' || typed.trim() === '') {
        res.status(400).json({
          error: 'validation_error',
          errors: ['Type the job id of the attempt to release it.'],
        });
        return;
      }
      const attempt = (await orchestrator.unresolvedAttempts()).find((entry) => entry.id === id);
      if (!attempt) {
        res.status(404).json({ error: 'attempt_not_found', id });
        return;
      }
      if (attempt.jobId !== typed.trim()) {
        res.status(400).json({
          error: 'validation_error',
          errors: [`The job id typed does not match. This attempt is ${attempt.jobId}.`],
        });
        return;
      }
      const released = await orchestrator.releaseAttempt(id, whoIs(req));
      if (!released) {
        res.status(404).json({ error: 'attempt_not_found', id });
        return;
      }
      res.json({ attempt: toApiAttempt(released) });
    }),
  );

  return router;
}
