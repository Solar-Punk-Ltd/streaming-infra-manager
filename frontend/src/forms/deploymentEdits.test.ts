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
import { bodyFor, editProblem, fieldsFor, initialEdits } from './deploymentEdits';

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

describe('the chain endpoint a deployment names for itself', () => {
  /**
   * Every Bee node reads RPC_ENDPOINT, and the only place to set it used to be
   * the stack version, so every deployment on a version shared one. The shipped
   * default is a public RPC that answered a single node 4568 HTTP 429s in two
   * hours on 2026-09-15, so a deployment running a node of its own has to be
   * able to name its own endpoint.
   */
  it('is asked of a deployment that runs a Bee node, and not of one that does not', () => {
    assert.equal(fieldsFor(viewer()).rpcEndpoint, true);
    assert.equal(fieldsFor(viewer({ components: ['srs'] })).rpcEndpoint, false);
  });

  it('starts from what the deployment already holds, and empty when it holds none', () => {
    assert.equal(initialEdits(viewer({ rpc_endpoint: 'http://host.docker.internal:9000' })).rpcEndpoint,
      'http://host.docker.internal:9000');
    assert.equal(initialEdits(viewer()).rpcEndpoint, '');
  });

  it('refuses an address that is not one before it is sent', () => {
    const profile = viewer();
    const edits = { ...initialEdits(profile), rpcEndpoint: 'rpc.gnosischain.com' };

    assert.match(editProblem(edits, fieldsFor(profile)) ?? '', /http/);
  });

  it('clears back to the version endpoint when the field is emptied', () => {
    const profile = viewer({ rpc_endpoint: 'http://host.docker.internal:9000' });
    const initial = initialEdits(profile);

    const body = bodyFor(profile, initial, { ...initial, rpcEndpoint: '   ' }, fieldsFor(profile), profile.notes_revision);

    assert.equal(body.rpc_endpoint, null);
  });

  it('sends the endpoint the operator typed', () => {
    const profile = viewer();
    const initial = initialEdits(profile);

    const body = bodyFor(profile, initial, { ...initial, rpcEndpoint: 'http://host.docker.internal:9000' }, fieldsFor(profile), profile.notes_revision);

    assert.equal(body.rpc_endpoint, 'http://host.docker.internal:9000');
  });
});

