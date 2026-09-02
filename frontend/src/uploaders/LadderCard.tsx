import { useCallback, useEffect, useRef, useState } from 'react';
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
  isDeadStampState,
  isInvalidUrlState,
  PUBLISHABLE_RUNG_STATUS,
  type PublishUrlState,
  type StampState,
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

  // Two of these can be in flight at once — each rung auto-stamping publishes its
  // own `profile.changed`, so the fingerprint below can change twice in seconds —
  // and they can finish out of order. Without a sequence number the older answer
  // lands last and pins the panel to a readiness state that is already wrong.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBeePublishers(groupId);
      if (seq !== latest.current) return;
      setResult(next);
      setError(null);
    } catch (e) {
      if (seq !== latest.current) return;
      setError(getErrorMessage(e));
      setResult(null);
    } finally {
      if (seq === latest.current) setLoading(false);
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

  const total = DEFAULT_ABR_LADDER.length;
  const summary = summariseRungs(result, rungs);

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
          <Chip size="small" variant="outlined" label="ABR node pool" />
          <Chip
            size="small"
            variant="outlined"
            color={summary.color}
            label={`${summary.stamped}/${total} rungs stamped`}
            title={summary.title}
          />
          {summary.problem && (
            <Chip size="small" color="error" label={summary.problem} />
          )}
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
          {!error && (
            <BeePublishersPanel result={result} summary={summary} />
          )}

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
  summary,
}: {
  result: BeePublishersResult | null;
  summary: RungSummary;
}) {
  const broken =
    summary.dead > 0 || summary.notRunning > 0 || summary.badAddress > 0;
  const warnings = result?.warnings ?? [];
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
          {warnings.length > 0 && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              <Typography variant="body2">
                Usable, but not everything could be confirmed:
              </Typography>
              <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
                {warnings.map((entry, index) => (
                  <li key={`${entry.rung}-${index}`}>
                    <Typography variant="body2">
                      <code>{entry.rung}</code> — {entry.reason}
                    </Typography>
                  </li>
                ))}
              </Box>
            </Alert>
          )}
        </Paper>
      ) : (
        <Alert severity={broken ? 'error' : 'info'} sx={{ mt: 1 }}>
          <Typography variant="body2">
            {broken
              ? 'Not usable as it stands — a rung cannot accept an upload, so anything already pointed at this ladder is failing on that rung. Each is named below.'
              : 'Not ready yet — every rung needs its own postage batch before the uploader can be pointed at this ladder.'}
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

interface RungSummary {
  /** Rungs holding a batch we have no reason to doubt. */
  stamped: number;
  /** Rungs whose batch has expired, or which their node has dropped. */
  dead: number;
  /** Rungs holding a batch whose node could not be asked. */
  unverified: number;
  /** Rungs whose node is not running, so nothing is listening at its address. */
  notRunning: number;
  /** Rungs whose address cannot work, whatever is listening. */
  badAddress: number;
  color: 'success' | 'warning' | 'error' | 'default';
  title: string | undefined;
  /**
   * The single most urgent thing wrong with the ladder, for the header chip, in
   * the same order the operator has to fix them: a stopped node makes its batch
   * moot, and an unusable address makes both moot.
   */
  problem: string | null;
}

/**
 * What the ladder header says about its four batches.
 *
 * Counted from the *verified* state the manager reports, not from the recorded
 * ids: a `stamp_id` outlives the batch it names, which is how a ladder whose
 * every batch had expired a week earlier still showed 4/4 in green with an empty
 * stamp table under each rung.
 *
 * Until that answer arrives the recorded ids are all there is, so they are shown
 * uncoloured — neither a green claim nor a red alarm — rather than withheld.
 */
function summariseRungs(
  result: BeePublishersResult | null,
  rungs: LadderRung[],
): RungSummary {
  interface RungFacts {
    stampId: string | null;
    stampState?: StampState;
    urlState?: PublishUrlState;
    status: string;
  }

  const states: RungFacts[] =
    result?.rungs ??
    rungs.map((r) => ({
      stampId: r.profile.stamp_id ?? null,
      status: r.profile.status,
    }));

  const dead = states.filter((r) => isDeadStampState(r.stampState)).length;
  const unverified = states.filter(
    (r) => r.stampId && (r.stampState ?? 'unknown') === 'unknown',
  ).length;
  const stamped = states.filter(
    (r) => r.stampId && !isDeadStampState(r.stampState),
  ).length;
  const notRunning = states.filter(
    (r) => r.status !== PUBLISHABLE_RUNG_STATUS,
  ).length;
  const badAddress = states.filter((r) => isInvalidUrlState(r.urlState)).length;

  const allVerified =
    stamped === DEFAULT_ABR_LADDER.length &&
    states.every((r) => r.stampState === 'active');

  return {
    stamped,
    dead,
    unverified,
    notRunning,
    badAddress,
    color:
      result === null
        ? 'default'
        : dead > 0
          ? 'error'
          : allVerified
            ? 'success'
            : 'warning',
    title:
      unverified > 0
        ? `${unverified} of these batches could not be checked with their bee node`
        : undefined,
    problem: mostUrgent({ notRunning, badAddress, dead }),
  };
}

function mostUrgent({
  notRunning,
  badAddress,
  dead,
}: {
  notRunning: number;
  badAddress: number;
  dead: number;
}): string | null {
  if (notRunning > 0) return `${notRunning} of 4 not running`;
  if (badAddress > 0) {
    return badAddress === 1 ? '1 bad address' : `${badAddress} bad addresses`;
  }
  if (dead > 0) {
    return dead === 1 ? '1 batch expired' : `${dead} batches expired`;
  }
  return null;
}
