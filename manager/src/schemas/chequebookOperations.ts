import type { ChequebookHistoryQuery } from '@streaming-infra-manager/common';
import { object, string, type InferType } from 'yup';
import { ChequebookOperationInputError } from '../domain/errors/ChequebookOperationInputError.js';
import { normalizeHistoryQuery } from '../domain/chequebook/chequebookHistory.js';

const uuid = string().typeError('requestId must be a UUID').required('requestId is required')
  .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'requestId must be a UUID');
const amount = string().typeError('amount must be a positive whole number of PLUR').required('amount is required')
  .matches(/^[1-9][0-9]{0,29}$/, 'amount must be a positive whole number of PLUR with at most 30 digits');
const strictObject = object().typeError('A JSON object is required').noUnknown(true, 'Unexpected request fields').strict();
export const submitChequebookSchema = strictObject.shape({ requestId: uuid, amount });
export const checkChequebookSchema = strictObject;
export const resolveChequebookSchema = strictObject.shape({ transactionHash: string().typeError('A transaction hash is required').required('A transaction hash is required')
  .matches(/^0x[0-9a-f]{64}$/i, 'A transaction hash must contain 64 hexadecimal digits') });
export const assertChequebookSchema = strictObject.shape({ amountPlur: amount,
  confirmation: string().typeError('The exact confirmation text is required').required('The exact confirmation text is required').max(200, 'The confirmation text is too long') });
export type SubmitChequebookBody = InferType<typeof submitChequebookSchema>;
export type ResolveChequebookBody = InferType<typeof resolveChequebookSchema>;
export type AssertChequebookBody = InferType<typeof assertChequebookSchema>;

export function chequebookHistoryQuery(input: unknown): ChequebookHistoryQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['limit', 'cursor', 'profileName'].includes(key))) throw new ChequebookOperationInputError('history query');
  const raw = input as Record<string, unknown>;
  for (const value of Object.values(raw)) if (typeof value !== 'string') throw new ChequebookOperationInputError('history query');
  if (raw.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(raw.limit as string)) throw new ChequebookOperationInputError('history limit');
  const query: ChequebookHistoryQuery = { ...(raw.limit !== undefined ? { limit: Number(raw.limit) } : {}),
    ...(raw.cursor !== undefined ? { cursor: raw.cursor as string } : {}), ...(raw.profileName !== undefined ? { profileName: raw.profileName as string } : {}) };
  normalizeHistoryQuery(query);
  return query;
}
