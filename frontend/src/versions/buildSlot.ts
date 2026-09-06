import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Which version the Versions page is building, in one place.
 *
 * The manager builds one version at a time and answers a second request with a
 * 409, so the table's Update buttons and the Add form have to agree on whether
 * a build is running. They each held their own flag, so the form happily
 * started a build during an Update and the operator learned it was refused
 * after typing a branch and pressing the button.
 */
/** Why an action on another version has to wait, in the table and in the form. */
export const ANOTHER_BUILDING =
  'Another version is building. Wait for it to finish.';

export interface BuildSlot {
  /** The version building right now, or null when nothing is. */
  buildingName: string | null;
  setBuildingName: (name: string | null) => void;
}

const BuildSlotContext = createContext<BuildSlot | null>(null);

export const BuildSlotProvider = BuildSlotContext.Provider;

export function useBuildSlot(): BuildSlot {
  const slot = useContext(BuildSlotContext);
  if (!slot) {
    throw new Error('useBuildSlot must be used inside BuildSlotProvider');
  }
  return slot;
}

/**
 * Hands out one abort signal per build and ends the build in flight when the
 * component goes away.
 *
 * A build streams for minutes. Without this, navigating away mid-build leaves
 * the fetch and its reader running against a response nothing renders, and the
 * page keeps a connection open until the manager closes it.
 */
export function useBuildAbort(): () => AbortSignal {
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  return () => {
    controller.current?.abort();
    controller.current = new AbortController();
    return controller.current.signal;
  };
}
