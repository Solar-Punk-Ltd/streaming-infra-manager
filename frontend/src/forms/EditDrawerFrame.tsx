import {
  Alert,
  Box,
  Button,
  Drawer,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { ReactNode } from 'react';

const WIDTH = 480;

/**
 * The frame both edit drawers share: a title, a scrolling body, and a footer
 * whose one primary button says what saving does.
 */
export function EditDrawerFrame({
  title,
  saving,
  error,
  saveDisabled,
  onSave,
  onClose,
  children,
}: {
  title: string;
  saving: boolean;
  error: string | null;
  saveDisabled: boolean;
  onSave: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = () => {
    if (!saving) onClose();
  };

  return (
    <Drawer anchor="right" open onClose={close}>
      <Stack sx={{ width: { xs: '100vw', sm: WIDTH }, height: '100%' }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ px: 2.5, py: 1.75, borderBottom: 1, borderColor: 'divider' }}
        >
          <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
            {title}
          </Typography>
          <IconButton onClick={close} aria-label="close" size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, overflowY: 'auto', px: 2.5, py: 2.5 }}>
          <Stack spacing={2.5}>
            {children}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ px: 2.5, py: 1.75, borderTop: 1, borderColor: 'divider' }}
        >
          <Button onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button variant="contained" onClick={onSave} disabled={saving || saveDisabled}>
            Save and redeploy
          </Button>
        </Stack>
      </Stack>
    </Drawer>
  );
}
