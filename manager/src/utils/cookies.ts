/**
 * The cookies on a request, by name.
 *
 * A Map rather than an object: cookie names come from the network and a name
 * like `__proto__` must stay an ordinary key. Malformed pairs are skipped
 * rather than throwing, because a browser sends whatever it was given and one
 * bad cookie must not refuse the request.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    if (name === '') continue;

    const raw = pair.slice(separator + 1).trim();
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;

    cookies.set(name, decodeValue(unquoted));
  }

  return cookies;
}

function decodeValue(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
