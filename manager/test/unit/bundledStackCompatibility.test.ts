/**
 * The manager contract against the real swarm-hls-stream checkout, whichever
 * commit the submodule pins.
 *
 * This file deliberately reads the submodule instead of a reduced fixture.
 * A release can change compose, env samples, or an engine entrypoint without
 * changing the fixture, and those are the files the manager deploys.
 */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { OME_SERVICE, SRS_SERVICE } from '@streaming-infra-manager/common';

import {
  type CommandRunner,
  EngineConfigChecker,
} from '../../src/domain/engineConfig/engineConfigCheck.js';
import { engineTemplateIn } from '../../src/domain/engineConfig/engineConfigTemplates.js';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import { writeProfileEnv } from '../../src/utils/envUtils.js';

const STACK = fileURLToPath(
  new URL('../../swarm-hls-stream/', import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), 'bundled-stack-'));

after(() => rmSync(scratch, { recursive: true, force: true }));

function assignment(text: string, key: string): string | undefined {
  return text
    .split('\n')
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

describe('the bundled swarm-hls-stream contract', () => {
  it('is a complete deployable contract with both engines', () => {
    assert.ok(
      existsSync(join(STACK, 'deploy', 'docker-compose.yml')),
      'initialize manager/swarm-hls-stream before running this test',
    );

    const contract = readStackContract(STACK);

    assert.equal(contract.ports.length, 16);
    assert.equal(contract.allocationProblem, null);
    assert.deepEqual(contract.warnings, []);
    assert.deepEqual(contract.requiredSecrets, [
      'API_AUTH_TOKEN',
      'SRS_WEBHOOK_TOKEN',
      'OME_ADMISSION_SECRET',
    ]);
    assert.deepEqual(contract.engineConfig, { srs: true, ome: true });
    assert.equal(contract.features.sharedImageTags, false);
    assert.equal(contract.engineDefaults.HLS_FRAGMENT, '0.5');
    assert.equal(contract.engineDefaults.HLS_SEGMENT_DURATION, '2');
    assert.equal(
      contract.engineDefaults.SRT_LATENCY,
      '2000',
      'the bundled stack waits 2000 ms for a lost SRT packet unless SRT_LATENCY is set',
    );
  });

  it('makes ingest wait the configured SRT latency, because the SRS template fills recvlatency as well as latency', () => {
    const template = engineTemplateIn(STACK, SRS_SERVICE).text;

    assert.match(
      template,
      /^\s*latency\s+SRT_LATENCY_PLACEHOLDER\s*;/m,
      'the SRS template must fill latency from SRT_LATENCY',
    );
    assert.match(
      template,
      /^\s*recvlatency\s+SRT_LATENCY_PLACEHOLDER\s*;/m,
      'SRS defaults recvlatency to 120 ms and applies it after latency, so a template that fills latency alone waits 120 ms on ingest',
    );
  });

  it('writes the bundled deployment secrets while leaving optional admin mode off', () => {
    const root = join(scratch, 'env');
    mkdirSync(root);
    cpSync(join(STACK, '.env.sample'), join(root, '.env'));
    const contract = readStackContract(STACK);
    const stackSecrets = Object.fromEntries(
      contract.requiredSecrets.map((key) => [key, 'a'.repeat(64)]),
    );

    const path = writeProfileEnv(root, 'bundled', {
      engine: SRS_SERVICE,
      localBeeUploader: true,
      stackEngineDefaults: contract.engineDefaults,
      stackSecrets,
    });
    const written = readFileSync(path, 'utf8');

    assert.equal(assignment(written, 'ENGINE'), SRS_SERVICE);
    for (const key of contract.requiredSecrets) {
      assert.equal(assignment(written, key), 'a'.repeat(64));
    }
    assert.equal(
      assignment(written, 'ADMIN_API_URL'),
      '',
      'admin mode stays off unless an operator configures its URL',
    );
    assert.equal(
      assignment(written, 'ADMIN_API_TOKEN'),
      '',
      'the optional admin token remains unset with admin mode off',
    );
  });

  it('admits both shipped engine templates through their bundled entrypoints', async () => {
    const contract = readStackContract(STACK);
    const srsImage = contract.engineImages.srs;
    assert.ok(srsImage, 'the bundled SRS service must declare its parser image');
    let srsChecks = 0;
    const runner: CommandRunner = async (_file, args) => {
      srsChecks += 1;
      const mount = args[args.indexOf('--mount') + 1] ?? '';
      const source = mount
        .split(',')
        .find((part) => part.startsWith('source='))
        ?.slice('source='.length);
      assert.ok(source, 'the SRS admission check must mount its prepared file');
      assert.doesNotMatch(
        readFileSync(source, 'utf8'),
        /[A-Z][A-Z0-9_]*_PLACEHOLDER/,
        'the bundled entrypoint must account for every shipped SRS placeholder',
      );
      assert.ok(args.includes(srsImage));
      return { code: 0, stdout: '', stderr: '' };
    };
    const checker = new EngineConfigChecker(runner);

    for (const engine of [SRS_SERVICE, OME_SERVICE] as const) {
      const template = engineTemplateIn(STACK, engine);
      assert.equal(
        await checker.problem({
          engine,
          config: template.text,
          image: contract.engineImages[engine],
          filled: template.placeholders,
          template: template.text,
          scratchDir: join(scratch, engine),
        }),
        null,
      );
    }
    assert.equal(
      srsChecks,
      1,
      'OME is checked as XML without starting a container',
    );
  });
});
