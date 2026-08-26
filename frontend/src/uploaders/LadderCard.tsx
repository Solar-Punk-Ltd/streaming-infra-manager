import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  DEFAULT_ABR_LADDER,
  getErrorMessage,
  suggestedRungDepth,
} from '@streaming-infra-manager/common';

import { CopyButton } from '../CopyButton';
import { fetchBeePublishers, type BeePublishersResult } from '../data';
import type { DeploymentGroup, Profile } from '../types';
import { UploaderCard } from './UploaderCard';

/** A rung and the profile that publishes it, resolved by UploadersView. */
export interface LadderRung {
  rung: string;
  profile: Profile;
}

/**
 * An ABR ladder: a deployment group with one bee-uploader per quality rung.
 *
 * This card owns the thing the ladder exists to produce — the BEE_PUBLISHERS
 * string — and nests each rung's own uploader card beneath it. A rung is an
 * ordinary bee-uploader profile, so funding and buying a batch use the same
 * component as every other uploader; it only gains the rung's name, its bitrate
 * and its suggested batch depth, which a flat card has no way to know.
 */
export function LadderCard({
  group,
  rungs,
  onChanged,
  srtPassphrase,
}: {
  group: DeploymentGroup;
  /** Ascending by rung. A rung with no member simply has no entry. */
  rungs: LadderRung[];
  onChanged: () => void;
  srtPassphrase: string | null;
}) {
  const [result, setResult] = useState<BeePublishersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupId = group.id;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchBeePublishers(groupId));
    } catch (e) {
      setError(getErrorMessage(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  // Re-assembles when any rung's stamp changes. Without this, buying a batch on
  // a nested rung card would refresh that card while the panel above it kept
  // saying "not ready" until the operator happened to press Refresh.
  const stampFingerprint = rungs
    .map((r) => `${r.rung}:${r.profile.stamp_id ?? ''}`)
    .join('|');

  useEffect(() => {
    void reload();
  }, [reload, stampFingerprint]);

  const stamped = rungs.filter((r) => r.profile.stamp_id).length;
  const total = DEFAULT_ABR_LADDER.length;

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ width: '100%' }}
        >
          <Typography sx={{ fontFamily: 'monospace', flexGrow: 1 }}>
            {group.name}
          </Typography>
          <Chip size="small" variant="outlined" label="ABR ladder" />
          <Chip
            size="small"
            variant="outlined"
            color={stamped === total ? 'success' : 'warning'}
            label={`${stamped}/${total} rungs stamped`}
          />
        </Stack>
      </AccordionSummary>

      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center">
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => void reload()}
              disabled={loading}
            >
              Refresh
            </Button>
          </Stack>

          {error && <Alert severity="warning">{error}</Alert>}
          {!error && <BeePublishersPanel result={result} />}

          <Box>
            <Typography variant="overline" color="text.secondary">
              Rungs
            </Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>
              {rungs.map(({ rung, profile }) => {
                const spec = DEFAULT_ABR_LADDER.find((r) => r.name === rung);
                return (
                  <UploaderCard
                    key={profile.name}
                    profile={profile}
                    onChanged={onChanged}
                    srtPassphrase={srtPassphrase}
                    nested
                    defaultDepth={suggestedRungDepth(rung)}
                    label={
                      <Box component="span">
                        <Box component="span" sx={{ fontWeight: 600 }}>
                          {rung}
                        </Box>
                        <Box
                          component="span"
                          sx={{ ml: 1, color: 'text.secondary', fontSize: 13 }}
                        >
                          {profile.name}
                        </Box>
                      </Box>
                    }
                    badges={
                      <>
                        {spec && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${spec.kbps} kbps`}
                          />
                        )}
                        {rung === DEFAULT_ABR_LADDER[0]?.name && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label="coordinator"
                            title="Carries the stream catalog and the master playlist"
                          />
                        )}
                      </>
                    }
                  />
                );
              })}
            </Stack>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

/**
 * The paste-ready value, or exactly which rungs are holding it up.
 *
 * Never a partial string: the uploader refuses a ladder with a rung missing, so a
 * half-built value would only fail later and less clearly.
 */
function BeePublishersPanel({
  result,
}: {
  result: BeePublishersResult | null;
}) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        BEE_PUBLISHERS
      </Typography>
      {result?.ready && result.value ? (
        <Paper variant="outlined" sx={{ p: 1.5, mt: 1 }}>
          <Stack direction="row" alignItems="flex-start" spacing={1}>
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'monospace',
                wordBreak: 'break-all',
                flexGrow: 1,
              }}
            >
              {result.value}
            </Typography>
            <CopyButton value={result.value} label="BEE_PUBLISHERS" />
          </Stack>
        </Paper>
      ) : (
        <Alert severity="info" sx={{ mt: 1 }}>
          <Typography variant="body2">
            Not ready yet — every rung needs its own postage batch before the
            uploader can be pointed at this ladder.
          </Typography>
          {result?.missing.length ? (
            <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
              {result.missing.map((entry) => (
                <li key={entry.rung}>
                  <Typography variant="body2">
                    <code>{entry.rung}</code> — {entry.reason}
                  </Typography>
                </li>
              ))}
            </Box>
          ) : null}
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary">
        Paste into the stream-uploader&apos;s env alongside{' '}
        <code>ABR_ENABLED=true</code>. The batch is bracketed, not prefixed with{' '}
        <code>#</code> — <code>#</code> starts a comment in a <code>.env</code>{' '}
        file.
      </Typography>
    </Box>
  );
}
