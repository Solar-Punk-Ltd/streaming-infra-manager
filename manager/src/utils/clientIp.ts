import { Request } from 'express';

const UNKNOWN_IP = 'unknown';

/**
 * The address to hold responsible for a request.
 *
 * The last hop of `X-Forwarded-For` on purpose, not the first: nginx appends
 * the address it actually saw, so the last entry is the one no client can
 * forge, while anything earlier in the list is whatever the caller sent.
 */
export function clientIpOf(req: Request): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : header;

  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    const lastHop = hops[hops.length - 1];
    if (lastHop) return lastHop;
  }

  return req.socket.remoteAddress ?? UNKNOWN_IP;
}
