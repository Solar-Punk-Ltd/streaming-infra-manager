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
import { bodyFor, fieldsFor, initialEdits } from './deploymentEdits';

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
