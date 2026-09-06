/**
 * The cross-site check, one row per combination of the three headers it reads.
 *
 * Unit test, no server. This is the layer that stops a page on another site
 * making the operator's browser deploy, stop or remove something with the
 * operator's own cookie. `SameSite=Lax` is the first layer and this is the
 * second, so it has to hold on its own: every case below is written as if the
 * cookie had been sent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REQUESTED_WITH_VALUE } from '@streaming-infra-manager/common';

import {
  crossSiteReason,
  type RequestOrigin,
} from '../../src/api/middleware/requireSameSite.js';

const HOST = 'manager.example';

function request(overrides: Partial<RequestOrigin> = {}): RequestOrigin {
  return {
    method: 'POST',
    host: HOST,
    origin: `https://${HOST}`,
    secFetchSite: 'same-origin',
    requestedWith: REQUESTED_WITH_VALUE,
    ...overrides,
  };
}

describe('crossSiteReason', () => {
  it('lets a write from our own page through', () => {
    assert.equal(crossSiteReason(request()), null);
  });

  it('lets reads through whatever they look like', () => {
    for (const method of ['GET', 'get', 'HEAD']) {
      assert.equal(
        crossSiteReason(
          request({
            method,
            origin: 'https://evil.example',
            secFetchSite: 'cross-site',
            requestedWith: undefined,
          }),
        ),
        null,
        `${method} must not be refused: EventSource opens the live streams with no headers`,
      );
    }
  });

  it('refuses a write the browser calls cross-site', () => {
    assert.match(
      crossSiteReason(request({ secFetchSite: 'cross-site' })) ?? '',
      /Sec-Fetch-Site/,
    );
  });

  it('accepts the other Sec-Fetch-Site values', () => {
    for (const secFetchSite of ['same-origin', 'same-site', 'none', undefined]) {
      assert.equal(
        crossSiteReason(request({ secFetchSite })),
        null,
        `Sec-Fetch-Site: ${secFetchSite} is not cross-site`,
      );
    }
  });

  it('refuses a write whose Origin names another site', () => {
    for (const origin of [
      'https://evil.example',
      'https://manager.example.evil.example',
      'https://manager.example:8443',
      'null',
      '',
    ]) {
      assert.match(
        crossSiteReason(request({ origin })) ?? '',
        /Origin/,
        `should refuse Origin: ${origin}`,
      );
    }
  });

  it('accepts our own host over either scheme, because the edge terminates TLS', () => {
    for (const origin of [`https://${HOST}`, `http://${HOST}`]) {
      assert.equal(crossSiteReason(request({ origin })), null, origin);
    }
  });

  it('matches Origin against the host including its port', () => {
    assert.equal(
      crossSiteReason(
        request({ host: 'localhost:5080', origin: 'http://localhost:5080' }),
      ),
      null,
    );
    assert.match(
      crossSiteReason(
        request({ host: 'localhost:5080', origin: 'http://localhost:9876' }),
      ) ?? '',
      /Origin/,
    );
  });

  it('refuses a write with no Origin and no header, which is where old browsers land', () => {
    assert.match(
      crossSiteReason(
        request({
          origin: undefined,
          secFetchSite: undefined,
          requestedWith: undefined,
        }),
      ) ?? '',
      /x-requested-with/,
    );
  });

  it('refuses the header set to anything but our value', () => {
    for (const requestedWith of ['XMLHttpRequest', '', 'Streaming-Infra-Manager']) {
      assert.match(
        crossSiteReason(request({ requestedWith })) ?? '',
        /x-requested-with/,
        `should refuse ${JSON.stringify(requestedWith)}`,
      );
    }
  });

  it('refuses a write with no Host to compare against', () => {
    assert.match(crossSiteReason(request({ host: undefined })) ?? '', /Origin/);
  });

  it('refuses every other method that changes something', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.match(
        crossSiteReason(request({ method, requestedWith: undefined })) ?? '',
        /x-requested-with/,
        `${method} must be checked`,
      );
    }
  });
});
