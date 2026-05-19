import { Request, Response, Router } from 'express';

import { Database } from '../../domain/Database.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export function createHealthRouter(database: Database): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      await database.pool.query('SELECT 1');
      res.json({ status: 'ok' });
    }),
  );

  return router;
}
