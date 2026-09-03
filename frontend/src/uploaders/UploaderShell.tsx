import type { ReactNode } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { PUBLISHABLE_RUNG_STATUS } from '@streaming-infra-manager/common';

import { StatusChip } from '../StatusChip';
import type { ProfileStatus } from '../types';

/**
 * The frame every uploader row shares: one accordion, one summary line.
 *
 * Only the frame. What goes inside differs completely between an uploader that
 * owns its postage and one publishing to a node pool, and trying to express
 * that difference as flags on a single card is what produced a Deploy button
 * that could never legitimately fire. The two cards compose this instead.
 */
export function UploaderShell({
  title,
  status,
  badges,
  trailing,
  nested = false,
  children,
}: {
  /** The profile name, or what leads instead — an ABR rung leads with its rung. */
  title: ReactNode;
  status: ProfileStatus;
  /** Chips before the status chip. */
  badges?: ReactNode;
  /** Chips after the status chip — the stamp chip, where there is one. */
  trailing?: ReactNode;
  /** Rendered inside another card: drop the elevation so nesting reads as hierarchy. */
  nested?: boolean;
  children: ReactNode;
}) {
  // Only when it is not running: these cards are about a deployment's upload
  // path, and a chip on every healthy row would bury the one row that needs
  // attention. The Deployments tab is where status is shown unconditionally.
  const statusChip =
    status === PUBLISHABLE_RUNG_STATUS ? null : <StatusChip status={status} />;

  return (
    <Accordion
      disableGutters={nested}
      elevation={nested ? 0 : undefined}
      sx={nested ? { border: 1, borderColor: 'divider' } : undefined}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ width: '100%' }}
        >
          <Typography sx={{ fontFamily: 'monospace', flexGrow: 1 }}>
            {title}
          </Typography>
          {badges}
          {statusChip}
          {trailing}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>{children}</Stack>
      </AccordionDetails>
    </Accordion>
  );
}
