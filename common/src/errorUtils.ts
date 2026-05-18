export function getErrorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;

  if (fallback !== undefined) return fallback;

  if (err === undefined || err === null) return 'undefined';

  return String(err);
}

export function getErrorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
