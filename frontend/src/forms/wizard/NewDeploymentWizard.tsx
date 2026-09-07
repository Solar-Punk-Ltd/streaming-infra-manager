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
  const poolResults = usePoolResults(groups, profiles);
  const toast = useToast();

  const context = useMemo<WizardContext>(
    () => ({
      profiles: profiles ?? [],
      groups,
      serverHost,
      hostPassphrase,
      poolResults,
      versions: versions ?? [],
    }),
    [profiles, groups, serverHost, hostPassphrase, poolResults, versions],
  );

  const [state, setState] = useState<WizardState>(() =>
    initialWizardState(prefill, context),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitFailures, setSubmitFailures] = useState(0);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const stepError = wizardError(state, context);
  const stepProps = { state, context, update };

  const close = () => {
    if (!submitting) onClose();
  };

  const deploy = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitWizard(state, context);
      mergeProfiles(outcome.profiles);
      reload();
      onClose();
      toast(outcome.toast);
      navigate(outcome.route);
    } catch (caught) {
      setSubmitError(getErrorMessage(caught, 'failed to create the deployment'));
      setSubmitFailures((count) => count + 1);
    } finally {
      setSubmitting(false);
    }
  };

  // A keyboard user arrives on each step at its content, not left on the
  // button they pressed, unless the step already put focus in a field of its
  // own.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const step = stepRef.current;
    if (step && !step.contains(document.activeElement)) step.focus();
  }, [state.step]);

  // A failed submission is reached and read out, not only painted. Counted,
  // so a second failure with the same words is reached again.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (submitFailures > 0) errorRef.current?.focus();
  }, [submitFailures]);

  const blocked =
    state.step === 1 ? state.goal === null : stepError !== null;

  return (
    <Dialog open maxWidth="md" fullWidth onClose={close}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1 }}>New deployment</Box>
        <IconButton onClick={close} aria-label="close" size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
          <StepRail step={state.step} />
          <Box
            ref={stepRef}
            tabIndex={-1}
            sx={{
              flex: 1,
              minWidth: 0,
              borderRadius: 1,
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '4px' },
            }}
          >
            {state.step === 1 && <GoalStep {...stepProps} />}
            {state.step === 2 && <BasicsStep {...stepProps} />}
            {state.step === 3 && <SettingsStep {...stepProps} />}
            {state.step === LAST_STEP && <ReviewStep {...stepProps} />}
            {submitError && (
              <Alert ref={errorRef} tabIndex={-1} severity="error" sx={{ mt: 2 }}>
                {submitError}
              </Alert>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
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
            disabled={blocked}
            onClick={() => update({ step: state.step + 1 })}
          >
            Continue
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={submitting || stepError !== null}
            onClick={() => void deploy()}
          >
            {deployLabel(state)}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
