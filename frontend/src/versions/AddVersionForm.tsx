import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  getErrorMessage,
  stackRefProblem,
  stackVersionNameProblem,
  versionNameFromRef,
} from '@streaming-infra-manager/common';

import { SectionCard } from '../components/SectionCard';

import { BuildLogPane } from './BuildLogPane';
import { ANOTHER_BUILDING, useBuildAbort, useBuildSlot } from './buildSlot';
import { addVersion, type BuildLine } from './versionsApi';

const REF_HELP =
  'A branch or a tag of swarm-hls-stream, for example main-v3. The version stays on the commit that branch points at today, and moves only when you press Update.';

const NAME_HELP =
  'Lower case letters, digits and dashes. Taken from the branch until you type your own.';

const NO_NAME_FROM_REF = 'The branch gave no usable name. Type one.';

/**
 * Why the name box is red, or null.
 *
 * A branch of nothing but punctuation, `///` say, leaves no name behind. That
 * used to disable the button with no word about why, so the operator was left
 * looking at a filled in form and a button that would not move.
 */
function nameProblemFor(
  ref: string,
  name: string,
  typed: boolean,
): string | null {
  if (name !== '') return stackVersionNameProblem(name);
  if (ref !== '' && !typed) return NO_NAME_FROM_REF;
  return null;
}

/**
 * Adding a version: a branch or tag, a name, and the build that follows.
 *
 * The name follows the branch until it is typed over, because that is what it
 * usually should be and a version named after something else is hard to place
 * again months later.
 */
export function AddVersionForm({ onBuilt }: { onBuilt: () => void }) {
  const { buildingName, setBuildingName } = useBuildSlot();
  const signalForBuild = useBuildAbort();
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [lines, setLines] = useState<BuildLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const suggested = versionNameFromRef(ref);
  const effectiveName = nameTouched ? name : suggested;

  const refProblem = ref === '' ? null : stackRefProblem(ref);
  const nameProblem = nameProblemFor(ref, effectiveName, nameTouched);
  const ready =
    ref !== '' && effectiveName !== '' && !refProblem && !nameProblem;
  // The manager builds one version at a time, so an Update running in the
  // table is a build this form cannot start beside.
  const elsewhere = buildingName !== null && buildingName !== effectiveName;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || running || elsewhere) return;

    const signal = signalForBuild();
    setRunning(true);
    setBuildingName(effectiveName);
    setError(null);
    setDone(null);
    setLines([]);
    try {
      const result = await addVersion(
        effectiveName,
        ref,
        { onLine: (line) => setLines((prev) => [...prev, line]) },
        signal,
      );
      if (result.code === 0) {
        setDone(`${effectiveName} is built and ready to deploy from.`);
        setRef('');
        setName('');
        setNameTouched(false);
      } else {
        setError(
          'The build failed. The last lines above say why. Fix the branch or the host and try again.',
        );
      }
      onBuilt();
    } catch (caught) {
      // An aborted build is this page going away, not a failure to report.
      if (!signal.aborted) {
        setError(getErrorMessage(caught));
        onBuilt();
      }
    } finally {
      if (!signal.aborted) {
        setRunning(false);
        setBuildingName(null);
      }
    }
  };

  return (
    <SectionCard title="Add version">
      <Stack spacing={2} component="form" onSubmit={submit}>
        <Typography variant="body2" color="text.secondary">
          A version is a branch or tag of the streaming stack, checked out and
          built once on this host. Adding one takes a few minutes and changes
          nothing about the deployments already running.
        </Typography>

        <TextField
          label="Branch or tag"
          value={ref}
          onChange={(event) => setRef(event.target.value.trim())}
          error={Boolean(refProblem)}
          helperText={refProblem ?? REF_HELP}
          disabled={running || elsewhere}
          autoComplete="off"
          slotProps={{
            htmlInput: {
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
            },
          }}
          fullWidth
        />
        <TextField
          label="Name"
          value={effectiveName}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value.trim());
          }}
          error={Boolean(nameProblem)}
          helperText={nameProblem ?? NAME_HELP}
          disabled={running || elsewhere}
          autoComplete="off"
          fullWidth
        />

        {(running || lines.length > 0) && (
          <BuildLogPane lines={lines} running={running} />
        )}

        {error && <Alert severity="error">{error}</Alert>}
        {done && <Alert severity="success">{done}</Alert>}

        <Stack direction="row" justifyContent="flex-end" spacing={1}>
          {!running && lines.length > 0 && (
            <Button
              onClick={() => {
                setLines([]);
                setError(null);
                setDone(null);
              }}
            >
              Dismiss the log
            </Button>
          )}
          <Tooltip title={elsewhere ? ANOTHER_BUILDING : ''}>
            <Box component="span">
              <Button
                type="submit"
                variant="contained"
                disabled={!ready || running || elsewhere}
              >
                {running ? 'Building' : 'Add version'}
              </Button>
            </Box>
          </Tooltip>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
