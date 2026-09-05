import { createContext, useContext } from 'react';

/** What the wizard should start from when it is opened from somewhere else. */
export interface WizardPrefill {
  goal?: 'stream' | 'viewer' | 'abr-pool' | 'abr-uploader' | 'custom';
  /** Profile name of the stream a new viewer should follow. */
  feedStreamer?: string;
  /** Group id of the pool a new ABR uploader should publish to. */
  poolId?: number;
  name?: string;
}

/**
 * The three places the shell hands off to a form.
 *
 * Held as a context so the rows, the page headers and the pool card call the
 * same three functions wherever they sit, rather than threading a prop through
 * every level. `EditorsHost` provides them.
 */
export interface Editors {
  openWizard: (prefill?: WizardPrefill) => void;
  openEditDeployment: (name: string) => void;
  openEditGroup: (id: number) => void;
}

const EditorsContext = createContext<Editors | null>(null);

export const EditorsProvider = EditorsContext.Provider;

export function useEditors(): Editors {
  const editors = useContext(EditorsContext);
  if (!editors) {
    throw new Error('useEditors must be used inside EditorsProvider');
  }
  return editors;
}
