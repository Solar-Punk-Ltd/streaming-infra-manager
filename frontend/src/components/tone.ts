import type { Theme } from '@mui/material/styles';

/** How urgent something is, in the five levels every pill, dot and banner uses. */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'gray';

type TonePalette = 'success' | 'warning' | 'error' | 'info';

const TONE_PALETTE: Record<Exclude<Tone, 'gray'>, TonePalette> = {
  ok: 'success',
  warn: 'warning',
  err: 'error',
  info: 'info',
};

const TINT = 0.14;
const BANNER_TINT = 0.1;

export function toneMainColor(theme: Theme, tone: Tone): string {
  if (tone === 'gray') return theme.vars.palette.text.secondary;
  return theme.vars.palette[TONE_PALETTE[tone]].main;
}

function toneTint(theme: Theme, tone: Tone, alpha: number): string {
  if (tone === 'gray') return theme.vars.palette.action.hover;
  return `rgba(${theme.vars.palette[TONE_PALETTE[tone]].mainChannel} / ${alpha})`;
}

/** Text and background for a pill: the tone's colour on a wash of itself. */
export function tonePillStyles(theme: Theme, tone: Tone) {
  return {
    color: toneMainColor(theme, tone),
    backgroundColor: toneTint(theme, tone, TINT),
  };
}

/** Background for a full-width result banner, where the text stays readable. */
export function toneBannerStyles(theme: Theme, tone: Tone) {
  return {
    backgroundColor: toneTint(theme, tone, BANNER_TINT),
    borderColor: toneTint(theme, tone, TINT * 2),
  };
}
