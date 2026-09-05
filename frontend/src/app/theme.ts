import { createTheme } from '@mui/material/styles';

// Tells the compiler what `cssVariables` below turns on at runtime: `theme.vars`
// and the per-colour `*Channel` tokens the tinted pills mix their background from.
declare module '@mui/material/styles' {
  interface CssThemeVariables {
    enabled: true;
  }
}

export const MONO_STACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const SANS_STACK =
  '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const PILL_RADIUS = 99;

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data' },
  colorSchemes: {
    light: {
      palette: {
        mode: 'light',
        background: { default: '#f4f5f7', paper: '#ffffff' },
        primary: { main: '#3b5bfd' },
        success: { main: '#158f52' },
        warning: { main: '#b56e00' },
        error: { main: '#cf3238' },
        info: { main: '#2a7fd4' },
        text: { primary: '#14171d', secondary: '#4b5563' },
        divider: '#e2e5ea',
      },
    },
    dark: {
      palette: {
        mode: 'dark',
        background: { default: '#0e1014', paper: '#161920' },
        primary: { main: '#6f88ff' },
        success: { main: '#3bd27f' },
        warning: { main: '#f2b43c' },
        error: { main: '#ff6b6f' },
        info: { main: '#63a9ff' },
        text: { primary: '#e9ebf1', secondary: '#aab1c0' },
        divider: '#252a35',
      },
    },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: SANS_STACK,
    fontSize: 14,
    body1: { fontSize: '0.875rem' },
    body2: { fontSize: '0.8125rem' },
    h1: { fontSize: '1.375rem', fontWeight: 600 },
    h2: { fontSize: '1.25rem', fontWeight: 600 },
    h3: { fontSize: '1.125rem', fontWeight: 600 },
    h6: { fontSize: '0.9375rem', fontWeight: 600 },
    subtitle2: { fontSize: '0.8125rem', fontWeight: 600 },
    caption: { fontSize: '0.75rem' },
    overline: { fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em' },
    button: { textTransform: 'none', fontWeight: 500 },
  },
  components: {
    MuiPaper: {
      defaultProps: { variant: 'outlined' },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none', borderRadius: 8 } },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: PILL_RADIUS, fontWeight: 500 },
        sizeSmall: { height: 22 },
      },
    },
    MuiTable: { defaultProps: { size: 'small' } },
    MuiTableCell: {
      styleOverrides: {
        root: { paddingTop: 10, paddingBottom: 10 },
        head: {
          fontSize: '0.6875rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--mui-palette-text-secondary)',
        },
      },
    },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiTooltip: { defaultProps: { enterDelay: 400 } },
    MuiLink: { defaultProps: { underline: 'hover' } },
  },
});
