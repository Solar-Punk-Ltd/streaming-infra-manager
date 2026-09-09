import { Button, Stack, Typography } from '@mui/material';

import type { StackSettingsFile } from '@streaming-infra-manager/common';

import { CodeTextArea } from '../components/CodeTextArea';
import { SectionCard } from '../components/SectionCard';

import { SettingsEntryField } from './SettingsEntryField';
import type { SettingsDraftFile } from './settingsDraft';

/** What each file of the set is for, in the words an operator needs. */
const FILE_SUBS: Record<string, string> = {
  '.env': 'The base environment every service of this version reads',
  'deploy/config.json': 'What the deploy scripts read before they start anything',
};

function subFor(path: string): string {
  return FILE_SUBS[path] ?? `The environment of the ${path.split('/')[1]} engine`;
}

/** One file of a version's settings: its keys, or its text. */
export function SettingsFileCard({
  file,
  draft,
  disabled,
  onEntryChange,
  onEntryRemove,
  onTextChange,
}: {
  file: StackSettingsFile;
  draft: SettingsDraftFile | undefined;
  disabled: boolean;
  onEntryChange: (key: string, value: string) => void;
  onEntryRemove: (key: string) => void;
  onTextChange: (text: string) => void;
}) {
  if (file.kind === 'json') {
    const text = draft?.kind === 'json' ? draft.text : file.text;
    return (
      <SectionCard
        title={file.path}
        sub={subFor(file.path)}
        actions={
          file.sampleText !== null && (
            <Button
              size="small"
              disabled={disabled || text === file.sampleText}
              onClick={() => onTextChange(file.sampleText ?? '')}
            >
              Reset to sample
            </Button>
          )
        }
      >
        <CodeTextArea
          value={text}
          onChange={onTextChange}
          readOnly={disabled}
          minHeight={280}
          ariaLabel={file.path}
        />
      </SectionCard>
    );
  }

  const values = draft?.kind === 'env' ? draft.values : {};
  const removed = draft?.kind === 'env' ? draft.removed : [];
  return (
    <SectionCard title={file.path} sub={subFor(file.path)}>
      {file.entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          This file assigns nothing yet.
        </Typography>
      ) : (
        <Stack component="ul" sx={{ m: 0, p: 0, minWidth: 0 }}>
          {file.entries.map((entry) => (
            <SettingsEntryField
              key={entry.key}
              entry={entry}
              value={values[entry.key] ?? entry.value}
              disabled={disabled}
              removed={removed.includes(entry.key)}
              onChange={(value) => onEntryChange(entry.key, value)}
              onRemove={() => onEntryRemove(entry.key)}
            />
          ))}
        </Stack>
      )}
    </SectionCard>
  );
}
