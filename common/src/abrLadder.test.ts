import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_LADDER_GROUP_KIND,
  ABR_LADDER_SIZE,
  GROUP_KINDS,
  DEFAULT_ABR_LADDER,
  DEFAULT_ABR_RUNGS,
  LADDER_GROUP_NAME_MAX,
  MIN_STAMP_DEPTH,
  assembleBeePublishers,
  beePublisherEntry,
  beePublishersValue,
  isLadderGroup,
  isLadderKind,
  ladderMemberName,
  ladderMemberNames,
  looksLikeLadderGroup,
  rungFromMemberName,
  rungOrder,
  STANDARD_GROUP_KIND,
  suggestedRungDepth,
} from './abrLadder.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

describe('the shipped ladder', () => {
  it('is ascending by bitrate, lowest first', () => {
    const kbps = DEFAULT_ABR_LADDER.map((rung) => rung.kbps);
    for (let i = 1; i < kbps.length; i += 1) {
      assert.ok(kbps[i]! > kbps[i - 1]!, `rung ${i} is not above its predecessor`);
    }
    assert.equal(DEFAULT_ABR_RUNGS[0], '360p');
  });

  it('uses even geometry — H.264 rejects odd dimensions', () => {
    for (const rung of DEFAULT_ABR_LADDER) {
      assert.equal(rung.width % 2, 0);
      assert.equal(rung.height % 2, 0);
    }
  });

  it('has unique rung names', () => {
    assert.equal(new Set(DEFAULT_ABR_RUNGS).size, ABR_LADDER_SIZE);
  });
});

describe('member naming', () => {
  it('puts the rung in the name', () => {
    assert.equal(ladderMemberName('abr1', '360p'), 'abr1-360p');
    assert.deepEqual(ladderMemberNames('abr1'), [
      'abr1-360p',
      'abr1-480p',
      'abr1-720p',
      'abr1-1080p',
    ]);
  });

  it('round-trips the rung back out', () => {
    for (const rung of DEFAULT_ABR_RUNGS) {
      assert.equal(rungFromMemberName('abr1', ladderMemberName('abr1', rung)), rung);
    }
  });

  it('strips against the known group name, so similar groups cannot collide', () => {
    // "abr" owns abr-1080p; "abr-1" owns abr-1-080p-shaped names. Each is only
    // ever parsed against its own group, so neither can claim the other's member.
    assert.equal(rungFromMemberName('abr', 'abr-1080p'), '1080p');
    assert.equal(rungFromMemberName('abr-1', 'abr-1-360p'), '360p');
    assert.equal(rungFromMemberName('abr-1', 'abr-1080p'), null);
  });

  it('rejects a non-rung suffix', () => {
    assert.equal(rungFromMemberName('abr1', 'abr1-profile-1'), null);
    assert.equal(rungFromMemberName('abr1', 'abr1-2160p'), null);
    assert.equal(rungFromMemberName('abr1', 'other-360p'), null);
  });

  it('produces names the profile-name constraint accepts, at max group length', () => {
    const longest = 'a'.repeat(LADDER_GROUP_NAME_MAX);
    for (const name of ladderMemberNames(longest)) {
      assert.ok(
        PROFILE_NAME_RE.test(name),
        `"${name}" (${name.length} chars) violates the profile name constraint`,
      );
    }
  });

  it('would overflow one character beyond the cap — the bound is tight', () => {
    const tooLong = 'a'.repeat(LADDER_GROUP_NAME_MAX + 1);
    const overflowing = ladderMemberNames(tooLong).filter(
      (name) => !PROFILE_NAME_RE.test(name),
    );
    assert.ok(overflowing.length > 0, 'expected the longest rung to overflow');
  });
});

describe('recognising a ladder group', () => {
  it('needs every rung present', () => {
    assert.equal(isLadderGroup('abr1', ladderMemberNames('abr1')), true);
    assert.equal(
      isLadderGroup('abr1', ['abr1-360p', 'abr1-480p', 'abr1-720p']),
      false,
    );
  });

  it('is not fooled by a plain fan-out group', () => {
    assert.equal(
      isLadderGroup('load', ['load-profile-1', 'load-profile-2']),
      false,
    );
    assert.equal(
      looksLikeLadderGroup('load', ['load-profile-1', 'load-profile-2']),
      false,
    );
  });

  it('still recognises a damaged ladder as ladder-shaped', () => {
    // A rung removed must not silently demote the group to a plain fan-out —
    // that is precisely when the operator needs to be told a rung is missing.
    const damaged = ['abr1-360p', 'abr1-720p'];
    assert.equal(isLadderGroup('abr1', damaged), false);
    assert.equal(looksLikeLadderGroup('abr1', damaged), true);
  });

  it('orders rungs ascending', () => {
    assert.equal(rungOrder('360p'), 0);
    assert.equal(rungOrder('1080p'), ABR_LADDER_SIZE - 1);
    assert.equal(rungOrder('2160p'), -1);
  });
});

describe('suggestedRungDepth', () => {
  it('scales one depth per doubling of bitrate', () => {
    assert.equal(suggestedRungDepth('360p', 17), 17);
    assert.equal(suggestedRungDepth('480p', 17), 18);
    assert.equal(suggestedRungDepth('720p', 17), 19);
    assert.equal(suggestedRungDepth('1080p', 17), 20);
  });

  it('is monotonic across the ladder', () => {
    const depths = DEFAULT_ABR_RUNGS.map((rung) => suggestedRungDepth(rung, 17));
    for (let i = 1; i < depths.length; i += 1) {
      assert.ok(depths[i]! >= depths[i - 1]!);
    }
  });

  it('carries a raised base through the ladder', () => {
    assert.equal(suggestedRungDepth('1080p', 20), 23);
  });

  it('never goes below bee’s minimum depth', () => {
    assert.equal(suggestedRungDepth('360p', 2), MIN_STAMP_DEPTH);
  });

  it('falls back to the base for an unknown rung', () => {
    assert.equal(suggestedRungDepth('2160p', 18), 18);
  });
});

describe('BEE_PUBLISHERS assembly', () => {
  const batch = 'a'.repeat(64);

  it('brackets the batch rather than prefixing it with #', () => {
    assert.equal(
      beePublisherEntry('360p', 'http://host:10015', batch),
      `360p@http://host:10015<${batch}>`,
    );
  });

  it('strips a 0x prefix — bee wants raw hex', () => {
    assert.equal(
      beePublisherEntry('360p', 'http://host:10015', `0x${batch}`),
      `360p@http://host:10015<${batch}>`,
    );
  });

  it('joins entries with a single space, in the order given', () => {
    const value = beePublishersValue([
      { rungName: '360p', url: 'http://host:10015', batchId: batch },
      { rungName: '480p', url: 'http://host:10025', batchId: batch },
    ]);
    assert.equal(value.split(' ').length, 2);
    assert.ok(value.startsWith('360p@'));
  });

  it('round-trips through the uploader parser shape', () => {
    // Mirrors parseEntry in BeePublisherPool: split on the first @ and the last
    // bracket, so a URL carrying a port survives intact.
    const entry = beePublisherEntry('720p', 'http://10.0.0.4:10035', batch);
    const at = entry.indexOf('@');
    const open = entry.lastIndexOf('<');
    assert.equal(entry.slice(0, at), '720p');
    assert.equal(entry.slice(at + 1, open), 'http://10.0.0.4:10035');
    assert.equal(entry.slice(open + 1, entry.length - 1), batch);
  });
});

describe('assembleBeePublishers', () => {
  const batch = (n: string) => n.repeat(64);
  const rung = (name: string, over = {}) => ({
    rung: name,
    name: `abr1-${name}`,
    status: 'RUNNING',
    url: `http://host:100${DEFAULT_ABR_RUNGS.indexOf(name)}5`,
    stampId: batch('a'),
    ...over,
  });
  const full = () => DEFAULT_ABR_RUNGS.map((r) => rung(r));

  it('emits the string once every rung has a batch', () => {
    const result = assembleBeePublishers(full());
    assert.equal(result.ready, true);
    assert.equal(result.missing.length, 0);
    assert.equal(result.value!.split(' ').length, ABR_LADDER_SIZE);
  });

  it('orders rungs ascending regardless of input order', () => {
    const shuffled = [rung('1080p'), rung('360p'), rung('720p'), rung('480p')];
    const result = assembleBeePublishers(shuffled);
    assert.deepEqual(
      result.rungs.map((r) => r.rung),
      ['360p', '480p', '720p', '1080p'],
    );
    assert.ok(result.value!.startsWith('360p@'));
  });

  it('refuses a partial string when a rung has no batch', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '720p' ? { ...r, stampId: null } : r)),
    );
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.deepEqual(result.missing, [
      { rung: '720p', reason: 'no postage batch set on this rung yet' },
    ]);
  });

  it('names a rung that has no member at all', () => {
    const result = assembleBeePublishers(full().filter((r) => r.rung !== '1080p'));
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing, [
      { rung: '1080p', reason: 'no member deployed for this rung' },
    ]);
  });

  it('reports every unready rung, not just the first', () => {
    const result = assembleBeePublishers([rung('360p'), rung('480p', { stampId: null })]);
    assert.equal(result.missing.length, 3); // 480p unstamped, 720p + 1080p absent
  });

  it('still lists the rungs it did find when not ready', () => {
    const result = assembleBeePublishers([rung('360p')]);
    assert.equal(result.ready, false);
    assert.equal(result.rungs.length, 1);
    assert.equal(result.rungs[0]!.rung, '360p');
  });

  it('carries each rung its own batch, never a shared one', () => {
    const distinct = DEFAULT_ABR_RUNGS.map((r, i) =>
      rung(r, { stampId: batch(String(i)) }),
    );
    const result = assembleBeePublishers(distinct);
    const ids = result.value!.split(' ').map((e) => e.slice(e.lastIndexOf('<') + 1, -1));
    assert.equal(new Set(ids).size, ABR_LADDER_SIZE);
  });
});

describe('assembleBeePublishers — live batch state', () => {
  const batch = (n: string) => n.repeat(64);
  const rung = (name: string, over = {}) => ({
    rung: name,
    name: `abr1-${name}`,
    status: 'RUNNING',
    url: `http://host:100${DEFAULT_ABR_RUNGS.indexOf(name)}5`,
    stampId: batch('a'),
    stampState: 'active' as const,
    ...over,
  });
  const full = () => DEFAULT_ABR_RUNGS.map((r) => rung(r));

  it('emits the string when every rung reports a live batch', () => {
    const result = assembleBeePublishers(full());
    assert.equal(result.ready, true);
    assert.equal(result.value!.split(' ').length, ABR_LADDER_SIZE);
  });

  // The reported bug: four recorded ids, four dead batches, and a value that
  // looked complete while every upload failed.
  it('refuses the string when every rung’s batch has expired', () => {
    const result = assembleBeePublishers(
      full().map((r) => ({ ...r, stampState: 'expired' as const })),
    );
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.equal(result.missing.length, ABR_LADDER_SIZE);
    assert.ok(result.missing.every((m) => m.reason.includes('expired')));
  });

  it('refuses the string when one rung’s batch has expired', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '1080p' ? { ...r, stampState: 'expired' as const } : r)),
    );
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]!.rung, '1080p');
  });

  it('refuses a batch the node has dropped entirely', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '360p' ? { ...r, stampState: 'gone' as const } : r)),
    );
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing.map((m) => m.rung), ['360p']);
  });

  it('refuses a batch bee has not settled yet', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '480p' ? { ...r, stampState: 'pending' as const } : r)),
    );
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing.map((m) => m.rung), ['480p']);
  });

  // A node being unreachable is not evidence that its batch is dead: the operator
  // still gets a value to paste, and the UI says it could not be verified.
  it('stays ready when a rung’s batch could not be verified', () => {
    const result = assembleBeePublishers(
      full().map((r) => ({ ...r, stampState: 'unknown' as const })),
    );
    assert.equal(result.ready, true);
    assert.equal(result.missing.length, 0);
  });

  it('stays ready for callers that supply no live state at all', () => {
    const result = assembleBeePublishers(
      full().map(({ stampState: _drop, ...rest }) => rest),
    );
    assert.equal(result.ready, true);
  });

  it('reports a missing member ahead of an expired batch on another rung', () => {
    const result = assembleBeePublishers([
      rung('360p', { stampState: 'expired' as const }),
      rung('480p'),
    ]);
    assert.deepEqual(result.missing.map((m) => m.rung), ['360p', '720p', '1080p']);
  });

  it('carries the live state through on the rungs it reports', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '720p' ? { ...r, stampState: 'gone' as const } : r)),
    );
    assert.equal(result.rungs.find((r) => r.rung === '720p')!.stampState, 'gone');
  });
});

describe('assembleBeePublishers — rung address and status', () => {
  const batch = (n: string) => n.repeat(64);
  const rung = (name: string, over = {}) => ({
    rung: name,
    name: `abr1-${name}`,
    status: 'RUNNING',
    url: `http://65.108.40.58:100${DEFAULT_ABR_RUNGS.indexOf(name)}5`,
    stampId: batch('a'),
    stampState: 'active' as const,
    stampTtl: 30 * 24 * 3_600,
    urlState: 'ok' as const,
    ...over,
  });
  const full = () => DEFAULT_ABR_RUNGS.map((r) => rung(r));

  it('emits the value when every rung is running with a live batch and a good address', () => {
    const result = assembleBeePublishers(full());
    assert.equal(result.ready, true);
    assert.equal(result.warnings.length, 0);
  });

  // The Uploaders tab showed no status at all, so a stopped rung looked exactly
  // like a running one — and its address answers nothing.
  it('refuses a rung that is not running, and says which state it is in', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '720p' ? { ...r, status: 'STOPPED' } : r)),
    );
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]!.rung, '720p');
    assert.ok(result.missing[0]!.reason.includes('stopped'));
  });

  it('refuses every non-running status, transitional ones included', () => {
    for (const status of ['STOPPED', 'ERROR', 'DEPLOYING', 'STOPPING', 'REMOVING']) {
      const result = assembleBeePublishers(
        full().map((r) => (r.rung === '360p' ? { ...r, status } : r)),
      );
      assert.equal(result.ready, false, status);
    }
  });

  // PUBLIC_HOST unset: the value assembles and works nowhere but this machine.
  it('refuses a loopback address', () => {
    const result = assembleBeePublishers(
      full().map((r) => ({ ...r, urlState: 'loopback' as const })),
    );
    assert.equal(result.ready, false);
    assert.equal(result.missing.length, ABR_LADDER_SIZE);
    assert.ok(result.missing.every((m) => m.reason.includes('PUBLIC_HOST')));
  });

  it('refuses an ssh target used as an address', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '480p' ? { ...r, urlState: 'ssh-target' as const } : r)),
    );
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing.map((m) => m.rung), ['480p']);
  });

  it('reports a stopped rung ahead of its address and its batch', () => {
    // All three are wrong; the operator can only act on the first.
    const result = assembleBeePublishers([
      rung('360p', { status: 'STOPPED', urlState: 'loopback' as const, stampState: 'expired' as const }),
      rung('480p'),
      rung('720p'),
      rung('1080p'),
    ]);
    assert.equal(result.missing.length, 1);
    assert.ok(result.missing[0]!.reason.includes('not running'));
  });

  it('reports an unusable address ahead of the batch behind it', () => {
    const result = assembleBeePublishers(
      full().map((r) =>
        r.rung === '1080p'
          ? { ...r, urlState: 'loopback' as const, stampState: 'expired' as const }
          : r,
      ),
    );
    assert.equal(result.missing.length, 1);
    assert.ok(result.missing[0]!.reason.includes('PUBLIC_HOST'));
  });

  it('warns without withholding when nothing answered at an address', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '360p' ? { ...r, urlState: 'unreachable' as const } : r)),
    );
    // Could be hairpinning — evidence, not proof.
    assert.equal(result.ready, true);
    assert.ok(result.value);
    assert.deepEqual(result.warnings.map((w) => w.rung), ['360p']);
  });

  it('warns without withholding when a batch could not be verified', () => {
    const result = assembleBeePublishers(
      full().map((r) => ({ ...r, stampState: 'unknown' as const })),
    );
    assert.equal(result.ready, true);
    assert.equal(result.warnings.length, ABR_LADDER_SIZE);
  });

  it('warns while a batch is still alive but nearly spent', () => {
    const result = assembleBeePublishers(
      full().map((r) => (r.rung === '1080p' ? { ...r, stampTtl: 6 * 3_600 } : r)),
    );
    assert.equal(result.ready, true);
    assert.deepEqual(result.warnings.map((w) => w.rung), ['1080p']);
    assert.ok(result.warnings[0]!.reason.includes('6h'));
  });

  it('does not warn about a batch with plenty of life left', () => {
    const result = assembleBeePublishers(
      full().map((r) => ({ ...r, stampTtl: 30 * 24 * 3_600 })),
    );
    assert.equal(result.warnings.length, 0);
  });

  it('says nothing soft about a rung it has already refused', () => {
    // One complaint per rung: the blocking one, which is the actionable one.
    const result = assembleBeePublishers(
      full().map((r) =>
        r.rung === '360p'
          ? { ...r, status: 'STOPPED', urlState: 'unreachable' as const, stampTtl: 60 }
          : r,
      ),
    );
    assert.deepEqual(result.missing.map((m) => m.rung), ['360p']);
    assert.equal(result.warnings.length, 0);
  });

  it('collects several warnings on one rung', () => {
    const result = assembleBeePublishers(
      full().map((r) =>
        r.rung === '480p'
          ? { ...r, urlState: 'unreachable' as const, stampState: 'unknown' as const }
          : r,
      ),
    );
    assert.equal(result.ready, true);
    assert.equal(result.warnings.filter((w) => w.rung === '480p').length, 2);
  });

  it('stays ready for callers that supply neither address state nor TTL', () => {
    const result = assembleBeePublishers(
      full().map(({ urlState: _u, stampTtl: _t, ...rest }) => rest),
    );
    assert.equal(result.ready, true);
  });
});

describe('group kind', () => {
  it('recognises only the ladder kind', () => {
    assert.equal(isLadderKind(ABR_LADDER_GROUP_KIND), true);
    assert.equal(isLadderKind(STANDARD_GROUP_KIND), false);
    assert.equal(isLadderKind(undefined), false);
    assert.equal(isLadderKind(null), false);
    assert.equal(isLadderKind('custom'), false);
  });

  it('matches the values the check constraint allows', () => {
    assert.deepEqual([...GROUP_KINDS], ['standard', 'abr-ladder']);
  });

  it('is independent of whether the ladder is currently intact', () => {
    // The point of recording the kind: a ladder missing a rung is still a
    // ladder. isLadderGroup answers "is it complete", which is a different
    // question and must not be used for identity.
    const damaged = ['abr1-360p', 'abr1-720p'];
    assert.equal(isLadderGroup('abr1', damaged), false);
    assert.equal(isLadderKind(ABR_LADDER_GROUP_KIND), true);
  });
});
