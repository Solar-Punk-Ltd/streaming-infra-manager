import { useState, type FormEvent } from 'react';
import {
  Button,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material';

import {
  type BeePublishersResult,
  rungFromMemberName,
  rungOrder,
} from '@streaming-infra-manager/common';

import { useActions } from '../app/useDeploymentActions';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { DeploymentRow } from '../deployments/DeploymentRow';
import { isRunning } from '../deployments/shape';
import type { DeploymentGroup, Profile } from '../types';
import { PoolRungRow } from './PoolRungRow';

export function GroupMembersCard({
  group,
  members,
  isPool,
  poolResult,
}: {
  group: DeploymentGroup;
  members: Profile[];
  isPool: boolean;
  poolResult: BeePublishersResult | null;
}) {
  const running = members.filter(isRunning).length;

  return (
    <SectionCard
      title="Members"
      sub={`${running}/${members.length} running`}
      actions={isPool ? undefined : <AddMembersForm group={group} />}
      flush
    >
      {members.length === 0 ? (
        <EmptyState
          title="This group has no members."
          hint="Add one above, or remove the group if it is not needed."
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableCell />
              <TableCell>Name</TableCell>
              <TableCell>State</TableCell>
              {isPool ? (
                <>
                  <TableCell>Funding</TableCell>
                  <TableCell>Stamp</TableCell>
                </>
              ) : (
                <TableCell>Links</TableCell>
              )}
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isPool
              ? poolRows(group, members, poolResult)
              : members.map((profile) => (
                  <DeploymentRow key={profile.name} profile={profile} />
                ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function poolRows(
  group: DeploymentGroup,
  members: Profile[],
  poolResult: BeePublishersResult | null,
) {
  return members
    .map((profile) => ({
      profile,
      rung: rungFromMemberName(group.name, profile.name),
    }))
    .filter(
      (entry): entry is { profile: Profile; rung: string } => entry.rung !== null,
    )
    .sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung))
    .map(({ profile, rung }) => (
      <PoolRungRow
        key={profile.name}
        rung={rung}
        profile={profile}
        rungState={
          poolResult?.rungs.find((entry) => entry.rung === rung) ?? null
        }
      />
    ));
}

function AddMembersForm({ group }: { group: DeploymentGroup }) {
  const actions = useActions();
  const [count, setCount] = useState('1');
  const parsed = Number.parseInt(count, 10);
  const valid = Number.isInteger(parsed) && parsed > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    void actions.addMembers(group, parsed);
  };

  return (
    <Stack component="form" direction="row" spacing={1} onSubmit={submit}>
      <TextField
        value={count}
        onChange={(event) => setCount(event.target.value)}
        error={!valid}
        helperText={valid ? undefined : 'A whole number, at least 1'}
        sx={{ width: 88 }}
        slotProps={{
          htmlInput: { 'aria-label': 'how many members to add' },
        }}
      />
      <Button size="small" type="submit" disabled={!valid} sx={{ alignSelf: 'flex-start' }}>
        Add members
      </Button>
    </Stack>
  );
}
