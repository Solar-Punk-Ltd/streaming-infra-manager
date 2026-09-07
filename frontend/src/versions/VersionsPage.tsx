import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  BUNDLED_VERSION_NAME,
  describeStackContract,
  getErrorMessage,
  type StackVersion,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { useDeployments } from '../app/useDeploymentsStore';
import { useToast } from '../app/ToastProvider';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import { ShapePill } from '../components/ShapePill';
import { formatDateTime, shortCommit } from '../format';
import type { Tone } from '../components/tone';

import { AddVersionForm } from './AddVersionForm';
import { BuildLogPane } from './BuildLogPane';
import {
  ANOTHER_BUILDING,
  BuildSlotProvider,
  useBuildAbort,
} from './buildSlot';
import {
  removeVersion,
  setDefaultVersion,
  setVersionTested,
  updateVersion,
  type BuildLine,
} from './versionsApi';

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

const COMMIT_UNKNOWN = 'commit unknown on this host';

/**
 * The bundled version ships inside the manager and is built by its deploy, so
 * it has no build of its own to date.
 */
function builtLabel(version: StackVersion, isBundled: boolean): string {
  if (version.builtAt) return formatDateTime(version.builtAt);
  return isBundled ? 'With the manager' : 'Not yet';
}

const CANNOT_REMOVE = {
  bundled:
    'The bundled version comes with the manager and cannot be removed. Set another version as the default instead.',
  isDefault:
    'This is the default version. Set another version as the default first.',
  inUse: 'Move the deployments running this version first.',
  building: 'This version is building. Wait for it to finish.',
  none: '',
} as const;

const CANNOT_UPDATE_BUNDLED =
  'The bundled version moves when the manager is deployed. Add a version to follow a branch yourself.';

const CANNOT_DEFAULT_UNBUILT =
  'Only a version that finished building can be the default.';

const CANNOT_DEFAULT_UNTESTED =
  'Mark this version as tested first, after one real deployment on it. Reading the scripts proves the shape and not the behaviour.';

const SET_DEFAULT_MEANS =
  'The new deployment wizard preselects this version from now on. Deployments that already exist stay where they are. Only a tested version can be the default.';

const CANNOT_TEST_UNBUILT =
  'Only a version that finished building can be marked as tested. There is no build here to have deployed.';

const CANNOT_TEST_UNKNOWN_COMMIT =
  'The commit this version is at is not known on this host, so there is no build to mark as tested.';

const TESTED_MEANS =
  'Set by hand once one real deployment has run on this version. Reading the scripts proves the shape and not the behaviour. An update that lands on a new commit clears it again, because the approval was for the commit that was deployed.';

/** Why Set as default is refused for this version, or the empty string. */
function defaultBlockedBecause(version: StackVersion): string {
  if (version.status !== 'ready') return CANNOT_DEFAULT_UNBUILT;
  if (!version.tested) return CANNOT_DEFAULT_UNTESTED;
  return '';
}

/** Why Tested cannot be turned on for this version, or the empty string. */
function testedBlockedBecause(version: StackVersion): string {
  if (version.status !== 'ready') return CANNOT_TEST_UNBUILT;
  if (!version.commitSha) return CANNOT_TEST_UNKNOWN_COMMIT;
  return '';
}

/** A build being watched, or the last one until the operator dismisses it. */
interface BuildLog {
  versionName: string;
  lines: BuildLine[];
}

function removalBlockedBecause(
  version: StackVersion,
): keyof typeof CANNOT_REMOVE {
  if (version.name === BUNDLED_VERSION_NAME) return 'bundled';
  if (version.status === 'building') return 'building';
  if (version.isDefault) return 'isDefault';
  if (version.deployments > 0) return 'inUse';
  return 'none';
}

/**
 * The versions of the streaming stack this manager holds.
 *
 * A version is a branch or tag pinned to a commit and built once, so a moving
 * branch changes nothing until Update is pressed. Everything a deployment runs
 * comes out of the chosen version's own checkout, which is why the contract of
 * each is spelled out in the table rather than assumed to be the same.
 */
export function VersionsPage() {
  const { versions, versionsError, reloadVersions } = useDeployments();
  const toast = useToast();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [buildingName, setBuildingName] = useState<string | null>(null);
  const [log, setLog] = useState<BuildLog | null>(null);
  const signalForBuild = useBuildAbort();
  const buildSlot = useMemo(
    () => ({ buildingName, setBuildingName }),
    [buildingName],
  );

  const run = async (
    version: StackVersion,
    done: string,
    action: (id: number) => Promise<unknown>,
  ) => {
    setBusyId(version.id);
    try {
      await action(version.id);
      toast(done, 'success');
    } catch (caught) {
      toast(getErrorMessage(caught), 'error');
    } finally {
      setBusyId(null);
      reloadVersions();
    }
  };

  const rebuild = async (version: StackVersion) => {
    const signal = signalForBuild();
    setBuildingName(version.name);
    setLog({ versionName: version.name, lines: [] });
    try {
      const result = await updateVersion(
        version.id,
        {
          onLine: (line) =>
            setLog((prev) =>
              prev ? { ...prev, lines: [...prev.lines, line] } : prev,
            ),
        },
        signal,
      );
      toast(
        result.code === 0
          ? `${version.name} is built and ready`
          : `${version.name} failed to build. The log says why.`,
        result.code === 0 ? 'success' : 'error',
      );
    } catch (caught) {
      // An aborted build is this page going away, not a failure to report.
      if (!signal.aborted) toast(getErrorMessage(caught), 'error');
    } finally {
      if (!signal.aborted) {
        setBuildingName(null);
        reloadVersions();
      }
    }
  };

  const askSetDefault = (version: StackVersion) =>
    setConfirm({
      title: `Make ${version.name} the default?`,
      body: SET_DEFAULT_MEANS,
      confirmLabel: 'Set as default',
      onConfirm: () =>
        void run(
          version,
          `The wizard now preselects ${version.name}`,
          setDefaultVersion,
        ),
    });

  const askRemove = (version: StackVersion) =>
    setConfirm({
      title: `Remove ${version.name}?`,
      body: 'Its checkout is deleted from this host, about a gigabyte. Nothing that has already been deployed stops, and the version can be added again from the same branch.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () =>
        void run(version, `Removed ${version.name}`, removeVersion),
    });

  return (
    <BuildSlotProvider value={buildSlot}>
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Each version is its own checkout of the streaming stack, built once on
        this host. Deployments keep running the version they were deployed from
        until they are deployed again. Adding a version runs that branch's
        deploy scripts with the manager's Docker access, so only branches you
        trust belong here.
      </Typography>

      <SectionCard
        title="Versions"
        sub="What this manager can deploy from"
        flush
        actions={
          <Button size="small" onClick={reloadVersions}>
            Refresh
          </Button>
        }
      >
        {versionsError && (
          <Alert
            severity="error"
            sx={{ m: 2 }}
            action={
              <Button color="inherit" size="small" onClick={reloadVersions}>
                Try again
              </Button>
            }
          >
            Could not read the versions from the manager. {versionsError}
          </Alert>
        )}

        {!versions && !versionsError && (
          <Stack alignItems="center" sx={{ py: 5 }}>
            <CircularProgress size={24} />
          </Stack>
        )}

        {versions && (
          // The contract sentence needs room, and eight columns do not fit a
          // phone. Scrolling the table sideways keeps every column readable
          // rather than folding them into each other.
          <Box sx={{ overflowX: 'auto' }}>
          <Table sx={{ minWidth: 860 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ minWidth: 260 }}>Version</TableCell>
                <TableCell>Branch or tag</TableCell>
                <TableCell>Commit</TableCell>
                <TableCell>Built</TableCell>
                <TableCell>State</TableCell>
                <TableCell align="right">Deployments</TableCell>
                <TableCell align="center">Tested</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {versions.map((version) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  busy={busyId === version.id || version.name === buildingName}
                  buildingElsewhere={
                    buildingName !== null && buildingName !== version.name
                  }
                  onUpdate={() => void rebuild(version)}
                  onSetDefault={() => askSetDefault(version)}
                  onSetTested={(tested) =>
                    void run(
                      version,
                      tested
                        ? `${version.name} is marked as tested`
                        : `${version.name} is no longer marked as tested`,
                      (id) => setVersionTested(id, tested, version.commitSha),
                    )
                  }
                  onRemove={() => askRemove(version)}
                />
              ))}
            </TableBody>
          </Table>
          </Box>
        )}
      </SectionCard>

      {log && (
        // Kept after the build ends: the reason a build failed is in the last
        // lines of its log, and a pane that vanished the moment the row turned
        // Failed took them with it. Titled after the version whose log this is
        // rather than after whatever is building, because the Add form starts
        // builds of its own and this pane is not showing those.
        <SectionCard
          title={
            buildingName === log.versionName
              ? `Building ${log.versionName}`
              : `Build log, ${log.versionName}`
          }
          actions={
            buildingName === log.versionName ? null : (
              <Button size="small" onClick={() => setLog(null)}>
                Dismiss
              </Button>
            )
          }
        >
          <BuildLogPane
            lines={log.lines}
            running={buildingName === log.versionName}
          />
        </SectionCard>
      )}

      <AddVersionForm onBuilt={reloadVersions} />

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Stack>
    </BuildSlotProvider>
  );
}

function VersionRow({
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
  /** Another version is building, so this row's actions have to wait. */
  buildingElsewhere: boolean;
  onUpdate: () => void;
  onSetDefault: () => void;
  onSetTested: (tested: boolean) => void;
  onRemove: () => void;
}) {
  const isBundled = version.name === BUNDLED_VERSION_NAME;
  const blocked = removalBlockedBecause(version);
  const testBlocked = testedBlockedBecause(version);
  /** Only the approving direction is refused. Withdrawing one always works. */
  const cannotApprove = !version.tested && testBlocked !== '';
  const waiting = buildingElsewhere ? ANOTHER_BUILDING : '';
  const acting = busy || buildingElsewhere;

  return (
    <TableRow hover>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {version.name}
          </Typography>
          {version.isDefault && <ShapePill label="Default" />}
        </Stack>
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
            sx={{ display: 'block', fontFamily: MONO_STACK }}
          >
            {warning}
          </Typography>
        ))}
        {version.status === 'failed' && version.lastError && (
          <Typography
            variant="caption"
            color="error.main"
            sx={{ display: 'block', fontFamily: MONO_STACK }}
          >
            {version.lastError.split('\n').slice(-1)[0]}
          </Typography>
        )}
      </TableCell>
      <TableCell>
        <Typography variant="body2" sx={{ fontFamily: MONO_STACK }}>
          {version.gitRef}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography
          variant="body2"
          color={version.commitSha ? 'text.primary' : 'text.secondary'}
          sx={{ fontFamily: MONO_STACK }}
        >
          {version.commitSha ? shortCommit(version.commitSha) : COMMIT_UNKNOWN}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="body2" color="text.secondary">
          {builtLabel(version, isBundled)}
        </Typography>
      </TableCell>
      <TableCell>
        <ReadinessPill
          label={STATUS_LABELS[version.status]}
          tone={STATUS_TONES[version.status]}
        />
      </TableCell>
      <TableCell align="right">{version.deployments}</TableCell>
      <TableCell align="center">
        <Tooltip title={testBlocked || TESTED_MEANS}>
          <Box component="span">
            <Switch
              size="small"
              checked={version.tested}
              disabled={busy || cannotApprove}
              onChange={(event) => onSetTested(event.target.checked)}
              inputProps={{ 'aria-label': `${version.name} tested` }}
            />
          </Box>
        </Tooltip>
      </TableCell>
      <TableCell align="right">
        <Stack
          direction="row"
          spacing={0.5}
          justifyContent="flex-end"
          flexWrap="wrap"
          useFlexGap
        >
          <Tooltip title={waiting || (isBundled ? CANNOT_UPDATE_BUNDLED : '')}>
            <Box component="span">
              <Button
                size="small"
                disabled={acting || isBundled}
                onClick={onUpdate}
              >
                Update
              </Button>
            </Box>
          </Tooltip>
          <Tooltip title={waiting || defaultBlockedBecause(version)}>
            <Box component="span">
              <Button
                size="small"
                disabled={
                  acting ||
                  version.isDefault ||
                  defaultBlockedBecause(version) !== ''
                }
                onClick={onSetDefault}
              >
                Set as default
              </Button>
            </Box>
          </Tooltip>
          <Tooltip title={waiting || CANNOT_REMOVE[blocked]}>
            <Box component="span">
              <Button
                size="small"
                color="error"
                disabled={acting || blocked !== 'none'}
                onClick={onRemove}
              >
                Remove
              </Button>
            </Box>
          </Tooltip>
        </Stack>
      </TableCell>
    </TableRow>
  );
}
