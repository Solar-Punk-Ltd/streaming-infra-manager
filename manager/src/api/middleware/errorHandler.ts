import {
  getErrorMessage,
  getErrorStack,
} from '@streaming-infra-manager/common';
import { NextFunction, Request, Response } from 'express';
import { ValidationError as YupValidationError } from 'yup';

import {
  AllSlotsUsedError,
  BeeNodeError,
  ProfileBusyError,
  GroupExistsError,
  GroupNotFoundError,
  GroupBusyError,
  LadderGroupError,
  ProfileConfigError,
  ProfileExistsError,
  ProfileNotFoundError,
  StampNotUsableError,
  StampRequiredError,
} from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';

const logger = Logger.getInstance();

/**
 * Centralised error → HTTP mapping. Domain errors get specific status codes;
 * everything else becomes a 500 with the message logged but not echoed back.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof YupValidationError) {
    res.status(400).json({ error: 'validation_error', errors: err.errors });
    return;
  }
  if (err instanceof ProfileConfigError) {
    // Same shape as a schema rejection: it is a rejected request body, just one
    // whose rule needs the stored profile to evaluate.
    res.status(400).json({
      error: 'validation_error',
      errors: [err.reason],
      name: err.profileName,
    });
    return;
  }
  if (err instanceof ProfileNotFoundError) {
    res.status(404).json({ error: 'profile_not_found', name: err.profileName });
    return;
  }
  if (err instanceof ProfileExistsError) {
    res.status(409).json({ error: 'profile_exists', name: err.profileName });
    return;
  }
  if (err instanceof ProfileBusyError) {
    res.status(409).json({
      error: 'profile_busy',
      name: err.profileName,
      status: err.currentStatus,
    });
    return;
  }
  if (err instanceof GroupExistsError) {
    res.status(409).json({ error: 'group_exists', name: err.name });
    return;
  }
  if (err instanceof GroupNotFoundError) {
    res.status(404).json({ error: 'group_not_found', id: err.groupId });
    return;
  }
  if (err instanceof GroupBusyError) {
    res.status(409).json({
      error: 'group_busy',
      name: err.groupName,
      members: err.busyMembers,
    });
    return;
  }
  if (err instanceof StampRequiredError) {
    res.status(409).json({ error: 'stamp_required', name: err.profileName });
    return;
  }
  if (err instanceof StampNotUsableError) {
    res.status(409).json({
      error: 'stamp_not_usable',
      name: err.profileName,
      message: err.message,
    });
    return;
  }
  if (err instanceof LadderGroupError) {
    res.status(409).json({
      error: 'ladder_group_invalid_operation',
      name: err.groupName,
      message: err.message,
    });
    return;
  }
  if (err instanceof BeeNodeError) {
    res.status(502).json({
      error: 'bee_node_unreachable',
      name: err.profileName,
      message: err.message,
    });
    return;
  }
  if (err instanceof AllSlotsUsedError) {
    res.status(503).json({ error: 'all_slots_used', message: err.message });
    return;
  }

  logger.error(
    `[HTTP] ${req.method} ${req.originalUrl} unhandled:`,
    getErrorMessage(err),
  );
  const stack = getErrorStack(err);
  if (stack) logger.error(stack);
  res.status(500).json({ error: 'internal_error' });
}
