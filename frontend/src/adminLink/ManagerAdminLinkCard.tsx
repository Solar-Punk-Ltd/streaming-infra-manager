import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';

import { getErrorMessage, type ManagerAdminLink } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { SectionCard } from '../components/SectionCard';
import { PLAIN_TEXT_INPUT } from '../deployments/settings/SettingValueField';
import { ApiError } from '../http';
import { saveManagerAdminLink, testAdminLink } from './adminLinkApi';
import { AdminLinkTest } from './AdminLinkTest';
import {
  MANAGER_LINK_LEAD,
  MANAGER_LINK_SAVED,
  MANAGER_LINK_SAVE_RACE,
  MANAGER_LINK_URL_HINT,
  managerLinkTestBlocked,
  managerTokenHint,
  managerTokenStatus,
} from './adminLinkText';
import {
  draftOf,
  type ManagerAdminLinkDraft,
  managerAdminLinkChanged,
  managerAdminLinkDraftProblems,
  managerAdminLinkSaveOf,
  managerAdminLinkTestOf,
} from './managerAdminLinkDraft';
import type { ManagerAdminLinkLoad } from './useManagerAdminLink';

export const MANAGER_LINK_URL_ID = 'manager-admin-link-url';
export const MANAGER_LINK_TOKEN_ID = 'manager-admin-link-token';

/** A browser offers a saved sign-in for a password field unless it is told the field wants a new password. */
const NEW_PASSWORD = 'new-password';

const WRAPPED_ALERT = { '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } } as const;

/**
 * The web2 admin link every new uploader deployment starts with, on the
 * Manager settings page. The token field starts empty and is never filled
 * from the manager: typing replaces the stored token, Clear takes it out, and
 * leaving it empty keeps it.
 */
export function ManagerAdminLinkCard({ load }: { load: ManagerAdminLinkLoad }) {
  const { link } = load;
  // Held here, because a save that lost a race reads the link again, which starts the editor over.
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SectionCard title="Web2 admin link for new deployments">
      {link ? (
        <LinkEditor key={link.revision} link={link} load={load} notice={notice} onNotice={setNotice} />
      ) : load.error ? (
        <Alert
          severity="warning"
          sx={WRAPPED_ALERT}
          action={
            <Button color="inherit" size="small" onClick={() => void load.reload()}>
              Try again
            </Button>
          }
        >
          Could not read the web2 admin link. {load.error}
        </Alert>
      ) : (
        <Stack alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size={24} aria-label="Reading the web2 admin link" />
        </Stack>
      )}
    </SectionCard>
  );
}

function LinkEditor({
  link,
  load,
  notice,
  onNotice,
}: {
  link: ManagerAdminLink;
  load: ManagerAdminLinkLoad;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ManagerAdminLinkDraft>(() => draftOf(link));
  const [edits, setEdits] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);

  const problems = managerAdminLinkDraftProblems(link, draft);
  const changed = managerAdminLinkChanged(link, draft);
  const testRequest = problems.length === 0 ? managerAdminLinkTestOf(link, draft) : null;
  const urlProblem = problems.find((problem) => problem.startsWith('ADMIN_API_URL')) ?? null;
  const tokenProblem = problems.find((problem) => !problem.startsWith('ADMIN_API_URL')) ?? null;

  const edit = (next: ManagerAdminLinkDraft) => {
    setDraft(next);
    setEdits((count) => count + 1);
    setSaveProblem(null);
    onNotice(null);
  };

  const save = async () => {
    if (!changed || problems.length > 0 || saving) return;
    setSaving(true);
    setSaveProblem(null);
    onNotice(null);
    try {
      load.replace(await saveManagerAdminLink(managerAdminLinkSaveOf(link, draft)));
      toast(MANAGER_LINK_SAVED, 'success');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'manager_settings_changed') {
        onNotice(MANAGER_LINK_SAVE_RACE);
        await load.reload();
      } else {
        setSaveProblem(getErrorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">
        {MANAGER_LINK_LEAD}
      </Typography>

      <TextField
        id={MANAGER_LINK_URL_ID}
        label="Web2 admin address"
        size="small"
        fullWidth
        value={draft.url}
        disabled={saving}
        placeholder="https://admin.example.com"
        error={urlProblem !== null}
        helperText={urlProblem ?? MANAGER_LINK_URL_HINT}
        onChange={(event) => edit({ ...draft, url: event.target.value })}
        inputProps={{ ...PLAIN_TEXT_INPUT, inputMode: 'url' }}
      />

      <Stack spacing={0.75}>
        <Typography variant="caption" color="text.secondary" data-token-status sx={{ overflowWrap: 'anywhere' }}>
          {managerTokenStatus(link.tokenStored, draft.clearToken)}
        </Typography>
        <TextField
          id={MANAGER_LINK_TOKEN_ID}
          label="Token"
          type="password"
          size="small"
          fullWidth
          value={draft.token}
          disabled={saving || draft.clearToken}
          placeholder={link.tokenStored ? 'Type a new token to replace it' : 'Type the token'}
          error={tokenProblem !== null}
          helperText={tokenProblem ?? managerTokenHint(link.tokenStored)}
          onChange={(event) => edit({ ...draft, token: event.target.value })}
          inputProps={{ ...PLAIN_TEXT_INPUT, autoComplete: NEW_PASSWORD }}
        />
        {link.tokenStored && (
          <Box>
            <Button size="small" disabled={saving} onClick={() => edit({ ...draft, token: '', clearToken: !draft.clearToken })}>
              {draft.clearToken ? 'Keep the stored token' : 'Clear the stored token'}
            </Button>
          </Box>
        )}
      </Stack>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Button variant="contained" size="small" disabled={!changed || problems.length > 0 || saving} onClick={() => void save()}>
          {saving ? 'Saving' : 'Save'}
        </Button>
        <Button size="small" disabled={!changed || saving} onClick={() => edit(draftOf(link))}>
          Discard
        </Button>
      </Stack>

      {(saveProblem ?? notice) && (
        <Alert severity={saveProblem ? 'error' : 'info'} sx={WRAPPED_ALERT}>
          {saveProblem ?? notice}
        </Alert>
      )}

      <AdminLinkTest
        run={testRequest ? () => testAdminLink(testRequest) : null}
        blockedReason={managerLinkTestBlocked({ problems: problems.length > 0, url: draft.url !== '', tokenStored: link.tokenStored && !draft.clearToken })}
        resetKey={`${link.revision}:${edits}`}
      />
    </Stack>
  );
}
