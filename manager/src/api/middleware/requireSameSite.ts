import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '@streaming-infra-manager/common';
import { NextFunction, Request, Response } from 'express';

import { CrossSiteRequestError } from '../../domain/errors/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

const CROSS_SITE = 'cross-site';

/** What a request says about where it came from. */
export interface RequestOrigin {
  method: string;
  /** The `Host` the request was addressed to. */
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  requestedWith: string | undefined;
}

/**
 * Why this request must be refused as cross-site, or null when it may proceed.
 *
 * Reads on purpose are never refused: they change nothing, and both live
 * update streams are reads that `EventSource` opens with no headers of its own.
 */
export function crossSiteReason(request: RequestOrigin): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  if (request.secFetchSite?.toLowerCase() === CROSS_SITE) {
    return 'the browser reported Sec-Fetch-Site: cross-site';
  }

  if (request.origin !== undefined && !isOwnOrigin(request)) {
    return 'the Origin header names another site';
  }

  if (request.requestedWith !== REQUESTED_WITH_VALUE) {
    return `a write needs the ${REQUESTED_WITH_HEADER} header`;
  }

  return null;
}

/**
 * Compared by host and not by full origin: behind the edge the browser speaks
 * https while the manager is reached over http, so the schemes never match
 * while the host always does.
 */
function isOwnOrigin(request: RequestOrigin): boolean {
  if (!request.host) return false;
  try {
    return new URL(request.origin ?? '').host === request.host;
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requireSameSite(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const reason = crossSiteReason({
    method: req.method,
    host: req.headers.host,
    origin: headerValue(req.headers.origin),
    secFetchSite: headerValue(req.headers['sec-fetch-site']),
    requestedWith: headerValue(req.headers[REQUESTED_WITH_HEADER]),
  });

  next(reason ? new CrossSiteRequestError(reason) : undefined);
}
