import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  type Editors,
  EditorsProvider,
  type WizardPrefill,
} from '../app/EditorsContext';
import { EditDeploymentDrawer } from './EditDeploymentDrawer';
import { EditGroupDrawer } from './EditGroupDrawer';
import { NewDeploymentWizard } from './wizard/NewDeploymentWizard';

/** Whichever form is open, if any. Only ever one at a time. */
type OpenEditor = (
  | { kind: 'wizard'; prefill?: WizardPrefill }
  | { kind: 'deployment'; name: string }
  | { kind: 'group'; id: number }
) & {
  /**
   * Bumped on every open, and used as the form's React key.
   *
   * A form holds the choices being made in its own state, so opening one has
   * to give a fresh instance. Without the key, opening the wizard again while
   * one is already up would reuse the half-filled state, and a prefill would
   * land on top of choices from the last time.
   */
  seq: number;
};

/**
 * Owns the wizard and the two edit drawers, and hands every page the three
 * functions that open them.
 *
 * Mounted above the shell so a row, a page header and a pool card all reach the
 * same forms, and so the forms outlive the row that opened them: a list that
 * re-sorts while a drawer is open must not unmount what is being typed into.
 */
export function EditorsHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenEditor | null>(null);
  const nextSeq = useRef(0);

  const editors = useMemo<Editors>(() => {
    const seq = () => ++nextSeq.current;
    return {
      openWizard: (prefill) => setOpen({ kind: 'wizard', prefill, seq: seq() }),
      openEditDeployment: (name) => setOpen({ kind: 'deployment', name, seq: seq() }),
      openEditGroup: (id) => setOpen({ kind: 'group', id, seq: seq() }),
    };
  }, []);

  const close = useCallback(() => setOpen(null), []);

  return (
    <EditorsProvider value={editors}>
      {children}
      {open?.kind === 'wizard' && (
        <NewDeploymentWizard key={open.seq} prefill={open.prefill} onClose={close} />
      )}
      {open?.kind === 'deployment' && (
        <EditDeploymentDrawer key={open.seq} name={open.name} onClose={close} />
      )}
      {open?.kind === 'group' && (
        <EditGroupDrawer key={open.seq} id={open.id} onClose={close} />
      )}
    </EditorsProvider>
  );
}
