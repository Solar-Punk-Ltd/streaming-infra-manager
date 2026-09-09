/**
 * The edit lock of a version's config root was still held when the wait ran
 * out. `stack-config-edit.sh` holds it for a whole ssh edit, and every route
 * that reads or writes these files waits for it, so this is an ordinary
 * outcome rather than a fault: the message says what holds it and how to get
 * it back if the editor is gone.
 */
export class HostConfigLockHeldError extends Error {
  constructor(
    public readonly root: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostConfigLockHeldError';
  }
}
