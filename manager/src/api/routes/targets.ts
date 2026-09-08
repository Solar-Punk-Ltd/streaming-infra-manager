import type { DeployTargetView } from '@streaming-infra-manager/common';
import { Router } from 'express';

import type { DeployTargetRecord } from '../../domain/ports/DeployTargetRepository.js';
import type { PortReservationRepository } from '../../domain/ports/PortReservationRepository.js';
import type { PortInventory } from '../../domain/ports/PortInventory.js';
import type { VerifiedDeployTargets } from '../../domain/ports/VerifiedDeployTargets.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function toView(target: DeployTargetRecord): DeployTargetView {
  return { ...target, verifiedAt: target.verifiedAt?.toISOString() ?? null };
}

export function createTargetsRouter(
  targets: VerifiedDeployTargets,
  ports: Pick<PortReservationRepository, 'inventorySeededAt'>,
  inventory?: Pick<PortInventory, 'seed' | 'daemonIdFor'>,
): Router {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    const [rows, seededAt] = await Promise.all([targets.list(), ports.inventorySeededAt()]);
    const views = await Promise.all(rows.map(async row => ({
      ...toView(row),
      inventorySeededAt: row.daemonId ? (await ports.inventorySeededAt(row.daemonId))?.toISOString() ?? null : null,
    })));
    res.json({ targets: views, inventorySeededAt: seededAt?.toISOString() ?? null });
  }));
  router.post('/inventory', asyncHandler(async (_req, res) => {
    if (!inventory) {
      res.status(503).json({ error: 'inventory_unavailable', message: 'Inventory recovery is not configured.' });
      return;
    }
    await inventory.seed();
    res.json({ inventorySeededAt: (await ports.inventorySeededAt())?.toISOString() ?? null });
  }));
  router.post('/verify', asyncHandler(async (req, res) => {
    const alias: unknown = req.body?.alias;
    if (typeof alias !== 'string' || !alias.trim()) {
      res.status(400).json({ error: 'validation_error', errors: ['Enter the deploy target to verify.'] });
      return;
    }
    await targets.verify(alias);
    if (inventory) {
      await inventory.daemonIdFor(alias);
      await inventory.seed();
    }
    const target = (await targets.list()).find((entry) => entry.alias === alias);
    res.json({ target: toView(target!) });
  }));
  return router;
}
