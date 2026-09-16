/**
 * Which passphrase the publish URL carries, and when the page asks for it.
 *
 * Unit test, no DOM and no server. `pnpm test` in frontend/.
 *
 * The passphrase is not on the profile row any more, because a row is answered
 * to every signed-in page on every list and published on every status change.
 * It is still what a broadcaster needs, so the page asks the manager for one
 * deployment's at the moment an operator opens or copies that deployment's
 * URL. What matters here is that it asks then and not before, asks only about
 * the deployment on screen, and falls back to the host-wide passphrase the way
 * the deploy does when it writes the env file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../types';
import { publishPassphrase, type PassphraseReader } from './publishPassphrase';
import { srtPublishUrl } from '../urls';

const HOST_WIDE = 'lab-host-passphrase';
const OWN = 'stage-passphrase-2026';

function stage(over: Partial<Profile> = {}): Profile {
  return {
    name: 'stage',
    port_slot: 2,
    kind: 'streamer',
    notes: null,
    notes_revision: 0,
    components: ['srs', 'stream-uploader'],
    engine_settings: {},
    has_private_key: false,
    has_srt_passphrase: false,
    has_engine_config: false,
    engine_config_error: null,
    engine_config_state: null,
    instance_id: '00000000-0000-4000-8000-000000000001',
    engine_config_revision: 0,
    intent_revision: 0,
    last_full_deploy_commit: null,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
    containers: [],
    stack_version_id: 1,
    ...over,
  };
}

/** A reveal route that records which deployments were asked about. */
function reader(answer: string | null = OWN): PassphraseReader & { asked: string[] } {
  const asked: string[] = [];
  const read = async (name: string) => {
    asked.push(name);
    return answer;
  };
  return Object.assign(read, { asked });
}

describe('the passphrase the publish URL carries', () => {
  it('is the host-wide one for a deployment that holds none, asked of nobody', async () => {
    const read = reader();

    const passphrase = await publishPassphrase(stage(), HOST_WIDE, read);

    assert.equal(passphrase, HOST_WIDE);
    assert.deepEqual(read.asked, [], 'there is nothing to reveal, so nothing is asked');
  });

  it('is the deployment’s own when it holds one, asked for on the spot', async () => {
    const read = reader();

    const passphrase = await publishPassphrase(
      stage({ has_srt_passphrase: true }),
      HOST_WIDE,
      read,
    );

    assert.equal(passphrase, OWN, 'the deployment’s own outranks the host-wide one');
    assert.deepEqual(read.asked, ['stage'], 'one deployment, asked about once');
  });

  it('falls back to the host-wide one when the reveal answers nothing', async () => {
    // The row said a passphrase was stored and the reveal disagreed, which is
    // a deployment edited from another page between the two reads.
    const passphrase = await publishPassphrase(
      stage({ has_srt_passphrase: true }),
      HOST_WIDE,
      reader(null),
    );

    assert.equal(passphrase, HOST_WIDE);
  });

  it('carries nothing when neither the deployment nor the host has one', async () => {
    assert.equal(await publishPassphrase(stage(), null, reader()), null);
  });
});

describe('srtPublishUrl', () => {
  it('puts the passphrase it is given in the query, and nothing when given none', () => {
    const profile = stage();

    assert.match(
      srtPublishUrl(profile, 'stream.example', OWN) ?? '',
      new RegExp(`&passphrase=${OWN}$`),
    );
    assert.ok(
      !(srtPublishUrl(profile, 'stream.example', null) ?? '').includes('passphrase'),
    );
  });

  it('reads no passphrase off the profile, so a page cannot leak one it was handed', () => {
    // The row carries no passphrase to read. A profile that somehow arrives
    // with one still must not have it spliced into a URL behind the caller.
    const carrying = stage({
      has_srt_passphrase: true,
      srt_passphrase: OWN,
    } as Partial<Profile>);

    assert.ok(!(srtPublishUrl(carrying, 'stream.example', null) ?? '').includes(OWN));
  });
});
