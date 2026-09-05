export async function extractApiError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const err = (await res.json()) as {
      error?: string;
      message?: string;
      errors?: string[];
    };
    // `errors` first: it is where every 400 puts the only useful text. The
    // validation middleware answers {error:'validation_error', errors:[...]},
    // and so does ProfileConfigError. Reading `error` ahead of it showed the
    // operator the literal string "validation_error" and threw the reason
    // away, so "bee_publishers is required for a abr-uploader" arrived as a
    // single word carrying no information.
    if (err.errors?.length) return err.errors.join('. ');
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
