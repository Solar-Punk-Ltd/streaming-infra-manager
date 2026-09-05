import { Button, Typography } from '@mui/material';

import { useEditors } from '../app/EditorsContext';
import { SectionCard } from '../components/SectionCard';

export function NotesCard({
  name,
  notes,
}: {
  name: string;
  notes: string | null;
}) {
  const { openEditDeployment } = useEditors();

  return (
    <SectionCard
      title="Notes"
      actions={
        <Button size="small" onClick={() => openEditDeployment(name)}>
          Edit
        </Button>
      }
    >
      <Typography
        variant="body2"
        color={notes ? 'text.primary' : 'text.secondary'}
      >
        {notes || 'No notes yet. Add one under Edit to say what this is for.'}
      </Typography>
    </SectionCard>
  );
}
