import { useState } from 'react';
import { Button, Stack, TextField } from '@mui/material';

import {
  beePublishersProblem,
  beeUrlProblem,
  getErrorMessage,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import { servicesOf, SHAPE_LABEL, shapeOf, streamersOf } from '../deployments/shape';
import { updateProfile } from '../data';
import { hostFor } from '../urls';
import {
  bodyFor,
  editProblem,
  fieldsFor,
  hasEdits,
  initialEdits,
  poolHint,
  type DeploymentEdits,
} from './deploymentEdits';
import { EditDrawerFrame } from './EditDrawerFrame';
import { FixedAtCreation } from './FixedAtCreation';
import { FormField } from './FormField';
import { PassphraseField } from './PassphraseField';
import { StreamKeyField } from './StreamKeyField';
import { addressProblem, notesProblem, stampIdProblem } from './validation';

const savedMessage = (name: string): string => `Saved. Redeploying ${name}…`;

const STAMP_HINT =
  'Usually set from the Storage card. Paste one here only to point at a batch bought elsewhere.';

export function EditDeploymentDrawer({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const { profiles, serverHost, mergeProfiles } = useDeployments();
  const toast = useToast();
  const profile = (profiles ?? []).find((entry) => entry.name === name) ?? null;

  // The snapshot the form opened with. Saving compares against it, so a field
  // the operator never touched keeps whatever the live profile holds by then.
  const [initial] = useState<DeploymentEdits>(() => initialEdits(profile));
  const [edits, setEdits] = useState<DeploymentEdits>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile) return null;

  const update = (patch: Partial<DeploymentEdits>) =>
    setEdits((prev) => ({ ...prev, ...patch }));

  const shown = fieldsFor(profile);
  const problem = editProblem(edits, shown);
  const streams = streamersOf(profiles ?? []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateProfile(
        profile.name,
        bodyFor(profile, initial, edits, shown),
      );
      mergeProfiles([saved]);
      onClose();
      toast(savedMessage(profile.name));
    } catch (caught) {
      setError(getErrorMessage(caught, 'failed to save the deployment'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditDrawerFrame
      title={`Edit ${profile.name}`}
      saving={saving}
      error={error}
      saveDisabled={problem !== null || !hasEdits(initial, edits)}
      onSave={() => void save()}
      onClose={onClose}
    >
      <FixedAtCreation
        type={SHAPE_LABEL[shapeOf(profile)]}
        services={servicesOf(profile)}
        host={hostFor(profile, serverHost)}
        name={profile.name}
      />

      {shown.passphrase && (
        <PassphraseField
          mode={edits.passMode}
          value={edits.passphrase}
          onModeChange={(passMode) => update({ passMode })}
          onValueChange={(passphrase) => update({ passphrase })}
        />
      )}

      {shown.key && (
        <StreamKeyField
          value={edits.key}
          storedKey={profile.private_key ?? ''}
          storedAddress={profile.public_key ?? null}
          onChange={(key) => update({ key })}
        />
      )}

      {shown.stamp && (
        <FormField
          label="Postage stamp ID"
          aside="optional"
          hint={STAMP_HINT}
          error={edits.stampId.trim() ? stampIdProblem(edits.stampId) : null}
        >
          <TextField
            size="small"
            fullWidth
            value={edits.stampId}
            onChange={(event) => update({ stampId: event.target.value })}
            placeholder="64 hex characters"
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
        </FormField>
      )}

      {shown.beeUrl && (
        <FormField
          label="External Bee API"
          hint="This deployment runs no Bee node of its own, so uploads go here."
          error={beeUrlProblem(edits.beeUrl)}
        >
          <TextField
            size="small"
            fullWidth
            value={edits.beeUrl}
            onChange={(event) => update({ beeUrl: event.target.value })}
            placeholder="http://10.0.0.7:1633"
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
        </FormField>
      )}

      {shown.poolString && (
        <FormField
          label="Node pool string"
          hint={poolHint(edits.poolString)}
          error={beePublishersProblem(edits.poolString)}
        >
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={3}
            value={edits.poolString}
            onChange={(event) => update({ poolString: event.target.value })}
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
        </FormField>
      )}

      {shown.feedOwner && (
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
