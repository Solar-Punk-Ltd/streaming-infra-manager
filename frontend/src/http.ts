export async function extractApiError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const err = (await res.json()) as { error?: string; message?: string };
    return err.message ?? err.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(await extractApiError(res, `request failed (${res.status})`));
  }
  return (await res.json()) as T;
}
