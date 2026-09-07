/**
 * What stops a config file before the engine ever sees it.
 *
 * Unit test, no Docker and no database. `pnpm test` in manager/.
 *
 * SRS is asked itself, in test mode, through a command runner that is faked
 * here and records what it was asked to run. The check is what stands between
 * a typo and a media server that restarts forever, so what it refuses and the
 * words it refuses with are the whole point.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  type CommandResult,
  EngineConfigChecker,
} from '../../src/domain/engineConfig/engineConfigCheck.js';
import { omeXmlProblem } from '../../src/domain/engineConfig/omeXml.js';
import {
  placeholdersFilledBy,
  substituteForCheck,
} from '../../src/domain/engineConfig/placeholders.js';

const SRS_FILLS = [
  'PASSPHRASE_PLACEHOLDER',
  'HLS_FRAGMENT_PLACEHOLDER',
  'HLS_WINDOW_PLACEHOLDER',
  'TRANSCODE_PLACEHOLDER',
  'ABR_VHOST_PLACEHOLDER',
];

const SRS_OK: CommandResult = {
  code: 0,
  stdout:
    '[2026-09-07 04:58:09.791][INFO][1][a0q368z5] the config file /check/srs.conf syntax is ok\n' +
    '[2026-09-07 04:58:09.791][INFO][1][a0q368z5] config file /check/srs.conf test is successful\n',
  stderr: '',
};

const SRS_REFUSED: CommandResult = {
  code: 255,
  stdout:
    '[2026-09-07 04:58:12.836][INFO][1][2914ku12] config parse complete\n' +
    '[2026-09-07 04:58:12.836][INFO][1][2914ku12] invalid configcode=1023(ConfigInvalid) : check normal : illegal vhost.hls.hls_fragmnt of __defaultVhost__ in /check/srs.conf\n' +
    '[2026-09-07 04:58:12.836][INFO][1][2914ku12] config file /check/srs.conf test is failed\n',
  stderr: '',
};

function checkerAnswering(result: CommandResult) {
  const calls: { file: string; args: string[] }[] = [];
  const checker = new EngineConfigChecker(async (file, args) => {
    calls.push({ file, args });
    return result;
  });
  return { checker, calls };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'engine-config-check-'));
}

describe('substituteForCheck', () => {
  it('fills every placeholder with a parseable dummy and drops the line placeholders', () => {
    const text = substituteForCheck(
      'passphrase PASSPHRASE_PLACEHOLDER;\nhls_fragment HLS_FRAGMENT_PLACEHOLDER;\nTRANSCODE_PLACEHOLDER\nlisten SRT_PORT_PLACEHOLDER;\n',
    );

    assert.equal(
      text,
      'passphrase checkpassphrase16;\nhls_fragment 1.5;\nlisten 10080;\n',
    );
    assert.equal(/PLACEHOLDER/.test(text), false);
  });

  it('gives a token it has no value for a number rather than leaving it', () => {
    assert.equal(substituteForCheck('x SOMETHING_NEW_PLACEHOLDER;'), 'x 1;');
  });
});

describe('placeholdersFilledBy', () => {
  it('names every token the entrypoint mentions, once, in order', () => {
    const filled = placeholdersFilledBy(
      'sed -i "s/HLS_FRAGMENT_PLACEHOLDER/x/"\nsed -i "/PASSPHRASE_PLACEHOLDER/d"\nsed -i "s/HLS_FRAGMENT_PLACEHOLDER/y/"',
    );

    assert.deepEqual(filled, ['HLS_FRAGMENT_PLACEHOLDER', 'PASSPHRASE_PLACEHOLDER']);
  });
});

describe('the SRS check', () => {
  it('runs srs -t in a throwaway container of the version image on a filled copy', async () => {
    const { checker, calls } = checkerAnswering(SRS_OK);
    const scratchDir = scratch();

    const problem = await checker.problem({
      engine: 'srs',
      config: 'hls_fragment HLS_FRAGMENT_PLACEHOLDER;\n',
      image: 'ossrs/srs:6.0.184',
      filled: SRS_FILLS,
      scratchDir,
    });

    assert.equal(problem, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, 'docker');
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
    assert.ok(args.includes('--network') && args.includes('none'), 'no network for a parser');
    assert.ok(args.includes('ossrs/srs:6.0.184'), 'the version image');
    assert.deepEqual(args.slice(-4), ['./objs/srs', '-t', '-c', '/check/srs.conf']);
    const mount = args[args.indexOf('-v') + 1] ?? '';
    assert.ok(mount.startsWith(join(scratchDir, 'srs.conf.check')), mount);
    assert.ok(mount.endsWith(':/check/srs.conf:ro'), mount);
    assert.equal(existsSync(join(scratchDir, 'srs.conf.check')), false, 'the copy is removed afterwards');
  });

  it("answers SRS's own reason without its log prefix, naming your config", async () => {
    const { checker } = checkerAnswering(SRS_REFUSED);

    const problem = await checker.problem({
      engine: 'srs',
      config: 'hls_fragmnt 1.5;\n',
      image: null,
      filled: SRS_FILLS,
      scratchDir: scratch(),
    });

    assert.match(problem ?? '', /^SRS refused the file\. invalid config/);
    assert.match(problem ?? '', /illegal vhost\.hls\.hls_fragmnt of __defaultVhost__ in your config/);
    assert.equal(/\[INFO\]/.test(problem ?? ''), false);
    assert.equal(/parse complete/.test(problem ?? ''), false);
  });

  it('refuses a placeholder the version does not fill before running anything', async () => {
    const { checker, calls } = checkerAnswering(SRS_OK);

    const problem = await checker.problem({
      engine: 'srs',
      config: 'listen HLS_FRAGMENT_PLACEHOLDER;\nlatency SRT_LATENCY_PLACEHOLDER;\n',
      image: null,
      filled: SRS_FILLS,
      scratchDir: scratch(),
    });

    assert.match(problem ?? '', /SRT_LATENCY_PLACEHOLDER is not a placeholder this stack version fills/);
    assert.deepEqual(calls, []);
  });

  it('falls back to the default image when the version names none', async () => {
    const { checker, calls } = checkerAnswering(SRS_OK);

    await checker.problem({
      engine: 'srs',
      config: 'listen 1935;\n',
      image: null,
      filled: [],
      scratchDir: scratch(),
    });

    assert.ok(calls[0]?.args.includes('ossrs/srs:6'));
  });
});

describe('the OvenMediaEngine check', () => {
  const GOOD =
    '<?xml version="1.0"?>\n<Server version="8">\n  <AdmissionWebhooks>\n    <SecretKey>OME_ADMISSION_SECRET_PLACEHOLDER</SecretKey>\n  </AdmissionWebhooks>\n  <Bind><Providers><SRT /></Providers></Bind>\n</Server>\n';

  it('passes a well formed file with the admission element', () => {
    assert.equal(omeXmlProblem(GOOD), null);
  });

  it('names the line of a tag closed by the wrong one', () => {
    assert.equal(
      omeXmlProblem('<Server>\n  <Bind>\n  </Server>\n'),
      'Line 3: </Server> closes <Bind> opened on line 2.',
    );
  });

  it('names an element left open', () => {
    assert.equal(
      omeXmlProblem('<Server>\n  <AdmissionWebhooks></AdmissionWebhooks>\n'),
      '<Server> opened on line 1 is never closed.',
    );
  });

  it('ignores comments and the declaration when it counts tags', () => {
    assert.equal(
      omeXmlProblem('<!-- <Open> -->\n' + GOOD),
      null,
    );
  });

  it('refuses a file with no admission element, saying why', () => {
    assert.match(
      omeXmlProblem('<Server><Bind /></Server>') ?? '',
      /no <AdmissionWebhooks> element/,
    );
  });

  it('runs through the checker without a command runner being asked', async () => {
    const { checker, calls } = checkerAnswering(SRS_OK);

    const problem = await checker.problem({
      engine: 'ome',
      config: GOOD,
      image: null,
      filled: ['OME_ADMISSION_SECRET_PLACEHOLDER'],
      scratchDir: scratch(),
    });

    assert.equal(problem, null);
    assert.deepEqual(calls, []);
  });
});
