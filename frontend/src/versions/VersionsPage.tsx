import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';

import {
  getErrorMessage,
  type StackVersion,
} from '@streaming-infra-manager/common';

import { useDeployments } from '../app/useDeploymentsStore';
import { useToast } from '../app/ToastProvider';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';

import { AddVersionForm } from './AddVersionForm';
import { BuildLogPane } from './BuildLogPane';
import { VersionCard } from './VersionCard';
import { BuildSlotProvider, useBuildAbort } from './buildSlot';
import {
  removeVersion,
  setDefaultVersion,
  setVersionTested,
  updateVersion,
  type BuildLine,
} from './versionsApi';

const SET_DEFAULT_MEANS =
  'The new deployment wizard preselects this version from now on. Deployments that already exist stay where they are. Only a tested version can be the default.';

/** A build being watched, or the last one until the operator dismisses it. */
interface BuildLog {
  versionName: string;
  lines: BuildLine[];
}

/**
 * The versions of the streaming stack this manager holds.
 *
 * A version is a branch or tag pinned to a commit and built once, so a moving
 * branch changes nothing until Update is pressed. Everything a deployment runs
 * comes out of the chosen version's own checkout, which is why the contract of
 * each version is available alongside its build information.
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
            <Box>
              {versions.map((version) => (
                <VersionCard
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
