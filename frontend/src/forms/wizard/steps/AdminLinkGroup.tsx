import { useRef } from 'react';
import { Alert, Box, Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';

import { adminTokenProblem, adminUrlProblem } from '@streaming-infra-manager/common';

import { testAdminLink } from '../../../adminLink/adminLinkApi';
import { AdminLinkTest } from '../../../adminLink/AdminLinkTest';
import {
  ADMIN_LINK_ABSENT,
  ADMIN_LINK_GROUP_LEAD,
  ADMIN_LINK_OFF_NOTE,
  ADMIN_LINK_SWITCH_LABEL,
  ADMIN_LINK_UNREAD,
  STORED_TOKEN_ELSEWHERE,
  storedTokenDetail,
  TYPE_TOKEN_HERE,
} from '../../../adminLink/adminLinkText';
import { PLAIN_TEXT_INPUT } from '../../../deployments/settings/SettingValueField';
import { ChoiceGroup } from '../../ChoiceGroup';
import {
  type AdminLinkChoice,
  adminLinkAvailability,
  adminLinkTestOf,
  asksAdminLink,
  chosenAdminLink,
  storedTokenElsewhere,
} from '../adminLinkChoice';
import type { WizardStepProps } from '../wizardState';

/** A browser offers a saved sign-in for a password field unless it is told the field wants a new password. */
const NEW_PASSWORD = 'new-password';

/**
 * The Web2 admin group of the settings step, for every deployment that runs
 * a stream uploader: a switch that links it to the web2 admin, on when the
 * manager has a link of its own, the address prefilled from it, and the
 * manager's stored token or one typed here, with Test connection.
 */
export function AdminLinkGroup({ state, context, update }: WizardStepProps) {
  const tokenField = useRef<HTMLInputElement | null>(null);
  if (!asksAdminLink(state)) return null;
  const availability = adminLinkAvailability(context);
  const choice = chosenAdminLink(state, context);
  const set = (patch: Partial<AdminLinkChoice>) => update({ adminLink: { ...choice, ...patch } });
  const tokenStored = Boolean(context.managerAdminLink?.tokenStored);
  const urlProblem = choice.url === '' ? null : adminUrlProblem(choice.url);
  const tokenProblem = choice.token === '' ? null : adminTokenProblem(choice.token);
  const testRequest = adminLinkTestOf(state, context);
  const elsewhere = storedTokenElsewhere(state, context);
  const typeTokenHere = () => {
    set({ tokenSource: 'typed' });
    requestAnimationFrame(() => tokenField.current?.focus());
  };

  return (
    <Box component="section" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1.25, minWidth: 0 }}>
      <Typography variant="subtitle2" component="h4" sx={{ m: 0, fontWeight: 600 }}>
        Web2 admin
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.25, mb: 1, overflowWrap: 'anywhere' }}>
        {ADMIN_LINK_GROUP_LEAD}
      </Typography>

      {availability === 'absent' || availability === 'unread' ? (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {availability === 'absent' ? ADMIN_LINK_ABSENT : ADMIN_LINK_UNREAD}
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>
          <FormControlLabel
            control={<Switch size="small" checked={choice.on} onChange={(event) => set({ on: event.target.checked })} />}
            label={<Typography variant="body2">{ADMIN_LINK_SWITCH_LABEL}</Typography>}
          />

          {choice.on ? (
            <>
              <TextField
                size="small"
                fullWidth
                label="Web2 admin address"
                value={choice.url}
                placeholder="https://admin.example.com"
                error={urlProblem !== null}
                helperText={urlProblem ?? 'Where the uploader reaches the web2 admin.'}
                onChange={(event) => set({ url: event.target.value })}
                inputProps={{ ...PLAIN_TEXT_INPUT, inputMode: 'url', 'aria-label': 'Web2 admin address' }}
              />
              <ChoiceGroup
                name="wizard-admin-token"
                value={choice.tokenSource}
                onChange={(tokenSource) => set({ tokenSource })}
                choices={[
                  {
                    value: 'stored',
                    title: "The manager's stored token",
                    detail: storedTokenDetail(tokenStored),
                    disabled: !tokenStored,
                  },
                  {
                    value: 'typed',
                    title: 'A token typed here',
                    detail: "The web2 admin's INTERNAL_API_TOKEN, at least 32 characters.",
                    extra: (
                      <TextField
                        size="small"
                        fullWidth
                        type="password"
                        value={choice.token}
                        placeholder="Type the token"
                        error={tokenProblem !== null}
                        helperText={tokenProblem ?? undefined}
                        onChange={(event) => set({ token: event.target.value })}
                        inputRef={tokenField}
                        inputProps={{ ...PLAIN_TEXT_INPUT, autoComplete: NEW_PASSWORD, 'aria-label': 'Web2 admin token' }}
                      />
                    ),
                  },
                ]}
              />
              {elsewhere && (
                <Alert
                  severity="warning"
                  data-stored-token-elsewhere
                  sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
                  action={
                    <Button color="inherit" size="small" onClick={typeTokenHere}>
                      {TYPE_TOKEN_HERE}
                    </Button>
                  }
                >
                  {STORED_TOKEN_ELSEWHERE}
                </Alert>
              )}
              <AdminLinkTest
                run={testRequest ? () => testAdminLink(testRequest) : null}
                blockedReason={elsewhere ? 'Type the token for this address to test it.' : 'Give the address and a token to test the link.'}
                resetKey={JSON.stringify([choice.url, choice.tokenSource, choice.token, testRequest?.feedOwner ?? null])}
              />
            </>
          ) : (
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {ADMIN_LINK_OFF_NOTE}
            </Typography>
          )}
        </Stack>
      )}
    </Box>
  );
}
