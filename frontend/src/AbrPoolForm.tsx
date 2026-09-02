import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  ABR_LADDER_SIZE,
  DEFAULT_ABR_LADDER,
  getErrorMessage,
  LADDER_GROUP_NAME_MAX,
} from '@streaming-infra-manager/common';

import { createDeploymentGroup, updateGroupConfig } from './data';
import type { DeploymentGroup, Profile } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;

/**
 * The whole ABR Node Pool form.
 *
 * Deliberately a separate component rather than another branch inside
 * NewDeploymentDrawer. A pool shares almost nothing with a streaming-infra
 * deployment — no kind, no components, no media engine, no feed, no key, no
 * stamp, and a fixed size — so expressing it as conditionals inside the other
 * form meant every one of those fields needed a `!ladderMode` guard, and the
 * ones that were missed rendered anyway and contradicted what would actually be
 * created.
 *
 * Here there is nothing to guard: the fields that do not apply simply are not in
 * this file.
 */
export function AbrPoolForm({
  onCreated,
  onClose,
  editingGroup,
}: {
  onCreated: (profiles: Profile[]) => void;
  onClose: () => void;
  /** Set when editing an existing pool — name and host are then immutable. */
  editingGroup?: { group: DeploymentGroup; members: Profile[] } | null;
}) {
  const isEdit = !!editingGroup;

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Keyed on the group id, not the object — the same reason AbrUploaderForm
  // keys on the profile name. App rebuilds the `selectedGroup` prop on every
  // render, and each `profile.changed` SSE event triggers one: with an object
  // dependency, the four rungs going DEPLOYING -> RUNNING would re-run this
  // mid-keystroke and reset Notes to the stored value, so "Save pool" would
  // write the old note back to all four members.
  const editingGroupId = editingGroup?.group.id ?? null;
  useEffect(() => {
    if (!editingGroup) return;
    setName(editingGroup.group.name);
    setHost(editingGroup.members[0]?.host ?? '');
    setNotes(editingGroup.members[0]?.notes ?? '');
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingGroupId]);

  const nameError = (() => {
    if (name.length === 0) return null;
    if (!NAME_RE.test(name)) {
      return 'lowercase letters, digits, dashes (max 31 chars)';
    }
    if (name.length > LADDER_GROUP_NAME_MAX) {
      // Members are `<pool>-<rung>` and profile names cap at 31, so the longest
      // rung (`1080p`) is what sets this bound.
      return `max ${LADDER_GROUP_NAME_MAX} chars — members are named <pool>-<rung>`;
    }
    return null;
  })();

  const hostError =
    host.length > 0 && !HOST_RE.test(host)
      ? 'e.g. "localhost", an ssh alias, or "user@host"'
      : null;
  const notesError = notes.length > 500 ? 'max 500 chars' : null;

  const canSubmit =
    !submitting &&
    (isEdit || name.length > 0) &&
    !nameError &&
    !hostError &&
    !notesError;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (editingGroup) {
        // Only notes are editable: a pool's members are fixed to one per rung,
        // and each rung's postage batch is bought individually.
        const result = await updateGroupConfig(editingGroup.group.id, {
          notes: notes.trim() ? notes.trim() : null,
        });
        onCreated(result.profiles);
      } else {
        const result = await createDeploymentGroup({
          group_name: name,
          size: ABR_LADDER_SIZE,
          abr_ladder: true,
          kind: 'custom',
          notes: notes.trim() ? notes.trim() : null,
          host: host.trim() || 'localhost',
        });
        onCreated(result.profiles);
      }
      onClose();
    } catch (e) {
      setSubmitError(
        getErrorMessage(
          e,
          isEdit ? 'failed to update pool' : 'failed to create pool',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2}>
      <PoolSummary />

      <TextField
        label="Pool name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoFocus={!isEdit}
        disabled={isEdit}
        error={!!nameError}
        helperText={
          nameError ??
          (isEdit
            ? 'locked — names are immutable'
            : `members will be named ${name || '<pool>'}-360p, ${name || '<pool>'}-480p, …`)
        }
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
      />

      <TextField
        label="Host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        disabled={isEdit}
        error={!!hostError}
        helperText={
          hostError ??
          (isEdit
            ? 'locked — host cannot change after first deploy'
            : 'optional — defaults to "localhost"')
        }
      />

      <TextField
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        multiline
        minRows={2}
        error={!!notesError}
        helperText={notesError ?? `${notes.length}/500`}
      />

      {submitError && (
        <Alert severity="error" onClose={() => setSubmitError(null)}>
          {submitError}
        </Alert>
      )}

      <Button
        variant="contained"
        onClick={handleSubmit}
        disabled={!canSubmit}
        startIcon={submitting ? <CircularProgress size={16} /> : null}
      >
        {isEdit ? 'Save pool' : 'Create pool'}
      </Button>

      {!canSubmit && !submitting && (
        <Typography variant="caption" color="text.secondary">
          {name.length === 0 && !isEdit
            ? 'Enter a pool name'
            : (nameError ?? hostError ?? notesError ?? '')}
        </Typography>
      )}
    </Stack>
  );
}

/** What a pool will actually create, and what has to happen afterwards. */
function PoolSummary() {
  return (
    <Alert severity="info" icon={false}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        One <code>bee-uploader</code> per quality rung, and nothing else. SRS and
        the stream-uploader run elsewhere and publish through them.
      </Typography>
      <Box component="table" sx={{ borderCollapse: 'collapse', mb: 1 }}>
        <tbody>
          {DEFAULT_ABR_LADDER.map((rung, i) => (
            <Box component="tr" key={rung.name}>
              <Box
                component="td"
                sx={{ pr: 2, fontFamily: 'monospace', fontSize: 13 }}
              >
                &lt;pool&gt;-{rung.name}
              </Box>
              <Box
                component="td"
                sx={{ pr: 2, fontSize: 13, color: 'text.secondary' }}
              >
                {rung.width}×{rung.height} · {rung.kbps} kbps
              </Box>
              <Box component="td" sx={{ fontSize: 13, color: 'text.secondary' }}>
                {i === 0 ? 'coordinator' : ''}
              </Box>
            </Box>
          ))}
        </tbody>
      </Box>
      <Typography variant="caption" color="text.secondary">
        Each rung gets its own port slot, wallet and postage batch. Fund them and
        buy a batch each from the Uploaders tab, then paste the{' '}
        <code>BEE_PUBLISHERS</code> string into a streamer&apos;s{' '}
        <strong>BEE_PUBLISHERS</strong> field — on whichever manager runs it.
      </Typography>
    </Alert>
  );
}
