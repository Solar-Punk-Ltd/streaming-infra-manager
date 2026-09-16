import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beeUrlProblem,
  classifyPublishUrl,
  isInvalidUrlState,
  publishUrlHealth,
  publishUrlReason,
  publishUrlWarning,
  rpcEndpointProblem,
} from './publishUrl.js';

describe('classifyPublishUrl', () => {
  it('accepts the address a deployed rung actually publishes on', () => {
    assert.equal(classifyPublishUrl('http://65.108.40.58:10055'), 'ok');
    assert.equal(classifyPublishUrl('https://bee-1.example.com:10055'), 'ok');
    // A bare internal hostname is legitimate: it may well resolve for the
    // uploader, and refusing it would be a guess dressed as a verdict.
    assert.equal(classifyPublishUrl('http://streamer1:10055'), 'ok');
  });

  // PUBLIC_HOST unset falls back to localhost with only a log line, and the
  // assembled value then works nowhere but the manager's own machine.
  it('rejects a loopback host, however spelled', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', 'LOCALHOST']) {
      assert.equal(classifyPublishUrl(`http://${host}:10055`), 'loopback');
    }
    assert.equal(classifyPublishUrl('http://[::1]:10055'), 'loopback');
  });

  // profiles.host holds a deploy target, "localhost, an ssh alias, or
  // user@host", and the user@ form is not a network address.
  it('rejects an ssh target used as an address', () => {
    assert.equal(
      classifyPublishUrl('http://deploy@65.108.40.58:10055'),
      'ssh-target',
    );
    assert.equal(
      classifyPublishUrl('http://deploy:pw@65.108.40.58:10055'),
      'ssh-target',
    );
  });

  it('rejects what is not a URL at all', () => {
    for (const bad of ['', '   ', null, undefined, 'not a url', '65.108.40.58:10055']) {
      assert.equal(classifyPublishUrl(bad), 'malformed');
    }
  });

  it('rejects a scheme bee does not speak', () => {
    assert.equal(classifyPublishUrl('ssh://65.108.40.58:10055'), 'malformed');
    assert.equal(classifyPublishUrl('file:///etc/passwd'), 'malformed');
  });

  it('says nothing about reachability', () => {
    // 'ok' is a structural verdict only. The probe decides the rest.
    assert.equal(classifyPublishUrl('http://198.51.100.9:10055'), 'ok');
    assert.equal(publishUrlHealth('ok').ok, true);
    assert.equal(publishUrlHealth('unreachable').ok, false);
  });
});

describe('isInvalidUrlState', () => {
  it('is true only for verdicts no probe could overturn', () => {
    assert.equal(isInvalidUrlState('loopback'), true);
    assert.equal(isInvalidUrlState('ssh-target'), true);
    assert.equal(isInvalidUrlState('malformed'), true);
    assert.equal(isInvalidUrlState('ok'), false);
    // Unreachable from here is not proof of unreachable from everywhere.
    assert.equal(isInvalidUrlState('unreachable'), false);
    assert.equal(isInvalidUrlState('unknown'), false);
    assert.equal(isInvalidUrlState(undefined), false);
  });
});

describe('publishUrlReason / publishUrlWarning', () => {
  it('explains what blocks, and only what blocks', () => {
    assert.ok(publishUrlReason('loopback'));
    assert.ok(publishUrlReason('ssh-target'));
    assert.ok(publishUrlReason('malformed'));
    assert.equal(publishUrlReason('ok'), null);
    assert.equal(publishUrlReason('unreachable'), null);
    assert.equal(publishUrlReason('unknown'), null);
  });

  it('warns about the one state that is evidence but not proof', () => {
    assert.ok(publishUrlWarning('unreachable'));
    assert.equal(publishUrlWarning('ok'), null);
    assert.equal(publishUrlWarning('loopback'), null);
  });
});

/**
 * Both of these addresses are written into `.env.<profile>` as a bare
 * `KEY=value` line, which docker compose reads as an env file and the stack's
 * deploy script reads as its defaults.
 *
 * The URL constructor strips every tab, carriage return and line feed out of
 * its input before it parses, so an address carrying one came back sound while
 * the stored string kept it. The line break then started a second key of the
 * writer's choosing, and `SRS_CONF_FILE` is the one that matters: the version's
 * compose override bind-mounts whatever it names into the engine container.
 */
describe('an address that has to survive an env file', () => {
  const NOT_ONE_LINE = [
    ['a line feed', 'http://10.0.0.7:1633/x\nSRS_CONF_FILE=/etc/passwd'],
    ['a carriage return', 'http://10.0.0.7:1633/x\rSRS_CONF_FILE=/etc/passwd'],
    ['a tab', 'http://10.0.0.7:1633/x\tSRS_CONF_FILE=/etc/passwd'],
    ['a space', 'http://10.0.0.7:1633/x SRS_CONF_FILE=/etc/passwd'],
  ] as const;

  for (const [label, value] of NOT_ONE_LINE) {
    it(`refuses ${label} in a bee address`, () => {
      assert.ok(beeUrlProblem(value), `${label} was accepted as a bee address`);
    });

    it(`refuses ${label} in a chain endpoint`, () => {
      assert.ok(
        rpcEndpointProblem(value),
        `${label} was accepted as a chain endpoint`,
      );
    });
  }

  it('accepts a plain address of either kind', () => {
    assert.equal(beeUrlProblem('http://10.0.0.7:1633'), null);
    assert.equal(rpcEndpointProblem('https://rpc.example.org'), null);
  });
});
