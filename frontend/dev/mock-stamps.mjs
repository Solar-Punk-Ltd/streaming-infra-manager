/**
 * The two changes the offline mock makes to a batch a node holds, top-up and
 * dilute, answered the way the manager answers them.
 *
 * A body is validated with the manager's own schemas and a refusal carries the
 * manager's own sentence, so a dialog that passes here passes on a host. The
 * change reaches the node's batch a moment after the answer, the way a mined
 * transaction reaches a real node's list a few blocks later, and it is worked
 * out by the arithmetic the dialogs preview it with.
 */
import { dilutionPreview, topUpPreview } from '@streaming-infra-manager/common';

import { DiluteDepthError } from '../../manager/src/domain/errors/DiluteDepthError.ts';
import { StampNotFoundError } from '../../manager/src/domain/errors/StampNotFoundError.ts';
import {
  diluteStampSchema,
  topUpStampSchema,
} from '../../manager/src/schemas/stamp.ts';
import { send } from './mock-http.mjs';
import { hex, node } from './mock-seed.mjs';

/** Today's price per chunk per block on this offline chain, which the chainstate route answers. */
export const MOCK_CURRENT_PRICE = '24000';

/** How long a change takes to reach the node's list, as a mined transaction does. */
const STAMP_CHANGE_SETTLE_MS = 2_000;

/** The body, or null once a refusal has been answered. */
async function validBody(schema, req, res, readBody) {
  try {
    return await schema.validate(await readBody(req), { abortEarly: false, stripUnknown: true });
  } catch (error) {
    send(res, 400, { error: 'validation_error', errors: error.errors ?? ['Invalid request.'] });
    return null;
  }
}

/** The batch the node holds by that id, however the id was spelled. */
function heldBatch(profile, batchId) {
  const id = batchId.replace(/^0x/, '');
  return node(profile.name).stamps.find((stamp) => stamp.batchID === id) ?? null;
}

function refuseNotHeld(res, profile, batchId) {
  const refusal = new StampNotFoundError(profile.name, batchId.replace(/^0x/, ''));
  send(res, 404, { error: 'stamp_not_found', name: profile.name, message: refusal.message });
}

/** What bee answers a change with: the batch, and a transaction nobody will find on a chain. */
function sentTransaction(stamp) {
  return { batchID: stamp.batchID, txHash: `0x${hex(32)}` };
}

function topUp(stamp, amount) {
  const after = topUpPreview(stamp, amount, MOCK_CURRENT_PRICE);
  if (after.ttl !== null) stamp.batchTTL = after.ttl;
  stamp.amount = String(BigInt(stamp.amount) + BigInt(amount));
}

function dilute(stamp, depth) {
  const after = dilutionPreview(stamp, depth);
  stamp.depth = depth;
  if (after?.ttl != null) stamp.batchTTL = after.ttl;
}

export function stampChangeRoutes({ readBody, withProfile }) {
  return [
    [
      'POST',
      /^\/profiles\/([^/]+)\/stamp\/topup$/,
      withProfile(async (req, res, profile) => {
        const body = await validBody(topUpStampSchema, req, res, readBody);
        if (!body) return;
        const stamp = heldBatch(profile, body.batch_id);
        if (!stamp) return refuseNotHeld(res, profile, body.batch_id);
        send(res, 202, sentTransaction(stamp));
        setTimeout(() => topUp(stamp, body.amount), STAMP_CHANGE_SETTLE_MS);
      }),
    ],
    [
      'POST',
      /^\/profiles\/([^/]+)\/stamp\/dilute$/,
      withProfile(async (req, res, profile) => {
        const body = await validBody(diluteStampSchema, req, res, readBody);
        if (!body) return;
        const stamp = heldBatch(profile, body.batch_id);
        if (!stamp) return refuseNotHeld(res, profile, body.batch_id);
        if (body.depth <= stamp.depth) {
          const refusal = new DiluteDepthError(profile.name, stamp.batchID, stamp.depth, body.depth);
          return send(res, 400, { error: 'validation_error', errors: [refusal.reason] });
        }
        send(res, 202, sentTransaction(stamp));
        setTimeout(() => dilute(stamp, body.depth), STAMP_CHANGE_SETTLE_MS);
      }),
    ],
  ];
}
