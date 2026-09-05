import {
  Box,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useColorScheme } from '@mui/material/styles';

import { MONO_STACK } from './theme';
import { navigate, routes, type Route } from './router';

const NAV_ITEMS: { label: string; hash: string; pages: Route['page'][] }[] = [
  { label: 'Overview', hash: routes.overview, pages: ['overview'] },
  {
    label: 'Deployments',
    hash: routes.deployments,
    pages: ['deployments', 'deployment', 'group'],
  },
  { label: 'Host', hash: routes.host, pages: ['host'] },
];

type ThemeMode = 'system' | 'light' | 'dark';

const MODE_LABELS: Record<ThemeMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function Sidebar({
  route,
  deploymentCount,
  serverHost,
  onNavigate,
}: {
  route: Route;
  deploymentCount: number | null;
  serverHost: string;
  onNavigate?: () => void;
}) {
  return (
    <Stack sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2.25, pt: 2.25, pb: 1.75 }}>
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
            manager · {serverHost}
          </Typography>
        </Box>
      </Stack>

      <List sx={{ px: 1.25, py: 0.5 }}>
        {NAV_ITEMS.map((item) => (
          <ListItemButton
            key={item.label}
            selected={item.pages.includes(route.page)}
            onClick={() => {
              navigate(item.hash);
              onNavigate?.();
            }}
            sx={{ borderRadius: 2, mb: 0.25 }}
          >
            <ListItemText
              primaryTypographyProps={{ fontWeight: 500 }}
              primary={item.label}
            />
            {item.label === 'Deployments' && deploymentCount != null && (
              <Typography variant="caption" color="text.secondary">
                {deploymentCount}
              </Typography>
            )}
          </ListItemButton>
        ))}
      </List>

      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <Stack spacing={1} sx={{ p: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO_STACK }}>
          {serverHost}
        </Typography>
        <ThemeSwitch />
      </Stack>
    </Stack>
  );
}

function ThemeSwitch() {
  const { mode, setMode } = useColorScheme();

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Theme
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        fullWidth
        value={mode ?? 'system'}
        onChange={(_event, next: ThemeMode | null) => {
          if (next) setMode(next);
        }}
        sx={{ mt: 0.5 }}
      >
        {(Object.keys(MODE_LABELS) as ThemeMode[]).map((option) => (
          <ToggleButton key={option} value={option} sx={{ py: 0.4, fontSize: 12 }}>
            {MODE_LABELS[option]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}
