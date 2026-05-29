import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Drawer,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CasinoIcon from '@mui/icons-material/Casino';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { createDeploymentGroup, createProfile, updateProfile } from './data';
import {
  componentsHelperText,
  feedOwnerHelperText,
  groupSizeHelperText,
  hostHelperText,
  kindHelperText,
  nameHelperText,
  notesHelperText,
  privateKeyHelperText,
  publicKeyHelperText,
  stampIdHelperText,
} from './helperText';
import type { Profile, ProfileKind } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const FEED_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const ALL_COMPONENTS = [
  'srs',
  'stream-uploader',
  'bee-uploader',
  'client',
  'bee-gateway',
] as const;
type Component = (typeof ALL_COMPONENTS)[number];

const KIND_DEFAULTS: Record<ProfileKind, Component[]> = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  viewer: ['client', 'bee-gateway'],
  custom: [...ALL_COMPONENTS],
};

const KINDS: { value: ProfileKind; label: string; hint: string }[] = [
  {
    value: 'streamer',
    label: 'streamer',
    hint: 'srs + stream-uploader + bee-uploader',
  },
  { value: 'viewer', label: 'viewer', hint: 'client + bee-gateway' },
  { value: 'custom', label: 'custom', hint: 'pick any combination' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (profiles: Profile[]) => void;
  selectedProfile?: Profile | null;
}

export function NewDeploymentDrawer({
  open,
  onClose,
  onCreated,
  selectedProfile,
}: Props) {
  const isEdit = !!selectedProfile;
  const [groupMode, setGroupMode] = useState(false);
  const [groupSize, setGroupSize] = useState(2);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProfileKind>('viewer');
  const [components, setComponents] = useState<Component[]>(
    KIND_DEFAULTS.viewer,
  );
  const [host, setHost] = useState('');
  const [feedOwner, setFeedOwner] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [stampId, setStampId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (selectedProfile) {
      setName(selectedProfile.name);
      setKind(selectedProfile.kind);
      setComponents(
        selectedProfile.components && selectedProfile.components.length > 0
          ? (selectedProfile.components as Component[])
          : KIND_DEFAULTS[selectedProfile.kind],
      );
      setHost(selectedProfile.host ?? '');
      setFeedOwner(selectedProfile.feed_owner ?? '');
      setPrivateKey(selectedProfile.private_key ?? '');
      setStampId(selectedProfile.stamp_id ?? '');
      setNotes(selectedProfile.notes ?? '');
      setSubmitError(null);
    }
  }, [open, selectedProfile]);

  const isCustom = kind === 'custom';
  const hasComponent = (c: Component) => components.includes(c);
  const hasClient = hasComponent('client');
  const hasStreamUploader = hasComponent('stream-uploader');

  const onKindChange = (next: ProfileKind) => {
    setKind(next);
    setComponents(KIND_DEFAULTS[next]);
  };

  const toggleComponent = (c: Component) => {
    setComponents((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const derivedAddress = (() => {
    if (!hasStreamUploader || !PRIVATE_KEY_RE.test(privateKey)) return null;
    try {
      return privateKeyToAccount(privateKey as `0x${string}`).address;
    } catch {
      return null;
    }
  })();

  const nameError =
    name.length > 0 && !NAME_RE.test(name)
      ? 'lowercase letters, digits, dashes (max 31 chars)'
      : null;
  const hostError =
    host.length > 0 && !HOST_RE.test(host)
      ? 'e.g. "localhost", an ssh alias, or "user@host"'
      : null;
  const feedOwnerError =
    hasClient && feedOwner.length > 0 && !FEED_OWNER_RE.test(feedOwner)
      ? 'expected 0x + 40 hex chars (Ethereum address)'
      : null;
  const clientFieldsMissing = hasClient && feedOwner.trim().length === 0;
  const privateKeyError =
    hasStreamUploader &&
    privateKey.length > 0 &&
    !PRIVATE_KEY_RE.test(privateKey)
      ? 'expected 0x + 64 hex chars'
      : null;
  const stampIdError =
    hasStreamUploader && stampId.length > 0 && !STAMP_ID_RE.test(stampId)
      ? 'expected 32-byte hex (64 chars, optionally 0x-prefixed)'
      : null;
  const componentsError =
    components.length === 0 ? 'select at least one component' : null;
  const notesError = notes.length > 500 ? 'max 500 chars' : null;
  const groupSizeError =
    groupMode && (!Number.isInteger(groupSize) || groupSize < 1)
      ? 'must be a positive integer'
      : null;

  const canSubmit =
    !submitting &&
    name.length > 0 &&
    !nameError &&
    !hostError &&
    !feedOwnerError &&
    !clientFieldsMissing &&
    !privateKeyError &&
    !stampIdError &&
    !componentsError &&
    !notesError &&
    !groupSizeError;

  const reset = () => {
    setName('');
    setKind('viewer');
    setComponents(KIND_DEFAULTS.viewer);
    setHost('');
    setFeedOwner('');
    setPrivateKey('');
    setStampId('');
    setNotes('');
    setGroupMode(false);
    setGroupSize(2);
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
        kind,
        notes: notes.trim() ? notes.trim() : null,
        components,
        feed_owner:
          hasClient && feedOwner.trim() ? feedOwner.trim() : undefined,
        private_key:
          hasStreamUploader && privateKey.trim()
            ? privateKey.trim()
            : undefined,
        public_key:
          hasStreamUploader && derivedAddress ? derivedAddress : undefined,
        stamp_id:
          hasStreamUploader && stampId.trim() ? stampId.trim() : undefined,
      };
      if (!isEdit && groupMode) {
        const result = await createDeploymentGroup({
          ...common,
          group_name: name,
          size: groupSize,
          host: host.trim() || 'localhost',
        });

        onCreated(result.profiles);
        reset();
        onClose();
      } else {
        const profile = isEdit
          ? await updateProfile(selectedProfile!.name, common)
          : await createProfile({
              ...common,
              name,
              host: host.trim() || 'localhost',
            });
        onCreated([profile]);
        reset();
        onClose();
      }
    } catch (e) {
      setSubmitError(
        getErrorMessage(
          e,
          isEdit
            ? 'failed to update deployment'
            : 'failed to create deployment',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer anchor="right" open={open} onClose={handleClose}>
      <Box sx={{ width: { xs: '100vw', sm: 420 }, p: 3 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {isEdit ? `Modify ${selectedProfile!.name}` : 'New deployment'}
          </Typography>
          <IconButton
            onClick={handleClose}
            disabled={submitting}
            aria-label="close"
          >
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack spacing={2}>
          {!isEdit && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={groupMode}
                  onChange={(e) => setGroupMode(e.target.checked)}
                  size="small"
                />
              }
              label="Deploy as group"
            />
          )}

          <TextField
            label={groupMode ? 'Group name' : 'Name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus={!isEdit}
            disabled={isEdit}
            error={!!nameError}
            helperText={nameHelperText(nameError, isEdit, groupMode)}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />

          {!isEdit && groupMode && (
            <TextField
              label="Size"
              type="number"
              value={groupSize}
              onChange={(e) => setGroupSize(parseInt(e.target.value, 10) || 0)}
              error={!!groupSizeError}
              helperText={groupSizeHelperText(groupSizeError, groupSize)}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
          )}

          <TextField
            label="Kind"
            select
            value={kind}
            onChange={(e) => onKindChange(e.target.value as ProfileKind)}
            disabled={isEdit}
            helperText={kindHelperText(
              isEdit,
              KINDS.find((k) => k.value === kind)?.hint,
            )}
          >
            {KINDS.map((k) => (
              <MenuItem key={k.value} value={k.value}>
                {k.label}
              </MenuItem>
            ))}
          </TextField>

          <FormControl
            component="fieldset"
            error={!!componentsError}
            disabled={isEdit || !isCustom}
          >
            <FormLabel component="legend">Components</FormLabel>
            <FormGroup>
              {ALL_COMPONENTS.map((c) => (
                <FormControlLabel
                  key={c}
                  control={
                    <Checkbox
                      checked={hasComponent(c)}
                      onChange={() => toggleComponent(c)}
                      size="small"
                    />
                  }
                  label={
                    <Typography
                      sx={{ fontFamily: 'monospace' }}
                      variant="body2"
                    >
                      {c}
                    </Typography>
                  }
                />
              ))}
            </FormGroup>
            <FormHelperText>
              {componentsHelperText(componentsError, isEdit, isCustom)}
            </FormHelperText>
          </FormControl>

          <TextField
            label="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={isEdit}
            error={!!hostError}
            helperText={hostHelperText(hostError, isEdit)}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />

          {hasStreamUploader && (
            <>
              <TextField
                label="Private Key"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                error={!!privateKeyError}
                helperText={privateKeyHelperText(privateKeyError)}
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
                label="Stamp ID"
                value={stampId}
                onChange={(e) => setStampId(e.target.value)}
                error={!!stampIdError}
                helperText={stampIdHelperText(stampIdError)}
                slotProps={{
                  htmlInput: { style: { fontFamily: 'monospace' } },
                }}
              />
            </>
          )}

          {hasClient && (
            <TextField
              label="Feed Owner Public Key"
              value={feedOwner}
              onChange={(e) => setFeedOwner(e.target.value)}
              required
              error={!!feedOwnerError}
              helperText={feedOwnerHelperText(feedOwnerError)}
              slotProps={{
                htmlInput: { style: { fontFamily: 'monospace' } },
              }}
            />
          )}

          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={3}
            error={!!notesError}
            helperText={notesHelperText(notesError, notes.length)}
          />

          {submitError && <Alert severity="error">{submitError}</Alert>}

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
              {isEdit
                ? 'Save & Redeploy'
                : groupMode
                  ? `Deploy group (${groupSize})`
                  : 'Deploy'}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Drawer>
  );
}
