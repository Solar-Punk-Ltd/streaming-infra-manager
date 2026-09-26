import { useEffect, useRef, useState } from 'react';
import { Alert, Button, CircularProgress, Stack, Typography } from '@mui/material';

import { type AdminLinkTestAnswer, type AdminLinkTestOutcome, getErrorMessage } from '@streaming-infra-manager/common';

import { ADMIN_LINK_TEST_REACH, adminLinkTestSeverity, adminLinkTestText } from './adminLinkText';

type TestResult = { kind: 'outcome'; outcome: AdminLinkTestOutcome } | { kind: 'failed'; message: string };

/**
 * Test connection: a button that asks the manager to try the web2 admin link,
 * the one line saying where the test runs from, and the sentence for the
 * outcome. A result that no longer answers for what is on screen is cleared,
 * and one that arrives after that is dropped.
 */
export function AdminLinkTest({
  run,
  blockedReason,
  resetKey,
  note,
}: {
  /** Asks the manager and answers the outcome, or null while there is nothing to test. */
  run: (() => Promise<AdminLinkTestAnswer>) | null;
  /** What has to happen first, said beside the button while it is off. */
  blockedReason?: string | null;
  /** Anything whose change makes a shown result stale, such as a count of edits. */
  resetKey: string | number;
  /** A line of its own for this place, said under the one on where the test runs. */
  note?: string | null;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    asked.current += 1;
    setResult(null);
    setTesting(false);
  }, [resetKey]);

  const test = async () => {
    if (!run) return;
    const request = ++asked.current;
    setTesting(true);
    setResult(null);
    try {
      const { outcome } = await run();
      if (request === asked.current) setResult({ kind: 'outcome', outcome });
    } catch (caught) {
      if (request === asked.current) setResult({ kind: 'failed', message: getErrorMessage(caught, 'The test could not be run.') });
    } finally {
      if (request === asked.current) setTesting(false);
    }
  };

  return (
    <Stack spacing={1} data-admin-link-test sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button
          size="small"
          variant="outlined"
          disabled={run === null || testing}
          onClick={() => void test()}
          startIcon={testing ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {testing ? 'Testing' : 'Test connection'}
        </Button>
        {run === null && blockedReason && (
          <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 12rem', overflowWrap: 'anywhere' }}>
            {blockedReason}
          </Typography>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {ADMIN_LINK_TEST_REACH}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {note}
        </Typography>
      )}
      <div role="status" aria-live="polite">
        {result?.kind === 'outcome' && (
          <Alert severity={adminLinkTestSeverity(result.outcome)} sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
            {adminLinkTestText(result.outcome)}
          </Alert>
        )}
        {result?.kind === 'failed' && (
          <Alert severity="error" sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
            {result.message}
          </Alert>
        )}
      </div>
    </Stack>
  );
}
