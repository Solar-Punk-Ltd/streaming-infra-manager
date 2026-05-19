export function nullify<T extends object>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> | null } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    out[key] = v === undefined ? null : v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> | null };
}
