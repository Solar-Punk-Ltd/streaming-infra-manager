/**
 * Where a config file rollout stands, shared by the manager that runs it, the
 * card that reports it and the offline mock that plays it.
 *
 * A rollout is one apply or reset: the file is stored, the engine is
 * recreated on it and then watched for a while, and the previous file comes
 * back if the engine does not stay up. The row carries the state of the
 * deployment's latest rollout as `engine_config_state`, and in
 * `engine_config_error` why one did not end applied, or a note from a check
 * that ran after one that did.
 */
export const ENGINE_CONFIG_STATES = [
  'applying',
  'watching',
  'applied',
  'reverting',
  'reverted',
  'failed',
  'interrupted',
  'superseded',
] as const;

export type EngineConfigState = (typeof ENGINE_CONFIG_STATES)[number];

/**
 * What the operator can do from a rollout that did not finish: verify what is
 * stored again, or go back to the file an interrupted rollout replaced.
 */
export type RolloutAction = 'verify' | 'previous';

export interface RolloutNotice {
  severity: 'info' | 'warning' | 'error';
  /** The one line the card leads with. */
  title: string;
  /** Whether the row's `engine_config_error` is the rest of the story. */
  showsReason: boolean;
  offers: readonly RolloutAction[];
}

export interface RolloutSubject {
  /** The engine as the card names it. */
  engine: string;
  /** Whether the row stores a file, or runs the template. */
  hasConfig: boolean;
}

/**
 * The card's notice for a rollout state, or null when there is nothing to
 * say. `reason` is the row's `engine_config_error`: for an applied rollout it
 * is a note from the check that ran after the apply, shown as a diagnosis.
 */
export function rolloutNotice(
  state: EngineConfigState | null,
  subject: RolloutSubject,
  reason: string | null,
): RolloutNotice | null {
  switch (state) {
    case null:
      return null;
    case 'applied':
      return reason
        ? {
            severity: 'info',
            title: 'Applied, with a note from the check that ran after it.',
            showsReason: true,
            offers: [],
          }
        : null;
    case 'applying':
      return {
        severity: 'info',
        title: `Recreating ${subject.engine} on the ${subject.hasConfig ? 'new config file' : 'template'}.`,
        showsReason: false,
        offers: [],
      };
    case 'watching':
      return {
        severity: 'info',
        title: `Verifying: ${subject.engine} is watched for a while on the new config file, and the previous one comes back if it does not stay up.`,
        showsReason: false,
        offers: [],
      };
    case 'reverting':
      return {
        severity: 'warning',
        title: 'Putting the previous config file back.',
        showsReason: true,
        offers: [],
      };
    case 'reverted':
      return {
        severity: 'warning',
        title: 'The last config file was reverted.',
        showsReason: true,
        offers: [],
      };
    case 'failed':
      return {
        severity: 'error',
        title: 'The last config file could not be applied.',
        showsReason: true,
        offers: ['verify'],
      };
    case 'interrupted':
      return {
        severity: 'warning',
        title: 'The rollout was interrupted by a manager restart.',
        showsReason: true,
        offers: ['verify', 'previous'],
      };
    case 'superseded':
      return {
        severity: 'info',
        title: 'The last config file was not verified.',
        showsReason: true,
        offers: ['verify'],
      };
  }
}
