import type { ReactNode } from 'react';
import {
  Box,
  Button,
  FormControlLabel,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  BUNDLED_VERSION_NAME,
  describeStackContract,
  type StackVersion,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { ReadinessPill } from '../components/ReadinessPill';
import { ShapePill } from '../components/ShapePill';
import type { Tone } from '../components/tone';
import { formatDateTime, shortCommit } from '../format';
import { ANOTHER_BUILDING } from './buildSlot';
import { describeBuild, describePreviousBuild, lostApprovalWarning, updateHint } from './versionText';

const STATUS_LABELS: Record<StackVersion['status'], string> = {
  building: 'Building',
  ready: 'Ready',
  failed: 'Failed',
};
const STATUS_TONES: Record<StackVersion['status'], Tone> = {
  building: 'warn',
  ready: 'ok',
  failed: 'err',
};
const TESTED_MEANS =
  'Set by hand once one real deployment has run on this build. A different build clears approval, even at the same commit. Legacy versions without immutable builds keep approval only while their commit is unchanged.';

function defaultBlockedBecause(version: StackVersion): string {
  if (version.status !== 'ready') {
    return 'Only a version that finished building can be the default.';
  }
  if (!version.tested) {
    return 'Mark this version as tested first, after one real deployment on it. Reading the scripts proves the shape and not the behaviour.';
  }
  return '';
}

function testedBlockedBecause(version: StackVersion): string {
  if (version.status !== 'ready') {
    return 'Only a version that finished building can be marked as tested. There is no build here to have deployed.';
  }
  if (!version.commitSha) {
    return 'The commit this version is at is not known on this host, so there is no build to mark as tested.';
  }
  if (version.layout === 'builds' && !version.buildId) {
    return 'The immutable build identity is missing. Reload after a successful build before marking it as tested.';
  }
  return '';
}

function removalBlockedBecause(version: StackVersion): string {
  if (version.name === BUNDLED_VERSION_NAME) {
    return 'The bundled version comes with the manager and cannot be removed. Set another version as the default instead.';
  }
  if (version.status === 'building') {
    return 'This version is building. Wait for it to finish.';
  }
  if (version.isDefault) {
    return 'This is the default version. Set another version as the default first.';
  }
  if (version.deployments > 0) {
    return 'Move the deployments running this version first.';
  }
  return '';
}

function builtLabel(version: StackVersion): string {
  if (version.builtAt) return formatDateTime(version.builtAt);
  return version.name === BUNDLED_VERSION_NAME ? 'With the manager' : 'Not yet';
}

export function VersionCard({
  version,
  busy,
  buildingElsewhere,
  onUpdate,
  onSetDefault,
  onSetTested,
  onRemove,
}: {
  version: StackVersion;
  busy: boolean;
  buildingElsewhere: boolean;
  onUpdate: () => void;
  onSetDefault: () => void;
  onSetTested: (tested: boolean) => void;
  onRemove: () => void;
}) {
  const testBlocked = testedBlockedBecause(version);
  // Withdrawing approval remains available even when a new build cannot be approved.
  const cannotApprove = !version.tested && testBlocked !== '';
  const waiting = buildingElsewhere ? ANOTHER_BUILDING : '';
  const acting = busy || buildingElsewhere;
  const defaultBlocked = defaultBlockedBecause(version);
  const removalBlocked = removalBlockedBecause(version);
  const previousBuild = describePreviousBuild(version);
  const approvalWarning = lostApprovalWarning(version);
  const headingId = `version-${version.id}-heading`;

  return (
    <Stack
      component="article"
      aria-labelledby={headingId}
      spacing={1.5}
      sx={{
        p: 2.25,
        minWidth: 0,
        overflowWrap: 'anywhere',
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-child': { borderBottom: 0 },
      }}
    >
      <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap spacing={1}>
        <Typography
          id={headingId}
          component="h4"
          variant="subtitle2"
          sx={{ minWidth: 0 }}
        >
          {version.name}
        </Typography>
        <ReadinessPill
          label={STATUS_LABELS[version.status]}
          tone={STATUS_TONES[version.status]}
        />
        {version.isDefault && <ShapePill label="Default" />}
      </Stack>

      {approvalWarning && (
        <Typography variant="body2" color="warning.main" component="p">
          {approvalWarning}
        </Typography>
      )}

      <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap spacing={2}>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontFamily: MONO_STACK }}
        >
          {version.commitSha
            ? `Commit ${shortCommit(version.commitSha)}`
            : 'Commit unknown on this host'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {version.deployments} {version.deployments === 1 ? 'deployment' : 'deployments'}
        </Typography>
        <Tooltip title={testBlocked || TESTED_MEANS}>
          <Box component="span">
            <FormControlLabel
              sx={{ m: 0 }}
              label={
                <Typography variant="body2">
                  {version.tested ? 'Tested' : 'Not tested'}
                </Typography>
              }
              control={
                <Switch
                  size="small"
                  checked={version.tested}
                  disabled={busy || cannotApprove}
                  onChange={(event) => onSetTested(event.target.checked)}
                  inputProps={{ 'aria-label': `${version.name} tested` }}
                />
              }
            />
          </Box>
        </Tooltip>
      </Stack>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Tooltip title={waiting || updateHint(version)}>
          <Box component="span">
            <Button
              size="small"
              variant="outlined"
              disabled={acting}
              onClick={onUpdate}
            >
              Update
            </Button>
          </Box>
        </Tooltip>
        <Tooltip title={waiting || defaultBlocked}>
          <Box component="span">
            <Button
              size="small"
              variant="outlined"
              disabled={acting || version.isDefault || defaultBlocked !== ''}
              onClick={onSetDefault}
            >
              Set as default
            </Button>
          </Box>
        </Tooltip>
        <Tooltip title={waiting || removalBlocked}>
          <Box component="span">
            <Button
              size="small"
              color="error"
              disabled={acting || removalBlocked !== ''}
              onClick={onRemove}
            >
              Remove
            </Button>
          </Box>
        </Tooltip>
      </Stack>

      <Box
        component="dl"
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'minmax(0, 1fr)',
            sm: 'repeat(2, minmax(0, 1fr))',
          },
          gap: 1.5,
          m: 0,
        }}
      >
        <VersionFact label="Branch or tag">{version.gitRef}</VersionFact>
        <VersionFact label="Built">
          {builtLabel(version)}
          <Typography
            component="span"
            variant="caption"
            sx={{ display: 'block', fontFamily: MONO_STACK }}
          >
            {describeBuild(version)}
            {previousBuild ? `, ${previousBuild}` : ''}
          </Typography>
        </VersionFact>
      </Box>

      {version.lastError &&
        (version.status === 'failed' || version.status === 'ready') && (
          <Typography
            variant="caption"
            color={version.status === 'failed' ? 'error.main' : 'warning.main'}
            sx={{ fontFamily: MONO_STACK }}
          >
            {version.lastError.split('\n').slice(-1)[0]}
          </Typography>
        )}

      <Box component="details">
        <Box
          component="summary"
          sx={{
            cursor: 'pointer',
            color: 'text.secondary',
            typography: 'body2',
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 3,
              borderRadius: 0.5,
            },
          }}
        >
          Contract details
          {version.contract?.warnings.length
            ? ` (${version.contract.warnings.length} ${version.contract.warnings.length === 1 ? 'warning' : 'warnings'})`
            : ''}
        </Box>
        <Stack spacing={0.75} sx={{ pt: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {version.contract
              ? describeStackContract(version.contract)
              : 'The contract is read from the checkout once the build finishes.'}
          </Typography>
          {version.contract?.warnings.map((warning) => (
            <Typography
              key={warning}
              variant="caption"
              color="warning.main"
              sx={{ fontFamily: MONO_STACK }}
            >
              {warning}
            </Typography>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

function VersionFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography component="dt" variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0 }}>
        {children}
      </Typography>
    </Box>
  );
}
