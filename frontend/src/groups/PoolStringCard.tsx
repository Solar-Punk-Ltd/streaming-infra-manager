import { Alert, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import type { BeePublishersResult } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import type { DeploymentGroup } from '../types';
import { poolProblems } from './groupReadiness';

/**
 * What a pool exists to produce: the one line an ABR uploader needs to publish
 * to it, and when it cannot be produced, which rung is in the way.
 */
export function PoolStringCard({
  group,
  result,
  loading,
  error,
  onReload,
}: {
  group: DeploymentGroup;
  result: BeePublishersResult | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const { openWizard } = useEditors();
  const problems = poolProblems(result);

  return (
    <SectionCard
      title="Pool string"
      sub="what an ABR uploader needs to publish here"
      actions={
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          disabled={loading}
          onClick={onReload}
        >
          Refresh
        </Button>
      }
    >
      <Stack spacing={1.5}>
        {error && (
          <Alert severity="warning">
            Could not ask the manager to assemble the pool string. {error}
          </Alert>
        )}

        {result?.ready && result.value ? (
          <>
            <CopyBox value={result.value} copyLabel="Copy pool string" />
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              alignItems={{ sm: 'center' }}
            >
              <Button
                variant="contained"
                onClick={() =>
                  openWizard({
                    goal: 'abr-uploader',
                    poolId: group.id,
                    name: `${group.name}-uploader`,
                  })
                }
                sx={{ flex: 'none' }}
              >
                Create an ABR uploader using this pool
              </Button>
              <Typography variant="caption" color="text.secondary">
                For an uploader on another manager, paste the copied string into
                its form.
              </Typography>
            </Stack>
            {result.warnings.length > 0 && (
              <Alert severity="warning">
                Usable, but not everything could be confirmed.{' '}
                {result.warnings
                  .map((note) => `${note.rung}: ${note.reason}`)
                  .join('. ')}
              </Alert>
            )}
          </>
        ) : (
          <Alert severity="warning">
            <strong>Not ready yet.</strong> Every rung needs a running node with
            a usable stamp before this can be copied.
            {problems.length > 0 && ` Holding it up: ${problems.join(', ')}.`}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}
