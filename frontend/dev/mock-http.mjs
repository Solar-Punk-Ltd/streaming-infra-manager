/**
 * The three helpers every mock route needs: writing a JSON answer, reading a
 * JSON body, and reading the Cookie header. Shared by mock-manager.mjs and
 * mock-auth.mjs so neither keeps its own copy.
 */

export function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** 204 has no body, and a browser reads a Set-Cookie off it just the same. */
export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const pair of (header ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (name) cookies.set(name, pair.slice(separator + 1).trim());
  }
  return cookies;
}
