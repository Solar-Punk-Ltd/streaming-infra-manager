import { useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';

import {
  CLIENT_SERVICE,
  getErrorMessage,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import {
  hasService,
  servicesOf,
  SHAPE_LABEL,
  shapeOf,
  streamersOf,
} from '../deployments/shape';
import { updateGroupConfig, type UpdateGroupConfigBody } from '../data';
import type { Profile } from '../types';
import { hostFor } from '../urls';
import { hasEdits } from './deploymentEdits';
import { EditDrawerFrame } from './EditDrawerFrame';
import { FixedAtCreation } from './FixedAtCreation';
import { FormField } from './FormField';
import { PassphraseField, type PassphraseMode } from './PassphraseField';
import { addressProblem, notesProblem, passphraseProblem } from './validation';

interface GroupEdits {
  passMode: PassphraseMode;
  passphrase: string;
  feedOwner: string;
  notes: string;
}

const savedMessage = (groupName: string, memberCount: number): string =>
  `Saved. Redeploying ${groupName}, ${memberCount} ${memberCount === 1 ? 'member' : 'members'}…`;

export function EditGroupDrawer({
  id,
  onClose,
}: {
  id: number;
  onClose: () => void;
}) {
  const { profiles, groups, serverHost, mergeProfiles } = useDeployments();
  const toast = useToast();

  const group = groups.find((entry) => entry.id === id) ?? null;
  const members = (profiles ?? []).filter((profile) => profile.group_id === id);
  const first: Profile | undefined = members[0];

  // The snapshot the form opened with. Only fields changed against it are sent,
  // and the PATCH leaves every field it does not receive alone.
  const [initial] = useState<GroupEdits>(() => initialEdits(first));
  const [edits, setEdits] = useState<GroupEdits>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!group || !first) return null;

  const update = (patch: Partial<GroupEdits>) =>
    setEdits((prev) => ({ ...prev, ...patch }));

  const showsPassphrase = hasService(first, SRS_SERVICE);
  const showsFeedOwner = hasService(first, CLIENT_SERVICE);
  const problem = groupProblem(edits, showsPassphrase, showsFeedOwner);
  const streams = streamersOf(profiles ?? []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await updateGroupConfig(
        group.id,
        bodyFor(initial, edits, showsPassphrase, showsFeedOwner),
      );
      mergeProfiles(result.profiles);
      onClose();
      toast(savedMessage(group.name, result.profiles.length));
    } catch (caught) {
      setError(getErrorMessage(caught, 'failed to save the group'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditDrawerFrame
      title={`Edit group ${group.name}`}
      saving={saving}
      error={error}
      saveDisabled={problem !== null || !hasEdits(initial, edits)}
      onSave={() => void save()}
      onClose={onClose}
    >
      <FixedAtCreation
        type={SHAPE_LABEL[shapeOf(first)]}
        services={servicesOf(first)}
        host={hostFor(first, serverHost)}
        name={`${group.name}-profile-N`}
      />

      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          p: 1.5,
          bgcolor: 'action.hover',
        }}
      >
        <Typography variant="body2">
          Changes apply to all {members.length} members and redeploy them. Keys and
          stamps stay per member.
        </Typography>
      </Box>

      {showsPassphrase && (
        <PassphraseField
          mode={edits.passMode}
          value={edits.passphrase}
          appliesToAll
          onModeChange={(passMode) => update({ passMode })}
          onValueChange={(passphrase) => update({ passphrase })}
        />
      )}

      {showsFeedOwner && (
        <FormField
          label="Streamer to follow"
          aside="public address"
          error={addressProblem(edits.feedOwner)}
          hint={
            streams.length > 0 ? (
              <Stack direction="row" spacing={0.5} flexWrap="wrap" alignItems="center">
                <span>On this manager:</span>
                {streams.map((stream) => (
                  <Button
                    key={stream.name}
                    size="small"
                    onClick={() => update({ feedOwner: stream.public_key ?? '' })}
                  >
                    {stream.name}
                  </Button>
                ))}
              </Stack>
            ) : (
              'No streams on this manager yet, so paste the address.'
            )
          }
        >
          <TextField
            size="small"
            fullWidth
            value={edits.feedOwner}
            onChange={(event) => update({ feedOwner: event.target.value })}
            placeholder="0x plus 40 hex characters"
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
        </FormField>
      )}

      <FormField label="Notes" error={notesProblem(edits.notes)}>
        <TextField
          size="small"
          fullWidth
          multiline
          minRows={2}
          value={edits.notes}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </FormField>
    </EditDrawerFrame>
  );
}

function initialEdits(first: Profile | undefined): GroupEdits {
  return {
    passMode: first?.srt_passphrase?.trim() ? 'own' : 'host',
    passphrase: first?.srt_passphrase ?? '',
    feedOwner: first?.feed_owner ?? '',
    notes: first?.notes ?? '',
  };
}

function groupProblem(
  edits: GroupEdits,
  showsPassphrase: boolean,
  showsFeedOwner: boolean,
): string | null {
  if (showsPassphrase && edits.passMode === 'own') {
    const problem = passphraseProblem(edits.passphrase);
    if (problem) return problem;
  }
  if (showsFeedOwner) {
    const problem = addressProblem(edits.feedOwner);
    if (problem) return problem;
  }
  return notesProblem(edits.notes);
}

/**
 * Only what the operator changed goes in the body. The PATCH reads `undefined`
 * as "leave every member alone", which is right for an untouched field and is
 * why the host-wide choice has to be an explicit null: sending `undefined` for
 * it is what kept a group that once had its own passphrase from ever going
 * back.
 */
function bodyFor(
  initial: GroupEdits,
  edits: GroupEdits,
  showsPassphrase: boolean,
  showsFeedOwner: boolean,
): UpdateGroupConfigBody {
  const passphraseChanged =
    edits.passMode !== initial.passMode ||
    edits.passphrase !== initial.passphrase;
  return {
    notes:
      edits.notes !== initial.notes ? edits.notes.trim() || null : undefined,
    feed_owner:
      showsFeedOwner && edits.feedOwner !== initial.feedOwner
        ? edits.feedOwner.trim()
        : undefined,
    srt_passphrase:
      showsPassphrase && passphraseChanged
        ? edits.passMode === 'own'
          ? edits.passphrase.trim()
          : null
        : undefined,
  };
}
