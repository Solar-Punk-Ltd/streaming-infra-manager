/**
 * What the Edit drawer sends, tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The drawer replaces every editable field through the PUT, so what it sends
 * for a field the operator never touched, and what it carries along when they
 * did touch the notes, decides whether a note saved elsewhere survives.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../types';
import {
  bodyFor,
  editProblem,
  fieldsFor,
  initialEdits,
  streamKeyMasked,
} from './deploymentEdits';
import { addressForKey } from './validation';

function viewer(over: Partial<Profile> = {}): Profile {
  return {
    name: 'watch1',
    port_slot: 1,
    kind: 'viewer',
    notes: 'the note as loaded',
    notes_revision: 4,
    components: ['client', 'bee-gateway'],
    feed_owner: '0x1111111111111111111111111111111111111111',
    engine_settings: {},
    has_private_key: false,
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
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    containers: [],
    stack_version_id: 1,
    ...over,
  };
}

describe('the body the Edit drawer sends', () => {
  it('carries the revision it loaded when the operator edited the notes', () => {
    const profile = viewer();
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'edited in the drawer' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.notes, 'edited in the drawer');
    assert.equal(body.notes_revision, 4);
  });

  it('sends the live note and no revision when the notes were not touched', () => {
    // The live profile may carry a note saved from the Notes card since the
    // drawer opened, and an untouched field takes the live value.
    const opened = viewer();
    const live = viewer({ notes: 'saved from the card meanwhile', notes_revision: 5 });
    const initial = initialEdits(opened);

    const body = bodyFor(
      live,
      initial,
      { ...initial, feedOwner: '0x2222222222222222222222222222222222222222' },
      fieldsFor(live),
      opened.notes_revision,
    );

    assert.equal(body.notes, 'saved from the card meanwhile');
    assert.equal(body.notes_revision, undefined);
  });
});

/** A deployment that runs a Bee node of its own, which is what reaches a chain. */
function uploader(over: Partial<Profile> = {}): Profile {
  return viewer({ kind: 'streamer', components: ['srs', 'stream-uploader', 'bee-uploader'], ...over });
}

describe('the chain endpoint a deployment names for itself', () => {
  /**
   * Every Bee node that reaches a chain reads RPC_ENDPOINT, and the only place
   * to set it used to be the stack version, so every deployment on a version
   * shared one. The shipped default is a public RPC that answered a single node
   * 4568 HTTP 429s in two hours on 2026-09-15.
   */
  it('is asked of a deployment that runs an uploader node', () => {
    assert.equal(fieldsFor(uploader()).rpcEndpoint, true);
  });

  /**
   * A viewer's gateway is an ultra-light node, and bee reads that mode off an
   * EMPTY --blockchain-rpc-endpoint (pkg/node/node.go:1605 isChainEnabled). The
   * stack states it empty, so there is nowhere for an endpoint to go and asking
   * for one would offer a setting that changes nothing.
   */
  it('is not asked of a viewer, whose node reaches no chain at all', () => {
    assert.equal(fieldsFor(viewer()).rpcEndpoint, false);
    assert.equal(fieldsFor(viewer({ components: ['srs'] })).rpcEndpoint, false);
  });

  /**
   * A pool-backed uploader publishes through the pool's nodes, which it names
   * in bee_publishers, and runs no node of its own. There is nothing here for
   * an endpoint to reach a chain from.
   */
  it('is not asked of an uploader that publishes through a pool', () => {
    const pooled = viewer({
      kind: 'abr-uploader',
      components: ['srs', 'stream-uploader'],
      bee_publishers: 'pool-node-1,pool-node-2',
    });

    assert.equal(fieldsFor(pooled).rpcEndpoint, false);
    assert.equal(fieldsFor(pooled).poolString, true);
  });

  it('starts from what the deployment already holds, and empty when it holds none', () => {
    assert.equal(initialEdits(uploader({ rpc_endpoint: 'http://host.docker.internal:9000' })).rpcEndpoint,
      'http://host.docker.internal:9000');
    assert.equal(initialEdits(uploader()).rpcEndpoint, '');
  });

  it('refuses an address that is not one before it is sent', () => {
    const profile = uploader();
    const edits = { ...initialEdits(profile), rpcEndpoint: 'rpc.gnosischain.com' };

    assert.match(editProblem(edits, fieldsFor(profile)) ?? '', /http/);
  });

  it('clears back to the version endpoint when the field is emptied', () => {
    const profile = uploader({ rpc_endpoint: 'http://host.docker.internal:9000' });
    const initial = initialEdits(profile);

    const body = bodyFor(profile, initial, { ...initial, rpcEndpoint: '   ' }, fieldsFor(profile), profile.notes_revision);

    assert.equal(body.rpc_endpoint, null);
  });

  it('sends the endpoint the operator typed', () => {
    const profile = uploader();
    const initial = initialEdits(profile);

    const body = bodyFor(profile, initial, { ...initial, rpcEndpoint: 'http://host.docker.internal:9000' }, fieldsFor(profile), profile.notes_revision);

    assert.equal(body.rpc_endpoint, 'http://host.docker.internal:9000');
  });
});

/** A key an operator pastes into the drawer. */
const TYPED_KEY = `0x${'11'.repeat(32)}`;

describe('the stream key in the Edit drawer', () => {
  /**
   * The manager answers whether a key is stored and never the key, so there is
   * nothing to put in the box. The assertion holds the drawer to that even if
   * something upstream starts answering one again.
   */
  it('starts empty, so a stored key is never on screen', () => {
    const holdsAKey = uploader({
      has_private_key: true,
      private_key: `0x${'ab'.repeat(32)}`,
    } as Partial<Profile>);

    assert.equal(initialEdits(holdsAKey).key, '');
  });

  it('shows dots while a key is stored and the operator has typed nothing', () => {
    assert.equal(
      streamKeyMasked({ hasStoredKey: true, typed: '', replacing: false }),
      true,
    );
  });

  it('opens the field when the operator asks to paste another, or types one', () => {
    assert.equal(
      streamKeyMasked({ hasStoredKey: true, typed: '', replacing: true }),
      false,
    );
    assert.equal(
      streamKeyMasked({ hasStoredKey: true, typed: TYPED_KEY, replacing: false }),
      false,
    );
  });

  it('leaves the field open when the deployment holds no key at all', () => {
    assert.equal(
      streamKeyMasked({ hasStoredKey: false, typed: '', replacing: false }),
      false,
    );
  });

  it('sends the key the operator typed, with the address it derives', () => {
    const profile = uploader({ has_private_key: true });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, key: TYPED_KEY },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.private_key, TYPED_KEY);
    assert.equal(body.public_key, addressForKey(TYPED_KEY));
  });

  /** The manager keeps the stored key when a save says nothing about it. */
  it('sends no key when the operator did not touch the field', () => {
    const profile = uploader({ has_private_key: true });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'only the note changed' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.private_key, undefined);
  });
});
