import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { useSession } from '../app/useSession';
import { CopyBox } from '../components/CopyBox';

import { FIRST_USER_COMMAND, SIGN_IN_MESSAGES } from './messages';

const CARD_WIDTH = 380;

/** What the page says above the form, for each way of arriving signed out. */
const NOTICES = {
  ended: SIGN_IN_MESSAGES.sessionEnded,
  noUsers: SIGN_IN_MESSAGES.noUsers,
  unreachable: SIGN_IN_MESSAGES.unreachable,
  notSignedIn: null,
} as const;

/** The frame both signed-out screens sit in, centred on the page. */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'grid',
        placeItems: 'center',
        px: 2,
        py: 6,
      }}
    >
      <Box sx={{ width: '100%', maxWidth: CARD_WIDTH }}>{children}</Box>
    </Box>
  );
}

export function CheckingSession() {
  return (
    <AuthFrame>
      <Stack spacing={2} alignItems="center">
        <CircularProgress size={26} />
        <Typography variant="body2" color="text.secondary">
          Checking your session
        </Typography>
      </Stack>
    </AuthFrame>
  );
}

export function SignInPage() {
  const session = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reason =
    session.state.status === 'signedOut' ? session.state.reason : 'notSignedIn';
  const notice = NOTICES[reason];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    const result = await session.signIn(username.trim(), password);
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      setPassword('');
    }
  };

  return (
    <AuthFrame>
      <Paper sx={{ p: 3 }}>
        <Stack spacing={2.5} component="form" onSubmit={submit}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Box
              sx={{
                width: 30,
                height: 30,
                borderRadius: 2,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              SI
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                Streaming Infra
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Sign in to the manager
              </Typography>
            </Box>
          </Stack>

          {notice && (
            <Alert severity={reason === 'noUsers' ? 'info' : 'warning'}>
              <Stack spacing={1}>
                <span>{notice}</span>
                {reason === 'noUsers' && (
                  <CopyBox value={FIRST_USER_COMMAND} />
                )}
              </Stack>
            </Alert>
          )}

          <TextField
            label="Username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            disabled={pending}
            // A username is lower case by database constraint, and a phone
            // capitalises the first letter of a text field by default.
            slotProps={{
              htmlInput: {
                autoCapitalize: 'none',
                autoCorrect: 'off',
                spellCheck: false,
              },
            }}
            autoFocus
            fullWidth
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={pending}
            fullWidth
          />

          {error && <Alert severity="error">{error}</Alert>}

          <Button
            type="submit"
            variant="contained"
            disabled={pending || username.trim() === '' || password === ''}
          >
            {pending ? 'Signing in' : 'Sign in'}
          </Button>
        </Stack>
      </Paper>
    </AuthFrame>
  );
}
