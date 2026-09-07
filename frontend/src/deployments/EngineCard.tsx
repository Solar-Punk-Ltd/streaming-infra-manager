import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArticleIcon from '@mui/icons-material/Article';
import CodeIcon from '@mui/icons-material/Code';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TuneIcon from '@mui/icons-material/Tune';

import {
  type EngineName,
  type EngineSettingField,
  getErrorMessage,
  type RolloutAction,
  rolloutNotice,
} from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import { fetchEngine, type EngineOverview } from './engineApi';
import { ENGINE_LABEL } from './engineText';
import { LogsDialog } from './LogsDialog';
import { isTransitional } from './shape';

const ABR_SECTION_TITLE = 'Transcoding';

const OWN_CONFIG_NOTE =
  'Runs on a config file of its own. The Settings drawer still fills the placeholders that file kept.';

const ROLLOUT_ACTION_LABEL: Record<RolloutAction, string> = {
  verify: 'Verify now',
  previous: 'Back to the previous file',
};

/**
 * Why Restart is greyed out, or an empty string when it is not.
 *
 * A disabled button receives no pointer events, so the Tooltip below wraps it
 * in a span that does. Without that the reason is on screen for nobody.
 */
function whyRestartIsOff(engineRunning: boolean, deploying: boolean): string {
  if (!engineRunning) return 'Start the deployment first.';
  if (deploying) return 'Wait for the current deploy to finish.';
  return '';
}

/**
 * Why the two ways out of a rollout are greyed out, or an empty string.
 *
 * Both recreate the engine, which on a stopped deployment would start it,
 * and that is the operator's call to make from the Start button, not from a
 * notice about a config file.
 */
function whyRolloutActionsAreOff(profile: Profile, busy: boolean): string {
  if (profile.status === 'STOPPED') return 'Start the deployment first.';
  if (isTransitional(profile) || busy) return 'Wait for the current deploy to finish.';
  return '';
}

/**
 * The media server this deployment runs: what it is configured with, and the
 * two things an operator does to it by hand.
 *
 * The settings themselves come from the manager rather than from the profile,
 * because the field list is the stack's and only the manager knows which stack
 * is pinned. That is also where the live block's answer will come from once the
 * engine API port is published, which it is not on this one.
 */
export function EngineCard({
  profile,
  engine,
}: {
  profile: Profile;
  engine: EngineName;
}) {
  const { openEngineSettings, openEngineConfig } = useEditors();
  const actions = useActions();
  const [overview, setOverview] = useState<EngineOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);

  // Reloads after a save: the profile's updated_at moves on every write, and
  // the drawer's save merges the new profile into the store.
  useEffect(() => {
    let current = true;
    fetchEngine(profile.name)
      .then((loaded) => {
        if (current) {
          setOverview(loaded);
          setLoadError(null);
        }
      })
      .catch((caught) => {
        if (current) {
          setLoadError(getErrorMessage(caught, 'The manager did not say why.'));
        }
      });
    return () => {
      current = false;
    };
  }, [profile.name, profile.updated_at]);

  const engineRunning = profile.containers.some(
    (container) => container.service === engine,
  );
  const restartOffBecause = whyRestartIsOff(
    engineRunning,
    actions.isBusy(profile.name),
  );
  const notice = rolloutNotice(
    profile.engine_config_state,
    { engine: ENGINE_LABEL[engine], hasConfig: profile.has_engine_config },
    profile.engine_config_error,
  );
  const rolloutActionsOffBecause = whyRolloutActionsAreOff(
    profile,
    actions.isBusy(profile.name),
  );
  const rolloutAction = (offer: RolloutAction) =>
    offer === 'verify'
      ? actions.verifyEngineConfig(profile.name, engine)
      : actions.restorePreviousEngineConfig(profile.name, engine);

  return (
    <SectionCard
      title={ENGINE_LABEL[engine]}
      sub="media server"
      actions={
        <Stack direction="row" spacing={1} alignItems="center">
          <ReadinessPill
            label={engineRunning ? 'Running' : 'Not running'}
            tone={engineRunning ? 'ok' : 'gray'}
          />
          <Button
            size="small"
            startIcon={<TuneIcon />}
            onClick={() => openEngineSettings(profile.name)}
          >
            Settings
          </Button>
          <Button
            size="small"
            startIcon={<CodeIcon />}
            onClick={() => openEngineConfig(profile.name)}
          >
            Config file
          </Button>
          <Tooltip title={restartOffBecause}>
            <Box component="span">
              <Button
                size="small"
                startIcon={<RestartAltIcon />}
                disabled={restartOffBecause !== ''}
                onClick={() => actions.restartContainer(profile.name, engine)}
              >
                Restart
              </Button>
            </Box>
          </Tooltip>
          <Button
            size="small"
            startIcon={<ArticleIcon />}
            onClick={() => setLogsOpen(true)}
          >
            Logs
          </Button>
        </Stack>
      }
    >
      <Stack spacing={2}>
        {notice && (
          <Alert
            severity={notice.severity}
            action={
              notice.offers.length > 0 ? (
                <Stack direction="row" spacing={1} sx={{ alignSelf: 'center' }}>
                  {notice.offers.map((offer) => (
                    <Tooltip key={offer} title={rolloutActionsOffBecause}>
                      <Box component="span">
                        <Button
                          size="small"
                          color="inherit"
                          disabled={rolloutActionsOffBecause !== ''}
                          onClick={() => rolloutAction(offer)}
                        >
                          {ROLLOUT_ACTION_LABEL[offer]}
                        </Button>
                      </Box>
                    </Tooltip>
                  ))}
                </Stack>
              ) : undefined
            }
          >
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {notice.title}
            </Typography>
            {notice.showsReason && profile.engine_config_error && (
              <Box
                component="pre"
                sx={{ m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}
              >
                {profile.engine_config_error}
              </Box>
            )}
          </Alert>
        )}
        {profile.has_engine_config && (
          <Typography variant="caption" color="text.secondary">
            {OWN_CONFIG_NOTE}
          </Typography>
        )}
        {overview && (
          <>
            <SettingsList
              fields={overview.fields.filter((field) => !field.abrOnly)}
              overview={overview}
            />
            {overview.fields.some((field) => field.abrOnly) && (
              <>
                <Divider />
                <Typography variant="subtitle2">{ABR_SECTION_TITLE}</Typography>
                <SettingsList
                  fields={overview.fields.filter((field) => field.abrOnly)}
                  overview={overview}
                />
              </>
            )}
          </>
        )}

        {/*
          Only once there is an answer. Said before the fetch lands it is a
          claim about a stack version nothing has read yet, and after a failed
          fetch it is the wrong reason for an empty card.
        */}
        {(overview || loadError) && (
          <Box
            sx={{
              px: 1.5,
              py: 1.25,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {overview
                ? overview.liveUnavailableReason
                : `Could not read the engine's settings. ${loadError}`}
            </Typography>
          </Box>
        )}
      </Stack>

      {logsOpen && (
        <LogsDialog
          profile={profile}
          engine={engine}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </SectionCard>
  );
}

function SettingsList({
  fields,
  overview,
}: {
  fields: EngineSettingField[];
  overview: EngineOverview;
}) {
  const entries: KeyValueEntry[] = fields.map((field) => {
    const stored = overview.settings[field.key];
    const value = stored ?? overview.defaults[field.key] ?? field.defaultValue;
    const source = overview.defaultSources[field.key] ?? 'stack';
    return {
      key: field.label,
      value: (
        <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
          <Box component="span" sx={{ fontFamily: MONO_STACK }}>
            {value}
          </Box>
          {field.unit && (
            <Typography variant="caption" color="text.secondary">
              {field.unit}
            </Typography>
          )}
          {!stored && (
            <Typography variant="caption" color="text.secondary">
              {source === 'host' ? 'host default' : 'stack default'}
            </Typography>
          )}
        </Stack>
      ),
    };
  });

  return <KeyValueList entries={entries} labelWidth={150} />;
}
