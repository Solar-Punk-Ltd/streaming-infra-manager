export class ChequebookProfileChangedError extends Error {
  constructor() {
    super('The deployment was removed or replaced. Review the saved transfer before starting another.');
    this.name = 'ChequebookProfileChangedError';
  }
}
