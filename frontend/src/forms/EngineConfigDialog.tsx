import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import {
  type EngineConfigView,
  type EngineName,
  getErrorMessage,
  OME_SERVICE,
  rolloutNotice,
  SRS_SERVICE,
  unknownPlaceholders,
} from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import { CodeTextArea } from '../components/CodeTextArea';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import {
  fetchEngineConfigView,
  resetEngineConfig,
  saveEngineConfig,
} from '../deployments/engineApi';
import { ENGINE_LABEL } from '../deployments/engineText';

const APPLY_LABEL = 'Check and apply';
const RESET_LABEL = 'Back to the template';

const WHAT_THIS_IS =
  'Everything the engine can do is in this file. Keep the placeholder tokens where you want the stack to fill them in at start: the passphrase, the ports, the webhook token and the values from the Settings drawer all arrive that way and never have to be written here.';

/**
 * What applying does, per engine, because the two are checked differently:
 * SRS reads the file with its own parser before anything changes, and
 * OvenMediaEngine has no parser to ask, so it gets the manager's check first
 * and the checks after the recreate second.
 */
const WHAT_APPLYING_DOES: Record<EngineName, string> = {
  [SRS_SERVICE]:
    'Applying runs the file through SRS\'s own parser first, in a throwaway container, so a file it refuses changes nothing. Then the engine is recreated on it and watched for twenty seconds, and if it will not stay up the previous file comes back on its own, which is a recovery attempt and not a promise. A publisher, if one is live, is disconnected for a few seconds either way.',
  [OME_SERVICE]:
    'OvenMediaEngine has no parser to ask, so applying checks the file here first: it must be well formed XML and keep what the stack\'s uploader depends on from this version\'s template. Then the engine is recreated on it, watched for twenty seconds, and its HLS port is tried once the watch is over. If the engine will not stay up the previous file comes back on its own, which is a recovery attempt and not a promise, and a port that does not answer is reported as a note, not a failure. A publisher, if one is live, is disconnected for a few seconds either way.',
};

function resetConfirm(name: string, onConfirm: () => void): ConfirmRequest {
  return {
    title: `Back to the template for ${name}?`,
    body: 'The file you applied is forgotten and the engine is recreated on the stack\'s own template. Copy the file first if you want to keep it.',
    confirmLabel: RESET_LABEL,
    danger: true,
    onConfirm,
  };
}

/** What the editor shows first: the stored file, else the version's template. */
function openingText(view: EngineConfigView): string {
  return view.config ?? view.template;
}

/**
 * The engine's whole config file, for a deployment whose stack version can
 * run it on one.
 *
 * A dialog rather than the edit drawer, because a config file wants the
 * width. The text starts as whatever the engine runs now, which is the
 * template until a file has been applied, so the operator edits from a
 * known good starting point and never from a blank page.
 */
export function EngineConfigDialog({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { mergeProfiles, profiles } = useDeployments();
  // The view is read once, when the dialog opens, and holds the file. The
  // rollout moves while the dialog is open, so its state and reason come from
  // the live row the event stream keeps current, the view only until the row
  // is known.
  const live = profiles?.find((profile) => profile.name === name) ?? null;
  const [view, setView] = useState<EngineConfigView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const errorBox = useRef<HTMLDivElement>(null);

  // A refusal lands below a config file that is taller than the dialog, so
  // without this the button looks like it did nothing. Measured on 2026-09-11:
  // the reason for a refused apply sat 450 pixels below the visible area.
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  useEffect(() => {
    let current = true;
    fetchEngineConfigView(name)
      .then((loaded) => {
        if (!current) return;
        setView(loaded);
        setDraft(openingText(loaded));
      })
      .catch((caught) => {
        if (current) setError(getErrorMessage(caught, 'could not read the engine config'));
      });
    return () => {
      current = false;
    };
  }, [name]);

  const close = () => {
    if (!busy) onClose();
  };

  const unchanged = view ? draft === openingText(view) : true;
  const unknown = view ? unknownPlaceholders(draft, view.placeholders) : [];

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveEngineConfig(name, draft);
      mergeProfiles([saved]);
      onClose();
      toast(`Applied. Recreating the engine for ${name} and watching it for twenty seconds…`);
    } catch (caught) {
      setError(getErrorMessage(caught, 'the file was not applied'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await resetEngineConfig(name);
      mergeProfiles([saved]);
      onClose();
      toast(`Back to the template. Recreating the engine for ${name}…`);
    } catch (caught) {
      setError(getErrorMessage(caught, 'could not go back to the template'));
    } finally {
      setBusy(false);
    }
  };

  const engineName = view ? ENGINE_LABEL[view.engine] : 'engine';
  const rollout = live
    ? { state: live.engine_config_state, hasConfig: live.has_engine_config, reason: live.engine_config_error }
    : view
      ? { state: view.state, hasConfig: view.config !== null, reason: view.error }
      : null;
  const notice = rollout && view
    ? rolloutNotice(rollout.state, { engine: engineName, hasConfig: rollout.hasConfig }, rollout.reason)
    : null;

  return (
    <Dialog open maxWidth="lg" fullWidth onClose={close}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          Config file for {name}
          <Typography variant="body2" color="text.secondary" component="div">
            {engineName}
            {view?.config ? ' · running on its own file' : ' · running on the template'}
          </Typography>
        </Box>
        <IconButton onClick={close} aria-label="close" size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {!view ? (
          <Stack alignItems="center" sx={{ py: 6 }}>
            {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
          </Stack>
        ) : (
          <Stack spacing={2}>
            {!view.supported && (
              <Alert severity="info">{view.unsupportedReason}</Alert>
            )}
            {notice && (
              <Alert severity={notice.severity}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {notice.title}
                </Typography>
                {notice.showsReason && rollout?.reason && (
                  <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
                    {rollout.reason}
                  </Box>
                )}
              </Alert>
            )}
            <Typography variant="body2" color="text.secondary">
              {WHAT_THIS_IS}
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
              <Typography variant="caption" color="text.secondary">
                This version fills:
              </Typography>
              {view.placeholders.map((token) => (
                <Chip
                  key={token}
                  label={token}
                  size="small"
                  variant="outlined"
                  color={draft.includes(token) ? 'primary' : 'default'}
                  sx={{ fontFamily: 'monospace' }}
                />
              ))}
            </Stack>
            <CodeTextArea
              value={draft}
              onChange={setDraft}
              readOnly={!view.supported || busy}
              ariaLabel={`${engineName} config file`}
            />
            {unknown.length > 0 && (
              <Alert severity="warning">
                {unknown.join(', ')} {unknown.length === 1 ? 'is not a placeholder' : 'are not placeholders'} this
                version fills, so the engine would read {unknown.length === 1 ? 'it' : 'them'} as written.
              </Alert>
            )}
            {error && <Alert ref={errorBox} severity="error">{error}</Alert>}
            <Typography variant="caption" color="text.secondary">
              {WHAT_APPLYING_DOES[view.engine]}{' '}
              {view.references.map((reference) => (
                <Link key={reference.url} href={reference.url} target="_blank" rel="noreferrer">
                  {reference.label}
                </Link>
              ))}
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
        {view?.config && (
          <Button
            color="error"
            disabled={busy}
            onClick={() => setConfirm(resetConfirm(name, () => void reset()))}
          >
            {RESET_LABEL}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!view || !view.supported || busy || unchanged || !draft.trim()}
          onClick={() => void apply()}
        >
          {APPLY_LABEL}
        </Button>
      </DialogActions>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Dialog>
  );
}
