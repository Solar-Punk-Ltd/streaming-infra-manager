import { Box, Button, Chip, Stack, Typography } from '@mui/material';

import type { DeploymentSettingEntry, SettingOwner } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../app/theme';
import { canReset, type SettingEdit, shownValue } from './deploymentSettingsDraft';
import { SettingDescription } from './SettingDescription';
import { SettingValueField } from './SettingValueField';
import {
  OWNED_STORED_NOTE,
  REMOVAL_PENDING_NOTE,
  RESET_PENDING_NOTE,
  UNDECLARED_NOTE,
  behindNote,
  defaultText,
  ownedValueText,
  ownerSentence,
  pendingChipLabel,
  recreatesText,
  secretNote,
  type SettingsEditTarget,
} from './settingsText';

/** Where one key stands against the draft and against the running containers. */
export interface SettingRowState {
  edit: SettingEdit | undefined;
  /** The next save sends this key. */
  pending: boolean;
  /** The saved value is one the containers were not started with. */
  behind: boolean;
  /** Why the manager would refuse the value typed, or null. */
  problem: string | null;
}

interface RowActions {
  onValue: (value: string) => void;
  onReset: () => void;
  onUndo: () => void;
}

/** A chip whose label wraps, because a service list is longer than a phone is wide. */
const WRAPPING_CHIP = { maxWidth: '100%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', overflowWrap: 'anywhere' } };

const CAPTION_WRAP = { overflowWrap: 'anywhere' } as const;

/**
 * One key of a deployment's settings: its name, what the sample says about
 * it, and either the field that changes it or the reason it is changed
 * elsewhere.
 */
export function DeploymentSettingRow({
  entry,
  state,
  running,
  disabled,
  target = 'deployment',
  controlValue,
  ...actions
}: {
  entry: DeploymentSettingEntry;
  state: SettingRowState;
  /** Whether the deployment's containers run, which decides what a saved change still waits for. */
  running: boolean;
  disabled: boolean;
  target?: SettingsEditTarget;
  /**
   * For a key a control decides, the value that control on the same form
   * gives it. A deployment not created yet has no value of its own for such
   * a key, since the manager works it out at the first deploy.
   */
  controlValue?: string;
} & RowActions) {
  return (
    <Box
      component="li"
      data-setting={entry.key}
      sx={{ listStyle: 'none', py: 1.5, borderTop: 1, borderColor: 'divider', minWidth: 0 }}
    >
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="body2" sx={{ fontFamily: MONO_STACK, fontWeight: 600, wordBreak: 'break-all' }}>
          {entry.key}
        </Typography>
        <RowChips entry={entry} state={state} target={target} />
      </Stack>
      <SettingDescription settingKey={entry.key} description={entry.description} />
      {entry.owner !== null ? (
        <OwnedBody
          entry={entry}
          owner={entry.owner}
          shownValue={target === 'deployment' ? ownedValueText(entry) : controlValue}
          edit={state.edit}
          disabled={disabled}
          {...actions}
        />
      ) : !entry.declared ? (
        <UndeclaredBody entry={entry} edit={state.edit} disabled={disabled} {...actions} />
      ) : (
        <ValueBody entry={entry} state={state} running={running} disabled={disabled} target={target} {...actions} />
      )}
    </Box>
  );
}

function RowChips({ entry, state, target }: { entry: DeploymentSettingEntry; state: SettingRowState; target: SettingsEditTarget }) {
  const ownValue = entry.stored && state.edit?.kind !== 'reset';
  // A control's own key reaches the containers through that control, so a
  // reset of a value stored for it from before recreates nothing. A
  // deployment not created yet has no containers to recreate.
  const marksRecreation = (state.pending || state.behind) && entry.owner === null && target === 'deployment';
  return (
    <>
      {ownValue && <Chip size="small" variant="outlined" label="set here" />}
      {entry.source === 'generated' && <Chip size="small" variant="outlined" color="info" label="generated" />}
      {state.pending && <Chip size="small" color="primary" label={pendingChipLabel(target)} />}
      {state.behind && !state.pending && <Chip size="small" variant="outlined" color="warning" label="not applied" />}
      {marksRecreation && (
        <Chip size="small" variant="outlined" color="info" label={recreatesText(entry.services)} sx={WRAPPING_CHIP} />
      )}
    </>
  );
}

function ActionButton({ label, settingKey, disabled, onClick }: { label: string; settingKey: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button size="small" disabled={disabled} aria-label={`${label} for ${settingKey}`} onClick={onClick}>
      {label}
    </Button>
  );
}

/** A reset for a key whose only action is taking a stored value out. */
function RemovalLine({
  entry,
  edit,
  note,
  disabled,
  onReset,
  onUndo,
}: { entry: DeploymentSettingEntry; edit: SettingEdit | undefined; note: string; disabled: boolean } & Omit<RowActions, 'onValue'>) {
  const pending = edit?.kind === 'reset';
  return (
    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
      <Typography variant="caption" color={pending ? 'info.main' : 'text.secondary'} sx={{ flex: '1 1 12rem', ...CAPTION_WRAP }}>
        {pending ? REMOVAL_PENDING_NOTE : note}
      </Typography>
      {pending ? (
        <ActionButton label="Undo" settingKey={entry.key} disabled={disabled} onClick={onUndo} />
      ) : (
        <ActionButton label="Reset" settingKey={entry.key} disabled={disabled} onClick={onReset} />
      )}
    </Stack>
  );
}

function OwnedBody({
  entry,
  owner,
  shownValue: value,
  edit,
  disabled,
  onReset,
  onUndo,
}: {
  entry: DeploymentSettingEntry;
  owner: SettingOwner;
  /** The value to show above the control's name, or nothing where no value is known yet. */
  shownValue: string | undefined;
  edit: SettingEdit | undefined;
  disabled: boolean;
} & RowActions) {
  return (
    <Stack spacing={0.75}>
      {value !== undefined && (
        <Typography variant="body2" sx={{ fontFamily: MONO_STACK, ...CAPTION_WRAP }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        {ownerSentence(owner)}
      </Typography>
      {entry.stored && (
        <RemovalLine entry={entry} edit={edit} note={OWNED_STORED_NOTE} disabled={disabled} onReset={onReset} onUndo={onUndo} />
      )}
    </Stack>
  );
}

function UndeclaredBody({
  entry,
  edit,
  disabled,
  onReset,
  onUndo,
}: { entry: DeploymentSettingEntry; edit: SettingEdit | undefined; disabled: boolean } & RowActions) {
  return (
    <Stack spacing={0.75}>
      <Typography variant="body2" sx={{ fontFamily: MONO_STACK, ...CAPTION_WRAP }}>
        {entry.secret ? 'hidden' : (entry.storedValue ?? '')}
      </Typography>
      <RemovalLine entry={entry} edit={edit} note={UNDECLARED_NOTE} disabled={disabled} onReset={onReset} onUndo={onUndo} />
    </Stack>
  );
}

function ValueBody({
  entry,
  state,
  running,
  disabled,
  target,
  onValue,
  onReset,
  onUndo,
}: { entry: DeploymentSettingEntry; state: SettingRowState; running: boolean; disabled: boolean; target: SettingsEditTarget } & RowActions) {
  const { edit } = state;
  const resetPending = edit?.kind === 'reset';
  return (
    <Stack spacing={0.75}>
      {entry.secret && (
        <Typography variant="caption" color="text.secondary">
          {secretNote(entry, target)}
        </Typography>
      )}
      <SettingValueField
        entry={entry}
        value={shownValue(entry, edit)}
        disabled={disabled || resetPending}
        problem={state.problem}
        onChange={onValue}
      />
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 12rem', ...CAPTION_WRAP }}>
          {defaultText(entry)}
        </Typography>
        {edit && <ActionButton label="Undo" settingKey={entry.key} disabled={disabled} onClick={onUndo} />}
        {canReset(entry) && !resetPending && (
          <ActionButton label="Reset to default" settingKey={entry.key} disabled={disabled} onClick={onReset} />
        )}
      </Stack>
      {resetPending && (
        <Typography variant="caption" color="info.main">
          {RESET_PENDING_NOTE}
        </Typography>
      )}
      {state.behind && !state.pending && (
        <Typography variant="caption" color="warning.main">
          {behindNote(running)}
        </Typography>
      )}
    </Stack>
  );
}
