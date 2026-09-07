/**
 * What a port in the Containers card is, read off its key, tested without a
 * browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * Every port was a link to http://host:port, an SRT listener and a Swarm
 * peer port included. A link says "this opens in your browser", which is
 * false for those and misleading for an API kept behind the firewall.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { endpointAddress, endpointKindOf } from './endpoints';

describe('what a port is, by its key', () => {
  it('knows an SRT listener is UDP ingest, not a page', () => {
    const kind = endpointKindOf('SRS_SRT_PORT');

    assert.equal(kind.protocol, 'srt');
    assert.equal(kind.opensInBrowser, false);
    assert.equal(endpointAddress(kind, 'stream.example', 10011), 'srt://stream.example:10011');
  });

  it('knows a Swarm peer port is for other nodes, not a browser', () => {
    const kind = endpointKindOf('BEE_UPLOADER_P2P_PORT');

    assert.equal(kind.protocol, 'swarm-p2p');
    assert.equal(kind.audience, 'public');
    assert.equal(kind.opensInBrowser, false);
    assert.equal(endpointAddress(kind, 'stream.example', 10016), 'stream.example:10016');
  });

  it('keeps an API off the browser, even though it speaks HTTP', () => {
    for (const key of ['API_PORT', 'BEE_UPLOADER_API_PORT', 'SRS_HTTP_API_PORT']) {
      const kind = endpointKindOf(key);
      assert.equal(kind.protocol, 'http', key);
      assert.equal(kind.audience, 'administrative', key);
      assert.equal(kind.opensInBrowser, false, key);
    }
  });

  it('links the viewer page, the one port meant for a browser', () => {
    const kind = endpointKindOf('CLIENT_PORT');

    assert.equal(kind.audience, 'public');
    assert.equal(kind.opensInBrowser, true);
    assert.equal(endpointAddress(kind, 'stream.example', 10014), 'http://stream.example:10014');
  });

  it("calls the engine's HLS output internal, HTTP or not", () => {
    const kind = endpointKindOf('SRS_HTTP_PORT');

    assert.equal(kind.protocol, 'http');
    assert.equal(kind.audience, 'internal');
    assert.equal(kind.opensInBrowser, false);
  });

  it('says RTMP ingest is TCP and not a page', () => {
    assert.equal(endpointKindOf('SRS_RTMP_PORT').protocol, 'rtmp');
    assert.equal(endpointKindOf('SRS_RTMP_PORT').opensInBrowser, false);
  });

  it('claims nothing about a key it does not know', () => {
    const kind = endpointKindOf('SOMETHING_NEW_PORT');

    assert.equal(kind.protocol, 'tcp');
    assert.equal(kind.opensInBrowser, false);
  });

  it('tells the three audiences apart in the label', () => {
    assert.match(endpointKindOf('CLIENT_PORT').label, /public/);
    assert.match(endpointKindOf('BEE_GATEWAY_API_PORT').label, /administrative/);
    assert.match(endpointKindOf('SRS_HTTP_PORT').label, /internal/);
  });
});
