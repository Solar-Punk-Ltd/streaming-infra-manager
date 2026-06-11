import { boolean, number, object, string, InferType } from 'yup';

const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export const buyStampSchema = object({
  amount: string()
    .required('amount is required')
    .matches(/^[1-9][0-9]*$/, 'amount must be a positive integer'),
  depth: number()
    .required('depth is required')
    .integer('depth must be an integer')
    .min(17, 'depth must be at least 17')
    .max(40, 'depth must be at most 40'),
  label: string().max(120, 'label too long').notRequired(),
  immutable: boolean().notRequired(),
}).noUnknown(true);

export const setStampSchema = object({
  stamp_id: string()
    .required('stamp_id is required')
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
}).noUnknown(true);

export type BuyStampBody = InferType<typeof buyStampSchema>;
export type SetStampBody = InferType<typeof setStampSchema>;
