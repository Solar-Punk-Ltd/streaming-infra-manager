import { Fragment, useState } from 'react';
import {
  Button,
  IconButton,
  Stack,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import {
  ABR_LADDER_SIZE,
  type BeePublishersResult,
  isLadderKind,
  rungFromMemberName,
} from '@streaming-infra-manager/common';

import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { ReadinessPill } from '../components/ReadinessPill';
import { groupReadinessOf } from '../groups/groupReadiness';
import type { DeploymentGroup, Profile } from '../types';
import { DeploymentRow } from './DeploymentRow';
import { isRunning, isTransitional } from './shape';

function groupSubLabel(
  group: DeploymentGroup,
  members: Profile[],
  memberNoun: string,
): string {
  if (isLadderKind(group.kind)) {
    return `ABR node pool · ${ABR_LADDER_SIZE} Bee nodes, one per quality`;
  }
  return `Group · ${members.length} ${memberNoun}`;
}

export function GroupBlockRows({
  group,
  members,
  visibleMembers,
  poolResult,
  memberNoun,
}: {
  group: DeploymentGroup;
  /** Every member, for the counts and the fan-out actions. */
  members: Profile[];
  /** The members the current filter and search let through. */
  visibleMembers: Profile[];
  poolResult: BeePublishersResult | null;
  memberNoun: string;
}) {
  const actions = useActions();
  const [open, setOpen] = useState(true);

  const readiness = groupReadinessOf(group, members, poolResult);
  const running = members.filter(isRunning).length;
  const startable = members.some((m) => !isRunning(m) && !isTransitional(m));

  return (
    <Fragment>
      <TableRow
        hover
        sx={{ cursor: 'pointer', '& td': { bgcolor: 'action.hover' } }}
        onClick={() => setOpen((value) => !value)}
      >
        <TableCell sx={{ width: 28 }}>
          <IconButton
            size="small"
            aria-label={`${open ? 'collapse' : 'expand'} ${group.name}`}
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
          >
            {open ? (
              <ExpandMoreIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
            {group.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {groupSubLabel(group, members, memberNoun)}
          </Typography>
        </TableCell>
        <TableCell>
          <ReadinessPill label={readiness.label} tone={readiness.tone} />
        </TableCell>
        <TableCell>
          <Typography variant="caption" color="text.secondary">
            {running}/{members.length} running
          </Typography>
        </TableCell>
        <TableCell align="right" onClick={(event) => event.stopPropagation()}>
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            {running > 0 && (
              <Button size="small" onClick={() => actions.stopGroup(group, members)}>
                Stop all
              </Button>
            )}
            {startable && (
              <Button
                size="small"
                variant="contained"
                onClick={() => actions.startGroup(group, members)}
              >
                Start all
              </Button>
            )}
            <Button size="small" onClick={() => navigate(routes.group(group.id))}>
              Open
            </Button>
          </Stack>
        </TableCell>
      </TableRow>

      {open &&
        visibleMembers.map((profile) => (
          <DeploymentRow
            key={profile.name}
            profile={profile}
            rung={rungFromMemberName(group.name, profile.name)}
            indented
          />
        ))}
    </Fragment>
  );
}
