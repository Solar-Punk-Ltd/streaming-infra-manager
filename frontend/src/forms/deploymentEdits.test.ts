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

import {
  addressOfStreamKey,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  STACK_RPC_ENDPOINT_SOURCE,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import {
  bodyFor,
  type DeploymentEdits,
  editProblem,
  fieldsFor,
  initialEdits,
  srtPassphraseMasked,
  streamKeyMasked,
} from './deploymentEdits';

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
    has_rpc_endpoint: false,
    rpc_endpoint_host: null,
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

/**
 * The same, on an endpoint of its own. The source and the address travel
 * together in the manager's own columns, so a fixture that carries one carries
 * both.
 */
function customEndpoint(over: Partial<Profile> = {}): Profile {
  return uploader({
    rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
    has_rpc_endpoint: true,
    rpc_endpoint_host: 'host.docker.internal:9000',
    ...over,
  });
}

describe('the RPC endpoint a deployment names for itself', () => {
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

  it('starts empty because the stored address is never answered to the drawer', () => {
    assert.equal(initialEdits(customEndpoint()).rpcEndpoint, '');
    assert.equal(initialEdits(uploader()).rpcEndpoint, '');
  });

  it('accepts an unchanged stored custom endpoint without transmitting it', () => {
    const profile = customEndpoint();
    const initial = initialEdits(profile);

    assert.equal(
      editProblem(initial, fieldsFor(profile), { profile, managerHasEndpoint: true }),
      null,
    );

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'only the note changed' },
      fieldsFor(profile),
      profile.notes_revision,
    );
    assert.equal(body.rpc_endpoint_source, CUSTOM_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, undefined);
    assert.ok(!('rpc_endpoint' in body));
  });

  it('refuses an address that is not one before it is sent', () => {
    const profile = customEndpoint();
    const edits = { ...initialEdits(profile), rpcEndpoint: 'rpc.gnosischain.com' };

    assert.match(editProblem(edits, fieldsFor(profile), { profile, managerHasEndpoint: true }) ?? '', /http/);
  });

  it('goes back to the stack endpoint, and the address goes with it', () => {
    const profile = customEndpoint();
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, rpcEndpointSource: STACK_RPC_ENDPOINT_SOURCE },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.rpc_endpoint_source, STACK_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, null);
  });

  it('sends the endpoint the operator typed', () => {
    const profile = customEndpoint();
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, rpcEndpoint: 'http://host.docker.internal:9001' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.rpc_endpoint, 'http://host.docker.internal:9001');
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
    assert.equal(body.public_key, addressOfStreamKey(TYPED_KEY));
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

/** A deployment whose SRT ingest is encrypted with a passphrase of its own. */
function stage(over: Partial<Profile> = {}): Profile {
  return viewer({ kind: 'streamer', components: ['srs', 'stream-uploader'], ...over });
}

const TYPED_PASSPHRASE = 'stage-passphrase-2026';

describe('the SRT passphrase in the Edit drawer', () => {
  /**
   * The manager answers whether one is stored and hands the value over only to
   * the page about to put it in a publish URL, so the drawer has nothing to
   * put in the box and reads the flag for the mode instead.
   */
  it('reads the mode off the flag, and starts with an empty box', () => {
    const own = initialEdits(stage({ has_srt_passphrase: true }));
    assert.equal(own.passMode, 'own');
    assert.equal(own.passphrase, '', 'a stored passphrase is never on screen');

    assert.equal(initialEdits(stage()).passMode, 'host');
  });

  it('shows dots while one is stored and the operator has typed nothing', () => {
    assert.equal(
      srtPassphraseMasked({ hasStoredPassphrase: true, typed: '', replacing: false }),
      true,
    );
  });

  it('opens the box when the operator asks to replace it, or types one', () => {
    assert.equal(
      srtPassphraseMasked({ hasStoredPassphrase: true, typed: '', replacing: true }),
      false,
    );
    assert.equal(
      srtPassphraseMasked({
        hasStoredPassphrase: true,
        typed: TYPED_PASSPHRASE,
        replacing: false,
      }),
      false,
    );
  });

  it('leaves the box open when the deployment holds none at all', () => {
    assert.equal(
      srtPassphraseMasked({ hasStoredPassphrase: false, typed: '', replacing: false }),
      false,
    );
  });

  /** The manager keeps the stored passphrase when a save says nothing about it. */
  it('sends no passphrase when the operator did not touch the field', () => {
    const profile = stage({ has_srt_passphrase: true });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'only the note changed' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.srt_passphrase, undefined);
    assert.ok(
      !('srt_passphrase' in body),
      'an absent field is what tells the manager to keep the stored one',
    );
  });

  it('does not call dots an invalid passphrase', () => {
    const profile = stage({ has_srt_passphrase: true });
    const initial = initialEdits(profile);

    assert.equal(editProblem(initial, fieldsFor(profile), { profile, managerHasEndpoint: true }), null);
  });

  it('refuses an empty box on a deployment that holds no passphrase', () => {
    const profile = stage();
    const edits = { ...initialEdits(profile), passMode: 'own' as const };

    assert.match(editProblem(edits, fieldsFor(profile), { profile, managerHasEndpoint: true }) ?? '', /passphrase/i);
  });

  it('sends the passphrase the operator typed', () => {
    const profile = stage({ has_srt_passphrase: true });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, passphrase: TYPED_PASSPHRASE },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.srt_passphrase, TYPED_PASSPHRASE);
  });

  /**
   * Null rather than an absent field, because absent now means keep. Sending
   * nothing for the host-wide choice would leave a deployment that once had
   * its own passphrase unable to go back.
   */
  it('sends null when the operator chooses the host-wide passphrase', () => {
    const profile = stage({ has_srt_passphrase: true });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, passMode: 'host' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.srt_passphrase, null);
  });
});

describe('the three sources the Edit drawer offers for an RPC endpoint', () => {
  /**
   * A gateway put on the chain at creation is a light node, and a light node
   * reads an endpoint. The stack ships that node with an empty one, which is
   * what made the field pointless for every viewer before T27.
   */
  it('is asked of a light gateway and not of an ultra-light one', () => {
    assert.equal(fieldsFor(viewer({ node_mode: LIGHT_NODE_MODE })).rpcEndpoint, true);
    assert.equal(fieldsFor(viewer()).rpcEndpoint, false);
  });

  it('starts from the source the deployment was created with', () => {
    assert.equal(initialEdits(uploader()).rpcEndpointSource, STACK_RPC_ENDPOINT_SOURCE);
    assert.equal(
      initialEdits(uploader({ rpc_endpoint_source: MANAGER_RPC_ENDPOINT_SOURCE }))
        .rpcEndpointSource,
      MANAGER_RPC_ENDPOINT_SOURCE,
    );
    const custom = initialEdits(
      uploader({
        rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
        has_rpc_endpoint: true,
        rpc_endpoint_host: 'host.docker.internal:9000',
      }),
    );
    assert.equal(custom.rpcEndpointSource, CUSTOM_RPC_ENDPOINT_SOURCE);
    assert.equal(custom.rpcEndpoint, '');
  });

  it('refuses the manager endpoint on a manager that has none', () => {
    const profile = uploader();
    const edits: DeploymentEdits = {
      ...initialEdits(profile),
      rpcEndpointSource: MANAGER_RPC_ENDPOINT_SOURCE,
    };

    assert.match(
      editProblem(edits, fieldsFor(profile), { profile, managerHasEndpoint: false }) ?? '',
      /the manager has no RPC endpoint configured/,
    );
    assert.equal(
      editProblem(edits, fieldsFor(profile), { profile, managerHasEndpoint: true }),
      null,
    );
  });

  it('refuses the stack default for a gateway on the chain', () => {
    const profile = viewer({ node_mode: LIGHT_NODE_MODE });
    const edits: DeploymentEdits = {
      ...initialEdits(profile),
      rpcEndpointSource: STACK_RPC_ENDPOINT_SOURCE,
    };

    assert.match(
      editProblem(edits, fieldsFor(profile), { profile, managerHasEndpoint: true }) ?? '',
      /a light gateway needs an endpoint/,
    );
  });

  it('sends the source and drops the address the source no longer carries', () => {
    const profile = uploader({
      rpc_endpoint_source: CUSTOM_RPC_ENDPOINT_SOURCE,
      has_rpc_endpoint: true,
      rpc_endpoint_host: 'host.docker.internal:9000',
    });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, rpcEndpointSource: MANAGER_RPC_ENDPOINT_SOURCE },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, null);
  });

  it('sends the address a move to custom typed in', () => {
    const profile = uploader({ rpc_endpoint_source: MANAGER_RPC_ENDPOINT_SOURCE });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      {
        ...initial,
        rpcEndpointSource: CUSTOM_RPC_ENDPOINT_SOURCE,
        rpcEndpoint: ' http://host.docker.internal:9000 ',
      },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.rpc_endpoint_source, CUSTOM_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, 'http://host.docker.internal:9000');
  });

  /**
   * A mode is chosen when the node is created and an update that changes it is
   * refused by the manager, so the drawer sends the stored one back untouched
   * rather than leaving the field out of a body that replaces every field.
   */
  it('sends back the mode the node was created with, unchanged', () => {
    const profile = uploader({ node_mode: LIGHT_NODE_MODE });
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'edited' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal(body.node_mode, LIGHT_NODE_MODE);
  });

  /**
   * A deployment made before T27 stores no mode, and the manager writes the
   * column only for a body that names one. Sending the mode it reads as would
   * fill that column in as a side effect of saving a note.
   */
  it('leaves a stored mode of nothing alone', () => {
    const profile = uploader();
    const initial = initialEdits(profile);

    const body = bodyFor(
      profile,
      initial,
      { ...initial, notes: 'edited' },
      fieldsFor(profile),
      profile.notes_revision,
    );

    assert.equal('node_mode' in body, false);
  });
});
