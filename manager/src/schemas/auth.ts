import {
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MESSAGE,
  USERNAME_RE,
} from '@streaming-infra-manager/common';
import { InferType, object, string } from 'yup';

const usernameField = () =>
  string().required('username is required').matches(USERNAME_RE, USERNAME_MESSAGE);

/**
 * The sign-in body. Both fields are bounded and neither is shape-checked: a
 * wrong pair must answer the same way whatever it looked like, and the rules
 * that decide whether a password is good enough belong to the routes that set
 * one. The bound is here because the route needs no session, so without it any
 * caller could make scrypt hash a 256 KB body as often as it liked.
 */
export const loginSchema = object({
  username: string().required('username is required').max(USERNAME_MAX_LENGTH),
  password: string().required('password is required').max(PASSWORD_MAX_LENGTH),
}).noUnknown(true);

export type LoginBody = InferType<typeof loginSchema>;

export const createUserSchema = object({
  username: usernameField(),
  password: string().required('password is required'),
}).noUnknown(true);

export type CreateUserBody = InferType<typeof createUserSchema>;

export const changePasswordSchema = object({
  current: string().required('current password is required'),
  next: string().required('new password is required'),
}).noUnknown(true);

export type ChangePasswordBody = InferType<typeof changePasswordSchema>;

export const userIdParamSchema = object({
  id: string()
    .required()
    .matches(/^[1-9]\d*$/, 'id must be a positive integer'),
}).strict();
