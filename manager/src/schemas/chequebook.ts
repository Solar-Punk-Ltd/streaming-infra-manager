import { MAX_PLUR_DIGITS } from '@streaming-infra-manager/common';
import { object, string, InferType } from 'yup';

/**
 * PLUR is bee's integer unit, so a decimal point in this field means the caller
 * has sent a BZZ amount by mistake and would move ten thousand million million
 * times less than it meant to. The conversion belongs to the caller, and
 * `bzzToPlur` in the shared package is what does it.
 */
const PLUR_AMOUNT_RE = /^[1-9][0-9]*$/;

export const moveBzzSchema = object({
  amount: string()
    .required('amount is required')
    .matches(PLUR_AMOUNT_RE, 'amount must be a positive whole number of PLUR')
    .max(MAX_PLUR_DIGITS, `amount must be at most ${MAX_PLUR_DIGITS} digits`),
});

export type MoveBzzBody = InferType<typeof moveBzzSchema>;
