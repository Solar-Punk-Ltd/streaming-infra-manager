import { MAX_STAMP_DEPTH, MIN_STAMP_DEPTH } from '@streaming-infra-manager/common';
import { boolean, number, object, string, InferType } from 'yup';

const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

/** A batch id the way bee spells one, 32 bytes of hex, with or without `0x`. */
const batchIdField = (field: string) =>
  string()
    .required(`${field} is required`)
    .matches(STAMP_ID_RE, `${field} must be 32-byte hex (optionally 0x-prefixed)`);

/** PLUR per chunk, a whole number kept as a string so no digit is lost. */
const amountField = () =>
  string()
    .required('amount is required')
    .matches(POSITIVE_INTEGER_RE, 'amount must be a positive integer');

/** A batch depth this manager buys or dilutes to. */
const depthField = () =>
  number()
    .required('depth is required')
    .integer('depth must be an integer')
    .min(MIN_STAMP_DEPTH, `depth must be at least ${MIN_STAMP_DEPTH}`)
    .max(MAX_STAMP_DEPTH, `depth must be at most ${MAX_STAMP_DEPTH}`);

export const buyStampSchema = object({
  amount: amountField(),
  depth: depthField(),
  label: string().max(120, 'label too long').notRequired(),
  immutable: boolean().notRequired(),
}).noUnknown(true);

export const setStampSchema = object({
  stamp_id: batchIdField('stamp_id'),
}).noUnknown(true);

export const topUpStampSchema = object({
  batch_id: batchIdField('batch_id'),
  amount: amountField(),
}).noUnknown(true);

export const diluteStampSchema = object({
  batch_id: batchIdField('batch_id'),
  depth: depthField(),
}).noUnknown(true);

export type BuyStampBody = InferType<typeof buyStampSchema>;
export type SetStampBody = InferType<typeof setStampSchema>;
export type TopUpStampBody = InferType<typeof topUpStampSchema>;
export type DiluteStampBody = InferType<typeof diluteStampSchema>;
