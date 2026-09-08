import type { DeployTargetView } from '@streaming-infra-manager/common';
import { Router } from 'express';

import type { DeployTargetRecord } from '../../domain/ports/DeployTargetRepository.js';
import type { PortReservationRepository } from '../../domain/ports/PortReservationRepository.js';
import type { VerifiedDeployTargets } from '../../domain/ports/VerifiedDeployTargets.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function toView(target: DeployTargetRecord): DeployTargetView {
  return { ...target, verifiedAt: target.verifiedAt?.toISOString() ?? null };
}

export function createTargetsRouter(
  targets: VerifiedDeployTargets,
  ports: Pick<PortReservationRepository, 'inventorySeededAt'>,
): Router {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    const [rows, seededAt] = await Promise.all([targets.list(), ports.inventorySeededAt()]);
    res.json({ targets: rows.map(toView), inventorySeededAt: seededAt?.toISOString() ?? null });
  }));
  router.post('/verify', asyncHandler(async (req, res) => {
    const alias: unknown = req.body?.alias;
    if (typeof alias !== 'string' || !alias.trim()) {
      res.status(400).json({ error: 'validation_error', errors: ['Enter the deploy target to verify.'] });
      return;
    }
    await targets.verify(alias);
    const target = (await targets.list()).find((entry) => entry.alias === alias);
    res.json({ target: toView(target!) });
  }));
  return router;
}
