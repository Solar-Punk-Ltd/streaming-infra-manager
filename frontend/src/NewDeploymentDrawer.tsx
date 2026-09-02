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
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CasinoIcon from '@mui/icons-material/Casino';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  ABR_UPLOADER_KIND,
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  beeUrlProblem,
  CLIENT_SERVICE,
  type EngineName,
  ENGINE_SERVICES,
  getErrorMessage,
  isLadderKind,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { AbrPoolForm } from './AbrPoolForm';
import { AbrUploaderForm } from './AbrUploaderForm';

import {
  addGroupMembers,
  createDeploymentGroup,
  createProfile,
  updateGroupConfig,
  updateProfile,
} from './data';
import {
  beeUrlHelperText,
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
import type { DeploymentGroup, Profile, ProfileKind } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const FEED_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const ALL_COMPONENTS = [
  SRS_SERVICE,
  OME_SERVICE,
  STREAM_UPLOADER_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  BEE_GATEWAY_SERVICE,
] as const;
type Component = (typeof ALL_COMPONENTS)[number];

type Engine = EngineName;

const isEngine = (c: string): c is Engine =>
  (ENGINE_SERVICES as readonly string[]).includes(c);

const CHECKBOX_COMPONENTS = ALL_COMPONENTS.filter((c) => !isEngine(c));

type EngineChoice = Engine | 'none';

const KIND_DEFAULTS: Record<ProfileKind, Component[]> = {
  streamer: [SRS_SERVICE, STREAM_UPLOADER_SERVICE, BEE_UPLOADER_SERVICE],
  // Reached only when editing one; an ABR uploader is created from its own form.
  [ABR_UPLOADER_KIND]: [SRS_SERVICE, STREAM_UPLOADER_SERVICE],
  viewer: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
  custom: ALL_COMPONENTS.filter((c) => c !== OME_SERVICE),
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

interface GroupSelection {
  group: DeploymentGroup;
  members: Profile[];
}

/**
 * What is being deployed.
 *
 * A single value rather than the old pair of booleans (`groupMode` +
 * `ladderMode`), which could express a state that meant nothing — a ladder that
 * was not a group — and left every irrelevant field needing its own guard.
 * "Deploy as group" now belongs to the streaming-infra branch only.
 */
type DeploymentType = 'streaming-infra' | 'abr-uploader' | 'abr-node-pool';

const DEPLOYMENT_TYPES: { value: DeploymentType; label: string }[] = [
  { value: 'abr-node-pool', label: 'ABR Node Pool' },
  { value: 'abr-uploader', label: 'ABR Uploader' },
  { value: 'streaming-infra', label: 'Streaming Infra' },
];

const DEPLOYMENT_TYPE_HINT: Record<DeploymentType, string> = {
  'abr-node-pool': 'one Bee node per ABR quality rung, as publish targets',
  'abr-uploader':
    'srs + stream-uploader publishing to an ABR node pool — no Bee node, no stamp',
  'streaming-infra': 'streamer, viewer or custom deployments',
};

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (profiles: Profile[]) => void;
  selectedProfile?: Profile | null;
  selectedGroup?: GroupSelection | null;
}

export function NewDeploymentDrawer({
  open,
  onClose,
  onCreated,
  selectedProfile,
  selectedGroup,
}: Props) {
  const isGroupEdit = !!selectedGroup;
  const isProfileEdit = !!selectedProfile;
  const isEdit = isProfileEdit || isGroupEdit;
  const editingPool = isLadderKind(selectedGroup?.group.kind);
  const [deploymentType, setDeploymentType] =
    useState<DeploymentType>('streaming-infra');
  const [groupMode, setGroupMode] = useState(false);
  const [groupSize, setGroupSize] = useState(2);
  const editingAbrUploader = selectedProfile?.kind === ABR_UPLOADER_KIND;
  // Both of these render their own self-contained form; nothing below applies.
  const isPoolForm = editingPool || (!isEdit && deploymentType === 'abr-node-pool');
  const isAbrUploaderForm =
    editingAbrUploader || (!isEdit && deploymentType === 'abr-uploader');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProfileKind>('viewer');
  const [components, setComponents] = useState<Component[]>(
    KIND_DEFAULTS.viewer,
  );
  const [host, setHost] = useState('');
  const [feedOwner, setFeedOwner] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [stampId, setStampId] = useState('');
  const [beeUrl, setBeeUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [addCount, setAddCount] = useState(1);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const prefillForGroupEdit = () => {
      const source = selectedProfile ?? selectedGroup?.members[0] ?? null;
      if (source) {
        setName(selectedGroup ? selectedGroup.group.name : source.name);
        setKind(source.kind);
        setComponents(
          source.components && source.components.length > 0
            ? (source.components as Component[])
            : KIND_DEFAULTS[source.kind],
        );
        setHost(source.host ?? '');
        setFeedOwner(source.feed_owner ?? '');
        setPrivateKey(selectedGroup ? '' : (source.private_key ?? ''));
        setStampId(selectedGroup ? '' : (source.stamp_id ?? ''));
        setBeeUrl(selectedGroup ? '' : (source.bee_url ?? ''));
        setNotes(source.notes ?? '');
        setSubmitError(null);
      }
    };

    prefillForGroupEdit();
  }, [open, selectedProfile, selectedGroup]);

  const isCustom = kind === 'custom';
  const hasComponent = (c: Component) => components.includes(c);
  const hasClient = hasComponent(CLIENT_SERVICE);
  const hasStreamUploader = hasComponent(STREAM_UPLOADER_SERVICE);

  const onKindChange = (next: ProfileKind) => {
    setKind(next);
    setComponents(KIND_DEFAULTS[next]);
  };

  const toggleComponent = (c: Component) => {
    setComponents((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const selectedEngine: EngineChoice =
    (components.find(isEngine) as Engine | undefined) ?? 'none';

  const onEngineChange = (next: EngineChoice) => {
    setComponents((prev) => {
      const withoutEngines = prev.filter((c) => !isEngine(c));
      return next === 'none' ? withoutEngines : [...withoutEngines, next];
    });
  };

  const engineDisabled = isEdit || kind === 'viewer';

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
  // deploy.sh resolves BEE_URL itself whenever a local bee-uploader is enabled,
  // so an explicit value only means anything without one. Locked rather than
  // silently ignored.
  const hasLocalBeeNode = hasComponent(BEE_UPLOADER_SERVICE);
  const beeUrlError =
    hasStreamUploader && !hasLocalBeeNode ? beeUrlProblem(beeUrl) : null;
  const componentsError =
    components.length === 0 ? 'select at least one component' : null;
  const notesError = notes.length > 500 ? 'max 500 chars' : null;
  const groupSizeError =
    groupMode && (!Number.isInteger(groupSize) || groupSize < 1)
      ? 'must be a positive integer'
      : null;

  const canSubmit =
    !submitting &&
    !adding &&
    name.length > 0 &&
    !nameError &&
    !hostError &&
    !feedOwnerError &&
    !clientFieldsMissing &&
    !privateKeyError &&
    !stampIdError &&
    !beeUrlError &&
    !componentsError &&
    !notesError &&
    !groupSizeError;

  const validationErrorMessage: string | null = (() => {
    if (submitting) return null;
    if (adding) return 'Adding members…';
    if (name.trim().length === 0)
      return `Enter a ${isGroupEdit || groupMode ? 'group name' : 'name'}`;
    if (nameError) return `Name: ${nameError}`;
    if (groupSizeError) return `Size: ${groupSizeError}`;
    if (componentsError) return componentsError;
    if (clientFieldsMissing) return 'Feed Owner Public Key is required';
    if (feedOwnerError) return `Feed Owner: ${feedOwnerError}`;
    if (hostError) return `Host: ${hostError}`;
    if (privateKeyError) return `Private Key: ${privateKeyError}`;
    if (stampIdError) return `Stamp ID: ${stampIdError}`;
    if (beeUrlError) return `BEE_URL: ${beeUrlError}`;
    if (notesError) return `Notes: ${notesError}`;
    return null;
  })();

  const reset = () => {
    setName('');
    setKind('viewer');
    setComponents(KIND_DEFAULTS.viewer);
    setHost('');
    setFeedOwner('');
    setPrivateKey('');
    setStampId('');
    setBeeUrl('');
    setNotes('');
    setDeploymentType('streaming-infra');
    setGroupMode(false);
    setGroupSize(2);
    setAddCount(1);
    setSubmitError(null);
  };

  const handleClose = () => {
    if (submitting || adding) return;
    reset();
    onClose();
  };

  const handleAddMembers = async () => {
    if (!selectedGroup) return;
    setAdding(true);
    setSubmitError(null);
    try {
      const result = await addGroupMembers(selectedGroup.group.id, addCount);
      onCreated(result.profiles);
      reset();
      onClose();
    } catch (e) {
      setSubmitError(getErrorMessage(e, 'failed to add members'));
    } finally {
      setAdding(false);
    }
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
      if (isGroupEdit) {
        // Group edit intentionally touches only the shared feed target + notes.
        // Per-node identity (keys) and stamps are not bulk-applied.
        const result = await updateGroupConfig(selectedGroup!.group.id, {
          notes: common.notes,
          feed_owner: common.feed_owner,
        });
        onCreated(result.profiles);
        reset();
        onClose();
      } else if (!isEdit && groupMode) {
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
        // Sent as null when empty so an edit can drop an external node again;
        // undefined would mean "leave it as it is".
        const bee_url =
          hasStreamUploader && !hasLocalBeeNode && beeUrl.trim()
            ? beeUrl.trim()
            : null;
        const profile = isProfileEdit
          ? await updateProfile(selectedProfile!.name, { ...common, bee_url })
          : await createProfile({
              ...common,
              bee_url,
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
          isGroupEdit
            ? 'failed to update group'
            : isEdit
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
            {isGroupEdit
              ? `Modify group ${selectedGroup!.group.name}`
              : isProfileEdit
                ? `Modify ${selectedProfile!.name}`
                : 'New deployment'}
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
          <TextField
            label="Deployment type"
            select
            value={
              editingPool
                ? 'abr-node-pool'
                : editingAbrUploader
                  ? 'abr-uploader'
                  : deploymentType
            }
            onChange={(e) =>
              setDeploymentType(e.target.value as DeploymentType)
            }
            // Immutable once created, like kind: the two types have different
            // members, ports and lifecycles.
            disabled={isEdit}
            helperText={
              isEdit
                ? 'locked — a deployment cannot change type'
                : DEPLOYMENT_TYPE_HINT[deploymentType]
            }
          >
            {DEPLOYMENT_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>

          {isPoolForm ? (
            <AbrPoolForm
              onCreated={onCreated}
              onClose={handleClose}
              editingGroup={editingPool ? selectedGroup : null}
            />
          ) : isAbrUploaderForm ? (
            <AbrUploaderForm
              onCreated={onCreated}
              onClose={handleClose}
              editingProfile={editingAbrUploader ? selectedProfile : null}
            />
          ) : (
            <>
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
            label={isGroupEdit || groupMode ? 'Group name' : 'Name'}
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

          {isGroupEdit && (
            <FormControl component="fieldset">
              <FormLabel component="legend">Members</FormLabel>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  label="Add"
                  type="number"
                  size="small"
                  value={addCount}
                  onChange={(e) =>
                    setAddCount(Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                  slotProps={{ htmlInput: { min: 1, step: 1 } }}
                  sx={{ width: 96 }}
                />
                <Button
                  variant="outlined"
                  startIcon={
                    adding ? <CircularProgress size={16} /> : <GroupAddIcon />
                  }
                  onClick={handleAddMembers}
                  disabled={submitting || adding || addCount < 1}
                >
                  Add members
                </Button>
              </Stack>
              <FormHelperText>
                {selectedGroup!.members.length} current — new members inherit
                this group&apos;s config (deploy with Start).
              </FormHelperText>
            </FormControl>
          )}

          <FormControl
            component="fieldset"
            error={!!componentsError}
            disabled={isEdit || !isCustom}
          >
            <FormLabel component="legend">Components</FormLabel>
            <FormGroup>
              {CHECKBOX_COMPONENTS.map((c) => (
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

          <FormControl component="fieldset" disabled={engineDisabled}>
            <FormLabel component="legend">Media engine</FormLabel>
            <RadioGroup
              value={selectedEngine}
              onChange={(e) => onEngineChange(e.target.value as EngineChoice)}
            >
              {([SRS_SERVICE, OME_SERVICE, 'none'] as const).map((engine) => (
                <FormControlLabel
                  key={engine}
                  value={engine}
                  control={<Radio size="small" />}
                  label={
                    <Typography
                      sx={{ fontFamily: 'monospace' }}
                      variant="body2"
                    >
                      {engine}
                    </Typography>
                  }
                />
              ))}
            </RadioGroup>
            <FormHelperText>
              {isEdit
                ? 'locked — engine cannot change after first deploy'
                : kind === 'viewer'
                  ? 'viewers run no media engine'
                  : 'srs is the default; ome runs OvenMediaEngine'}
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

          {hasStreamUploader && !isGroupEdit && (
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
                label="Bee API URL"
                value={beeUrl}
                onChange={(e) => setBeeUrl(e.target.value)}
                disabled={hasLocalBeeNode}
                error={!!beeUrlError}
                helperText={beeUrlHelperText(beeUrlError, hasLocalBeeNode)}
                slotProps={{
                  htmlInput: { style: { fontFamily: 'monospace' } },
                }}
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

              <Alert severity="info" variant="outlined">
                Stamp is optional — deploy now and add it later. Without one the{' '}
                <code>stream-uploader</code> is held back (&ldquo;Stamp
                required&rdquo;) while the rest of the stack runs. Provide a
                stamp, then use <strong>Deploy uploader</strong>.
              </Alert>
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

          {!canSubmit && validationErrorMessage && (
            <Typography variant="caption" sx={{ color: 'warning.main' }}>
              {validationErrorMessage}
            </Typography>
          )}

          <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 1 }}>
            {!isEdit && (
              <Button onClick={reset} disabled={submitting} color="inherit">
                Reset
              </Button>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <Button onClick={handleClose} disabled={submitting || adding}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleSubmit}
              disabled={!canSubmit}
              startIcon={submitting ? <CircularProgress size={16} /> : null}
            >
              {isGroupEdit
                ? 'Save & Redeploy group'
                : isProfileEdit
                  ? 'Save & Redeploy'
                  : groupMode
                    ? `Deploy group (${groupSize})`
                    : 'Deploy'}
            </Button>
          </Stack>
            </>
          )}
        </Stack>
      </Box>
    </Drawer>
  );
}
