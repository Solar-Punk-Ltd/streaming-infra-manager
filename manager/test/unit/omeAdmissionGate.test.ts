/**
 * The order the OvenMediaEngine gate does things in, read off the script.
 *
 * The gate starts a publisher container that installs ffmpeg before it
 * publishes. That install took 93 seconds on this laptop, the harness checked
 * the container was alive 5 seconds in, which it was, and then gave the
 * playlist 40 seconds, which expired long before ffmpeg existed. The gate
 * failed twice with no engine problem. So a gate that is a named job in the
 * workflow has to wait for the install and start the playlist clock after it,
 * and a publisher that dies during the install still has to be caught in
 * seconds rather than at the end of the budget.
 *
 * The script needs Docker and three images, so nothing here runs it. Its
 * evidence is a live run recorded in its own header. What can be checked
 * without Docker is that the wait is still there, in the right place, with
 * the exit check inside it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', 'docker', 'ome-admission-gate.sh'), 'utf8');

const at = (needle: string) => script.indexOf(needle);

describe('the OvenMediaEngine gate', () => {
  it('gives the ffmpeg install a budget of its own, named in the header', () => {
    assert.match(script, /^FFMPEG_WAIT_SECONDS=\d+$/m);
    assert.match(script, /FFMPEG_WAIT_SECONDS/);
    assert.ok(at('# ') < at('FFMPEG_WAIT_SECONDS'), 'the header comes first');
  });

  it('counts that budget in seconds rather than in turns of a loop', () => {
    // Every turn is a docker exec plus a sleep, so a loop that counts to 300
    // waits nearer 390 seconds. The name says seconds, so the clock decides.
    assert.doesNotMatch(script, /seq 1 "\$FFMPEG_WAIT_SECONDS"/);
    assert.match(script, /install_deadline=\$\(\(SECONDS \+ FFMPEG_WAIT_SECONDS\)\)/);
    assert.match(script, /while \[ "\$SECONDS" -lt "\$install_deadline" \]/);
  });

  it('waits for ffmpeg before it starts the playlist clock', () => {
    const waited = at('$FFMPEG_WAIT_SECONDS');
    const playlist = at('$PLAYLIST_WAIT_SECONDS');
    assert.ok(waited > 0, 'nothing waits for the install');
    assert.ok(playlist > 0, 'nothing waits for the playlist');
    assert.ok(waited < playlist, 'the playlist clock starts before the install is waited for');
  });

  it('catches a publisher that dies during the install, inside the wait rather than after it', () => {
    const wait = script.slice(at('install_deadline='), at('$PLAYLIST_WAIT_SECONDS'));
    assert.match(wait, /State\.Running/);
    assert.match(wait, /fail /);
  });

  it('keeps the playlist budget it had, because that is not where the time went', () => {
    assert.match(script, /^PLAYLIST_WAIT_SECONDS=40$/m);
  });
});
