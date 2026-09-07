import { useState } from 'react';
import { Button, TextField, Typography } from '@mui/material';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import { SectionCard } from '../components/SectionCard';
import { updateNotes } from '../data';
import { FormField } from '../forms/FormField';
import { notesProblem } from '../forms/validation';

/**
 * The notes, edited in place and saved on their own: no claim on the
 * deployment and no deploy, so a note can be saved while a stamp is invalid
 * or a node is unfunded. The save carries the revision the note had when
 * editing began, not the live one, which the event stream moves the moment
 * someone else saves. A note saved elsewhere since is then a refusal from
 * the manager, not an overwrite.
 */
export function NotesCard({
  name,
  notes,
  notesRevision,
}: {
  name: string;
  notes: string | null;
  notesRevision: number;
}) {
  const { mergeProfiles } = useDeployments();
  const toast = useToast();
  /** The text being edited and the revision it started from, or null while the card only shows the note. */
  const [editing, setEditing] = useState<{ draft: string; startedAt: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = editing?.draft ?? null;
  const problem = draft === null ? null : notesProblem(draft);
  const unchanged = draft !== null && draft.trim() === (notes ?? '').trim();

  const stopEditing = () => {
    setEditing(null);
    setError(null);
  };

  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateNotes(name, editing.draft.trim() || null, editing.startedAt);
      mergeProfiles([saved]);
      setEditing(null);
      toast('Notes saved.');
    } catch (caught) {
      setError(getErrorMessage(caught, 'failed to save the notes'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Notes"
      actions={
        draft === null ? (
          <Button
            size="small"
            onClick={() => setEditing({ draft: notes ?? '', startedAt: notesRevision })}
          >
            Edit
          </Button>
        ) : (
          <>
            <Button size="small" onClick={stopEditing} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void save()}
              disabled={saving || problem !== null || unchanged}
            >
              Save
            </Button>
          </>
        )
      }
    >
      {draft === null ? (
        <Typography
          variant="body2"
          color={notes ? 'text.primary' : 'text.secondary'}
        >
          {notes || 'No notes yet. Add one under Edit to say what this is for.'}
        </Typography>
      ) : (
        <FormField label="Notes" error={problem ?? error}>
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={2}
            autoFocus
            value={draft}
            onChange={(event) =>
              setEditing((current) => current && { ...current, draft: event.target.value })
            }
            placeholder="What this deployment is for"
          />
        </FormField>
      )}
    </SectionCard>
  );
}
