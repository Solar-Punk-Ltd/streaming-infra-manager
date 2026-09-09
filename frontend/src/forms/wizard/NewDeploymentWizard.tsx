import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { getErrorMessage } from '@streaming-infra-manager/common';

import type { WizardPrefill } from '../../app/EditorsContext';
import { navigate } from '../../app/router';
import { useToast } from '../../app/ToastProvider';
import { useDeployments } from '../../app/useDeploymentsStore';
import { usePoolResults } from '../../groups/useBeePublishers';
import { ApiError, SessionEndedError } from '../../http';
import { beginPoolSetup, finishPoolSetup, overlayCreatedPool, type CreatedPool, type PoolSetupOutcome } from './poolDraft';
import { matchingPool } from './poolIdentity';
import { PoolResponseError } from './PoolResponseError';
import { readPoolMembership } from './poolMembership';
import { StepRail } from './StepRail';
import { BasicsStep } from './steps/BasicsStep';
import { GoalStep } from './steps/GoalStep';
import { ReviewStep } from './steps/ReviewStep';
import { SettingsStep } from './steps/SettingsStep';
import { wizardError } from './wizardError';
import {
  deployLabel,
  initialWizardState,
  LAST_STEP,
  type WizardContext,
  type WizardState,
} from './wizardState';
import { submitWizard } from './wizardSubmit';

/**
 * The four-step New deployment dialog: goal, basics, the settings that goal
 * needs, review.
 *
 * Mounted only while it is open, so every opening starts from a clean set of
 * choices and a prefill from a row or a pool card lands on step 2 with the
 * pick already made.
 */
export function NewDeploymentWizard({
  prefill,
  onClose,
}: {
  prefill?: WizardPrefill;
  onClose: () => void;
}) {
  const {
    profiles,
    groups,
    serverHost,
    hostPassphrase,
    versions,
    mergeProfiles,
    reload,
  } = useDeployments();
  const [createdPool, setCreatedPool] = useState<CreatedPool | null>(null);
  const [poolToVerify, setPoolToVerify] = useState<CreatedPool | null>(null);
  const [unavailablePoolIds, setUnavailablePoolIds] = useState<ReadonlySet<number>>(() => new Set());
  const projected = useMemo(() => overlayCreatedPool(groups.filter(group => !unavailablePoolIds.has(group.id)),
    (profiles ?? []).filter(profile => profile.group_id == null || !unavailablePoolIds.has(profile.group_id)), createdPool), [groups, profiles, createdPool, unavailablePoolIds]);
  const poolResults = usePoolResults(projected.groups, projected.profiles);
  const toast = useToast();

  const context = useMemo<WizardContext>(
    () => ({
      profiles: projected.profiles,
      groups: projected.groups,
      serverHost,
      hostPassphrase,
      poolResults,
      versions: versions ?? [],
    }),
    [projected, serverHost, hostPassphrase, poolResults, versions],
  );

  const [state, setState] = useState<WizardState>(() =>
    initialWizardState(prefill, context),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [poolSetup, setPoolSetup] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertainSubmission, setUncertainSubmission] = useState(false);
  const uploaderDraft = useRef<WizardState | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      uploaderDraft.current = null;
    };
  }, []);

  useEffect(() => {
    if (createdPool && !projected.created) setCreatedPool(null);
  }, [createdPool, projected.created]);

  useEffect(() => {
    if (!poolToVerify) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    // These reads start after acceptance, so an older global refresh cannot erase the accepted identity.
    void readPoolMembership(controller.signal).then(({ groups: freshGroups, profiles: freshProfiles }) => {
      if (cancelled || !mounted.current) return;
      const group = freshGroups.find(group => group.id === poolToVerify.group.id);
      if (!matchingPool({ group, profiles: freshProfiles.filter(profile => profile.group_id === poolToVerify.group.id) }, poolToVerify.group.name)) {
        setUnavailablePoolIds(previous => new Set([...previous, poolToVerify.group.id]));
        setCreatedPool(null);
        setNotice('The newly created pool is no longer available as a compatible pool. Your uploader draft is unchanged. Check the deployment list.');
      }
    }).catch(() => {
      if (!cancelled && mounted.current) setNotice('The pool was accepted, but its current membership could not be checked. The displayed identity comes from the creation response. Your uploader is still a draft.');
    }).finally(() => {
      clearTimeout(timeout);
      controller.abort();
      if (!cancelled && mounted.current) setPoolToVerify(previous => previous === poolToVerify ? null : previous);
    });
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [poolToVerify]);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const stepError = wizardError(state, context);
  const createPool = () => {
    if (inFlight.current || state.goal !== 'abr-uploader') return;
    const setup = beginPoolSetup(state, context);
    generation.current += 1;
    uploaderDraft.current = setup.uploader;
    setState(setup.pool);
    setPoolSetup(true);
    setNotice(null);
    setSubmitError(null);
    setUncertainSubmission(false);
  };

  const returnToUploader = (outcome: PoolSetupOutcome) => {
    const draft = uploaderDraft.current;
    if (!draft) return;
    const restored = finishPoolSetup(draft, outcome);
    generation.current += 1;
    uploaderDraft.current = null;
    inFlight.current = false;
    setSubmitting(false);
    setPoolSetup(false);
    setState(restored.state);
    if (restored.created) {
      setCreatedPool(restored.created);
      setPoolToVerify(restored.created);
    }
    setNotice(restored.notice);
    setSubmitError(null);
    setUncertainSubmission(false);
  };
  const stepProps = { state, context, update, onCreatePool: createPool };

  const close = () => {
    if (inFlight.current && !poolSetup) return;
    generation.current += 1;
    mounted.current = false;
    uploaderDraft.current = null;
    onClose();
  };

  const deploy = async () => {
    if (inFlight.current || uncertainSubmission) return;
    inFlight.current = true;
    const requestGeneration = ++generation.current;
    const current = () => mounted.current && generation.current === requestGeneration;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitWizard(state, context);
      if (!current()) return;
      if (poolSetup) {
        returnToUploader({ kind: 'accepted', expectedName: state.name, value: outcome.createdPool });
        mergeProfiles(outcome.profiles);
        reload();
        return;
      }
      mergeProfiles(outcome.profiles);
      reload();
      onClose();
      toast(outcome.toast);
      navigate(outcome.route);
    } catch (caught) {
      if (!current() || caught instanceof SessionEndedError) return;
      if (poolSetup && caught instanceof PoolResponseError) {
        returnToUploader({ kind: 'accepted', expectedName: state.name, value: null });
      } else if (state.goal === 'abr-pool' && !(caught instanceof ApiError)) {
        setUncertainSubmission(true);
        setSubmitError(caught instanceof PoolResponseError ? caught.message : 'The pool request did not finish with a readable response. It may already exist. Check the deployment list before creating another pool.');
      } else {
        setSubmitError(getErrorMessage(caught, 'failed to create the deployment'));
      }
    } finally {
      if (current()) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  };

  const blocked =
    state.step === 1 ? state.goal === null : stepError !== null;

  return (
    <Dialog open maxWidth="md" fullWidth onClose={close}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1 }}>{poolSetup ? 'Create a storage pool for your uploader' : 'New deployment'}</Box>
        <IconButton onClick={close} aria-label="close" size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
          <StepRail step={state.step} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
            {state.step === 1 && <GoalStep {...stepProps} />}
            {state.step === 2 && <BasicsStep {...stepProps} />}
            {state.step === 3 && <SettingsStep {...stepProps} />}
            {state.step === LAST_STEP && <ReviewStep {...stepProps} />}
            {submitError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {submitError}
              </Alert>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
        {poolSetup && <Button onClick={() => returnToUploader({ kind: 'cancelled' })}>Return to uploader</Button>}
        {state.step > 1 && (
          <Button onClick={() => update({ step: state.step - 1 })} disabled={submitting}>
            Back
          </Button>
        )}
        <Box sx={{ flex: 1 }}>
          {state.step > 1 && stepError && (
            <Typography variant="caption" color="warning.main">
              {stepError}
            </Typography>
          )}
        </Box>
        {state.step < LAST_STEP ? (
          <Button
            variant="contained"
            disabled={blocked || submitting}
            onClick={() => update({ step: state.step + 1 })}
          >
            Continue
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={submitting || uncertainSubmission || stepError !== null}
            onClick={() => void deploy()}
          >
            {deployLabel(state)}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
