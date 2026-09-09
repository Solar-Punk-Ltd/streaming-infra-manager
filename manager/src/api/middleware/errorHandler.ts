import { ChequebookAccountChangedError } from '../../domain/errors/ChequebookAccountChangedError.js';
import { ChequebookOperationChangedError } from '../../domain/errors/ChequebookOperationChangedError.js';
import { ChequebookProfileChangedError } from '../../domain/errors/ChequebookProfileChangedError.js';
import { ChequebookOperationInputError } from '../../domain/errors/ChequebookOperationInputError.js';
import { ChequebookOperationNotFoundError } from '../../domain/errors/ChequebookOperationNotFoundError.js';
import { ChequebookJournalError } from '../../domain/errors/ChequebookJournalError.js';
import { ChequebookPreparationError } from '../../domain/errors/ChequebookPreparationError.js';
import { ChequebookRecoveryRequiredError } from '../../domain/errors/ChequebookRecoveryRequiredError.js';
import {
  getErrorMessage,
  getErrorStack,
} from '@streaming-infra-manager/common';
import { NextFunction, Request, Response } from 'express';
import { ValidationError as YupValidationError } from 'yup';

import {
  AdminRequiredError,
  AllSlotsUsedError,
  PortReservedError,
  ReservationInventoryPendingError,
  TargetNotVerifiedError,
  BeeNodeError,
  BeeNotReadyError,
  BundledVersionError,
  CannotRemoveUserError,
  ChequebookBusyError,
  ChequebookFundsError,
  ChequebookUnfundedError,
  ContainerNotRunningError,
  CrossSiteRequestError,
  DockerUnavailableError,
  DefaultVersionError,
  ProfileBusyError,
  ProfileInstanceChangedError,
  EngineSettingsChangedError,
  GroupExistsError,
  GroupNotFoundError,
  GroupBusyError,
  GroupRemovalRefusedError,
  InvalidCredentialsError,
  InvalidStackVersionError,
  InvalidUsernameError,
  LadderGroupError,
  LockedOutError,
  NotSignedInError,
  NoUsersError,
  ProfileConfigError,
  ProfileExistsError,
  ProfileNotFoundError,
  RestartInProgressError,
  StackBuildBusyError,
  StackVersionExistsError,
  StackVersionInUseError,
  StackVersionNotFoundError,
  StampNotUsableError,
  StampRequiredError,
  UnknownServiceError,
  UntestedVersionError,
  UserExistsError,
  UserNotFoundError,
  WeakPasswordError,
  DeployAttemptRefusedError,
} from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';
import { StackVersionRemovalHeldError } from '../../domain/errors/StackVersionRemovalHeldError.js';

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
  if (err instanceof ChequebookOperationChangedError) {
    res.status(409).json({ error: 'operation_changed', message: err.message });
    return;
  }
  if (err instanceof ChequebookAccountChangedError) {
    res.status(409).json({ error: 'account_changed', message: err.message });
    return;
  }
  if (err instanceof ChequebookProfileChangedError) {
    res.status(409).json({ error: 'chequebook_profile_changed', message: err.message });
    return;
  }
  if (err instanceof ChequebookOperationInputError) {
    res.status(400).json({ error: 'validation_error', errors: [err.message] });
    return;
  }
  if (err instanceof ChequebookOperationNotFoundError) {
    res.status(404).json({ error: 'chequebook_operation_not_found', message: err.message });
    return;
  }
  if (err instanceof ChequebookJournalError || err instanceof ChequebookPreparationError) {
    res.status(503).json({ error: err instanceof ChequebookJournalError ? 'chequebook_journal_unavailable' : 'chequebook_preparation_unavailable', message: err.message });
    return;
  }
  if (err instanceof ChequebookRecoveryRequiredError) {
    res.status(409).json({ error: 'chequebook_recovery_required', message: err.message });
    return;
  }
  if (err instanceof YupValidationError) {
    res.status(400).json({ error: 'validation_error', errors: err.errors });
    return;
  }
  if (
    err instanceof WeakPasswordError ||
    err instanceof InvalidUsernameError ||
    err instanceof InvalidStackVersionError
  ) {
    // Same shape as a schema rejection: the reason is the only useful text, and
    // the frontend already renders `errors` from a 400.
    res.status(400).json({ error: 'validation_error', errors: [err.reason] });
    return;
  }
  if (err instanceof UnknownServiceError) {
    // A rejected request, so the same 400 shape a schema rejection has.
    res.status(400).json({ error: 'validation_error', errors: [err.message] });
    return;
  }
  if (err instanceof NotSignedInError) {
    res.status(401).json({ error: 'not_signed_in' });
    return;
  }
  if (err instanceof InvalidCredentialsError) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  if (err instanceof LockedOutError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(429).json({
      error: 'locked_out',
      retryAfterSeconds: err.retryAfterSeconds,
    });
    return;
  }
  if (err instanceof CrossSiteRequestError) {
    res.status(403).json({ error: 'cross_site_request', message: err.reason });
    return;
  }
  if (err instanceof NoUsersError) {
    res.status(409).json({ error: 'no_users' });
    return;
  }
  if (err instanceof CannotRemoveUserError) {
    res.status(409).json({
      error: 'cannot_remove_user',
      message: err.reason,
    });
    return;
  }
  if (err instanceof UserExistsError) {
    res.status(409).json({ error: 'user_exists', username: err.username });
    return;
  }
  if (err instanceof UserNotFoundError) {
    res.status(404).json({ error: 'user_not_found', id: err.userId });
    return;
  }
  if (err instanceof EngineSettingsChangedError) {
    res.status(409).json({ error: 'engine_settings_changed', name: err.profileName, message: err.message });
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
  if (err instanceof DeployAttemptRefusedError) {
    res.status(409).json({
      error: 'deploy_attempt_refused',
      name: err.profileName,
      message: err.reason,
    });
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
  if (err instanceof ProfileInstanceChangedError) {
    res.status(409).json({ error: 'profile_instance_changed', name: err.profileName, message: err.message });
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
  if (err instanceof GroupRemovalRefusedError) {
    res.status(409).json({ error: `group_${err.reason}`, id: err.groupId });
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
  if (err instanceof ChequebookFundsError) {
    // Same shape as a schema rejection: the amount asked for is the problem,
    // and the reason is the only text worth showing.
    res.status(400).json({ error: 'validation_error', errors: [err.reason] });
    return;
  }
  if (err instanceof ChequebookBusyError) {
    res.status(409).json({
      error: 'chequebook_busy',
      name: err.profileName,
      message: err.message,
    });
    return;
  }
  if (err instanceof ChequebookUnfundedError) {
    res.status(409).json({
      error: 'chequebook_unfunded',
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
  if (err instanceof ContainerNotRunningError) {
    res.status(409).json({
      error: 'container_not_running',
      name: err.profileName,
      service: err.service,
      message: err.message,
    });
    return;
  }
  if (err instanceof RestartInProgressError) {
    res.status(409).json({
      error: 'restart_in_progress',
      name: err.profileName,
      service: err.service,
      message: err.message,
    });
    return;
  }
  if (err instanceof AdminRequiredError) {
    res.status(403).json({ error: 'admin_required', message: err.message });
    return;
  }
  if (err instanceof BeeNotReadyError) {
    res.status(503).json({
      error: 'bee_node_not_ready',
      name: err.profileName,
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
  if (err instanceof DockerUnavailableError) {
    res.status(504).json({ error: 'docker_unavailable', message: err.message });
    return;
  }
  if (err instanceof StackVersionNotFoundError) {
    res.status(404).json({ error: 'stack_version_not_found', id: err.versionId });
    return;
  }
  if (err instanceof StackVersionExistsError) {
    res
      .status(409)
      .json({ error: 'stack_version_exists', name: err.versionName });
    return;
  }
  if (err instanceof StackVersionInUseError) {
    res.status(409).json({
      error: 'stack_version_in_use',
      name: err.versionName,
      deployments: err.deployments,
      message: err.message,
    });
    return;
  }
  if (err instanceof StackVersionRemovalHeldError) {
    res.status(409).json({ error: 'stack_version_removal_held', name: err.versionName, reason: err.reason, message: err.message });
    return;
  }
  if (err instanceof BundledVersionError) {
    res.status(409).json({ error: 'bundled_version', message: err.reason });
    return;
  }
  if (err instanceof DefaultVersionError) {
    res.status(409).json({
      error: 'stack_version_is_default',
      name: err.versionName,
      message: err.message,
    });
    return;
  }
  if (err instanceof UntestedVersionError) {
    res.status(409).json({
      error: 'stack_version_untested',
      name: err.versionName,
      message: err.message,
    });
    return;
  }
  if (err instanceof StackBuildBusyError) {
    res.status(409).json({
      error: 'stack_build_busy',
      name: err.buildingName,
      message: err.message,
    });
    return;
  }
  if (err instanceof AllSlotsUsedError) {
    res.status(503).json({ error: 'all_slots_used', message: err.message });
    return;
  }
  if (err instanceof TargetNotVerifiedError) {
    res.status(409).json({ error: 'target_not_verified', alias: err.alias, message: err.message });
    return;
  }
  if (err instanceof PortReservedError) {
    res.status(409).json({ error: 'port_reserved', name: err.profileName, message: err.message });
    return;
  }
  if (err instanceof ReservationInventoryPendingError) {
    res.status(409).json({ error: 'reservation_inventory_pending', message: err.message });
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
