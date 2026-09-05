import { Box, Stack, Typography } from '@mui/material';

import {
  beePublishersProblem,
  parseBeePublishers,
  rungOrder,
  type BeePublisherEntry,
} from '@streaming-infra-manager/common';

import { CopyButton } from './CopyButton';
import { shortHex } from './format';

/**
 * A BEE_PUBLISHERS string as its rungs, ascending, or null when the string is
 * not a usable pool.
 *
 * The null covers both halves of "usable": one that does not parse at all, and
 * one that parses into a ladder with a rung missing, a rung twice, or an
 * address the uploader's container could not reach. `beePublishersProblem`
 * settles all of those, and because it guarantees every rung is a rung of the
 * shipped ladder, `rungOrder` below can never come back -1.
 */
export function sortedPublisherRungs(
  value: string | null | undefined,
): BeePublisherEntry[] | null {
  if (!value || beePublishersProblem(value)) return null;
  const entries = parseBeePublishers(value);
  if (!entries) return null;
  return [...entries].sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung));
}

/**
 * Where each rung of a ladder publishes to.
 *
 * BEE_PUBLISHERS is one line carrying four URLs and four 64-character batch
 * ids, so reading it back to check it is the pool you meant is not realistic.
 * This is the same list in both places it matters: confirming a paste in the
 * form, and saying where a deployed uploader is actually sending segments,
 * with the framing left to the caller, because one is validation feedback and
 * the other is configuration.
 */
export function PublisherRungList({
  rungs,
  showBatchIds = false,
}: {
  rungs: BeePublisherEntry[];
  /** The pool's batch ids. Off in the form, where the paste is on screen. */
  showBatchIds?: boolean;
}) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {rungs.map((entry) => (
        <li key={entry.rung}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {entry.rung} → {entry.url}
            </Typography>
            {showBatchIds && (
              <>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: 'monospace' }}
                >
                  {shortHex(entry.batchId)}
                </Typography>
                <CopyButton
                  value={entry.batchId}
                  label={`${entry.rung} batch id`}
                />
              </>
            )}
          </Stack>
        </li>
      ))}
    </Box>
  );
}
