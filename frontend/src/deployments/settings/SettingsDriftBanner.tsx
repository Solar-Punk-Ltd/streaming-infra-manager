import { Alert, Button, Stack, Typography } from '@mui/material';

import { type DriftNotice, UNSAVED_NOT_APPLIED_NOTE } from './settingsText';

/**
 * What the running containers are behind on, above the list, with Apply
 * beside it while the deployment runs. Levi okayed this warning on
 * 2026-09-25. The button sits under the sentence rather than at the alert's
 * edge, because the sentence names every key and a phone has no room beside
 * it.
 */
export function SettingsDriftBanner({
  notice,
  unsaved,
  applyOffBecause,
  applying,
  onApply,
}: {
  notice: DriftNotice;
  /** Whether the draft holds changes, which Apply does not carry. */
  unsaved: boolean;
  /** Why Apply is greyed out, or an empty string. */
  applyOffBecause: string;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <Alert severity={notice.offersApply ? 'warning' : 'info'} sx={{ '& .MuiAlert-message': { minWidth: 0 } }}>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {notice.text}
      </Typography>
      {notice.offersApply && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <Button
            variant="contained"
            color="warning"
            size="small"
            disabled={applyOffBecause !== '' || applying}
            onClick={onApply}
          >
            Apply
          </Button>
          {(applyOffBecause || unsaved) && (
            <Typography variant="caption">{applyOffBecause || UNSAVED_NOT_APPLIED_NOTE}</Typography>
          )}
        </Stack>
      )}
    </Alert>
  );
}
