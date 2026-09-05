import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';

import { StatusDot } from '../components/StatusDot';
import { useEditors } from './EditorsContext';

export function TopBar({
  title,
  showSearch,
  search,
  onSearchChange,
  connected,
  onOpenNav,
}: {
  title: string;
  showSearch: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  connected: boolean;
  onOpenNav: () => void;
}) {
  const { openWizard } = useEditors();

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      sx={{
        px: { xs: 2, md: 3.5 },
        py: 1.75,
        position: 'sticky',
        top: 0,
        zIndex: 5,
        bgcolor: 'background.default',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <IconButton
        aria-label="open navigation"
        onClick={onOpenNav}
        sx={{ display: { md: 'none' } }}
      >
        <MenuIcon />
      </IconButton>
      <Typography variant="h2" component="h1">
        {title}
      </Typography>
      <Box sx={{ flexGrow: 1 }} />

      {showSearch && (
        <TextField
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search deployments"
          sx={{ width: { xs: 150, sm: 260 } }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      )}

      <Tooltip
        title={
          connected
            ? 'Live. Changes appear as the manager reports them.'
            : 'Not connected to the manager event stream. Reload the page.'
        }
      >
        <Stack direction="row" spacing={0.75} alignItems="center">
          <StatusDot tone={connected ? 'ok' : 'err'} />
          <Typography variant="caption" color="text.secondary">
            {connected ? 'live' : 'offline'}
          </Typography>
        </Stack>
      </Tooltip>

      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={() => openWizard()}
        sx={{ flex: 'none' }}
      >
        New deployment
      </Button>
    </Stack>
  );
}
