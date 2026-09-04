import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CasinoIcon from '@mui/icons-material/Casino';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  beePublishersProblem,
  getErrorMessage,
} from '@streaming-infra-manager/common';

import { createProfile, updateProfile } from './data';
import { PublisherRungList, sortedPublisherRungs } from './PublisherRungs';
import {
  beePublishersHelperText,
  hostHelperText,
  notesHelperText,
  publicKeyHelperText,
} from './helperText';
import type { Profile } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The whole ABR Uploader form.
 *
 * A separate component for the same reason `AbrPoolForm` is one: it shares
 * almost nothing with a single-node deployment. There is no stamp, because the
 * postage lives on the pool's rungs; no `bee-uploader`, because the pool *is*
 * the publish target; no components picker and no engine choice, because the
 * ladder is SRS-only and the service list is fixed at `srs + stream-uploader`.
 *
 * Expressed as branches inside NewDeploymentDrawer every one of those fields
 * needed a guard, and the mixed form showed BEE_PUBLISHERS next to a Stamp ID
 * that it makes irrelevant — two ways of saying where uploads go, on one screen.
 */
export function AbrUploaderForm({
  onCreated,
  onClose,
  editingProfile,
}: {
  onCreated: (profiles: Profile[]) => void;
  onClose: () => void;
  editingProfile?: Profile | null;
}) {
  const isEdit = !!editingProfile;

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [beePublishers, setBeePublishers] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Keyed on the profile name, not the object: App rebuilds the profile list on
  // every render and on every SSE event, and an object dependency would re-run
  // this mid-keystroke and wipe what is being typed.
  const editingName = editingProfile?.name ?? null;
  useEffect(() => {
    if (!editingProfile) return;
    setName(editingProfile.name);
    setHost(editingProfile.host ?? '');
    setBeePublishers(editingProfile.bee_publishers ?? '');
    setPrivateKey(editingProfile.private_key ?? '');
    setNotes(editingProfile.notes ?? '');
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingName]);

  const nameError =
    name.length > 0 && !NAME_RE.test(name)
      ? 'lowercase letters, digits, dashes (max 31 chars)'
      : null;
  const hostError =
    host.length > 0 && !HOST_RE.test(host)
      ? 'e.g. "localhost", an ssh alias, or "user@host"'
      : null;
  const privateKeyError =
    privateKey.length > 0 && !PRIVATE_KEY_RE.test(privateKey)
      ? 'expected 0x + 64 hex chars'
      : null;
  // Same rules the uploader applies when it starts, so a bad paste fails here
  // rather than as a container that will not come up on the other machine.
  const beePublishersError = beePublishersProblem(beePublishers);
  const notesError = notes.length > 500 ? 'max 500 chars' : null;

  const derivedAddress = (() => {
    if (!PRIVATE_KEY_RE.test(privateKey)) return null;
    try {
      return privateKeyToAccount(privateKey as `0x${string}`).address;
    } catch {
      return null;
    }
  })();

  const canSubmit =
    !submitting &&
    name.length > 0 &&
    beePublishers.trim().length > 0 &&
    privateKey.trim().length > 0 &&
    !nameError &&
    !hostError &&
    !beePublishersError &&
    !privateKeyError &&
    !notesError;

  const validationMessage: string | null = (() => {
    if (submitting) return null;
    if (name.trim().length === 0) return 'Enter a name';
    if (nameError) return `Name: ${nameError}`;
    if (beePublishers.trim().length === 0) {
      return 'Paste BEE_PUBLISHERS from an ABR node pool';
    }
    if (beePublishersError) return `BEE_PUBLISHERS: ${beePublishersError}`;
    if (hostError) return `Host: ${hostError}`;
    if (privateKey.trim().length === 0) {
      return 'A private key is required — it is the uploader’s STREAM_KEY';
    }
    if (privateKeyError) return `Private Key: ${privateKeyError}`;
    if (notesError) return `Notes: ${notesError}`;
    return null;
  })();

  const reset = () => {
    setName('');
    setHost('');
    setBeePublishers('');
    setPrivateKey('');
    setNotes('');
    setSubmitError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const common = {
        kind: 'abr-uploader' as const,
        notes: notes.trim() ? notes.trim() : null,
        bee_publishers: beePublishers.trim(),
        private_key: privateKey.trim() ? privateKey.trim() : undefined,
        public_key: derivedAddress ?? undefined,
      };
      const profile = isEdit
        ? await updateProfile(editingProfile!.name, common)
        : await createProfile({
            ...common,
            name,
            host: host.trim() || 'localhost',
          });
      onCreated([profile]);
      reset();
      onClose();
    } catch (e) {
      setSubmitError(
        getErrorMessage(
          e,
          isEdit ? 'failed to update uploader' : 'failed to create uploader',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoFocus={!isEdit}
        disabled={isEdit}
        error={!!nameError}
        helperText={
          nameError || (isEdit ? 'locked — names are immutable' : 'e.g. stage-gcp')
        }
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
      />

      <TextField
        label="Host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        disabled={isEdit}
        error={!!hostError}
        helperText={hostHelperText(hostError, isEdit)}
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
      />

      <TextField
        label="BEE_PUBLISHERS"
        value={beePublishers}
        onChange={(e) => setBeePublishers(e.target.value)}
        required
        multiline
        minRows={3}
        error={!!beePublishersError}
        helperText={beePublishersHelperText(beePublishersError)}
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
      />

      <RungPreview value={beePublishers} />

      <TextField
        label="Private Key"
        value={privateKey}
        onChange={(e) => setPrivateKey(e.target.value)}
        required
        error={!!privateKeyError}
        helperText={
          privateKeyError ||
          'required — the uploader’s STREAM_KEY, and the owner of its catalog feed'
        }
        slotProps={{
          htmlInput: { style: { fontFamily: 'monospace' } },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label="generate key"
                  onClick={() => setPrivateKey(generatePrivateKey())}
                  title="Generate Ethereum key"
                >
                  <CasinoIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />

      <TextField
        label="Public Key (address)"
        value={derivedAddress ?? ''}
        slotProps={{
          input: { readOnly: true },
          htmlInput: { style: { fontFamily: 'monospace' } },
          inputLabel: { shrink: true },
        }}
        helperText={publicKeyHelperText(derivedAddress)}
      />

      <TextField
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        multiline
        minRows={3}
        error={!!notesError}
        helperText={notesHelperText(notesError, notes.length)}
      />

      <Alert severity="info" variant="outlined">
        Deploys <code>srs</code> + <code>stream-uploader</code> and no Bee node:
        the pool&apos;s rungs are the publish targets and hold the postage, so
        this deployment has no stamp of its own to buy or watch. SRS is encoding
        the ladder, so <code>ABR_ENABLED</code> and <code>ABR_LADDER</code> are
        written for you, matched to the rungs above.
      </Alert>

      {submitError && <Alert severity="error">{submitError}</Alert>}

      {!canSubmit && validationMessage && (
        <Typography variant="caption" sx={{ color: 'warning.main' }}>
          {validationMessage}
        </Typography>
      )}

      <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 1 }}>
        {!isEdit && (
          <Button onClick={reset} disabled={submitting} color="inherit">
            Reset
          </Button>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={16} /> : null}
        >
          {isEdit ? 'Save & Redeploy' : 'Deploy'}
        </Button>
      </Stack>
    </>
  );
}

/**
 * The rungs a valid paste resolves to.
 *
 * BEE_PUBLISHERS is one long line of four URLs and four 64-character batch ids;
 * reading it back to check it is the pool you meant is not realistic. This says
 * what the uploader will do with it.
 */
function RungPreview({ value }: { value: string }) {
  const rungs = sortedPublisherRungs(value);
  if (!rungs) return null;

  return (
    <Alert severity="success" variant="outlined">
      <Typography variant="body2" sx={{ mb: 1 }}>
        {rungs.length} rungs — one Bee node each:
      </Typography>
      <PublisherRungList rungs={rungs} />
    </Alert>
  );
}
