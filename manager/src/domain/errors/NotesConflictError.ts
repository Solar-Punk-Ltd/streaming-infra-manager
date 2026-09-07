/** A notes save whose loaded revision has moved: another save landed first. */
export class NotesConflictError extends Error {
  constructor(public readonly profileName: string) {
    super(
      `The notes of ${profileName} changed since this page loaded. Reload to see them, then save again.`,
    );
    this.name = 'NotesConflictError';
  }
}
