/**
 * What a config file for OvenMediaEngine has to keep from the version's
 * template, derived from the template itself rather than listed.
 *
 * Unit test, no Docker. `pnpm test` in manager/.
 *
 * The stack's uploader admits publishers through the admission webhook and
 * finds streams by application and stream name, so the file may change how
 * the engine encodes and serves but not where it calls back, what it binds,
 * which applications exist or how their streams are named. The two settings
 * the drawer fills may become literals, checked as the drawer would check
 * them, and T11 then reports them as controlled by the file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { settingsNotInConfig } from '@streaming-infra-manager/common';

import { omeContractProblem } from '../../src/domain/engineConfig/omeContract.js';
import { OME_TEMPLATE } from '../support/omeTemplate.js';

const edited = (from: string, to: string) => {
  assert.ok(OME_TEMPLATE.includes(from), `the template has ${from}`);
  return OME_TEMPLATE.replace(from, to);
};

describe('the template against itself', () => {
  it('keeps its own contract', () => {
    assert.equal(omeContractProblem(OME_TEMPLATE, OME_TEMPLATE), null);
  });

  it('keeps it with the applications and the blocks inside one in another order', () => {
    const [head, video, audio] = OME_TEMPLATE.split(/(?=<Application>)/);
    const [audioBody, tail] = audio!.split(/(?=<\/Applications>)/);
    const reordered = head! + audioBody! + video! + tail!;
    assert.notEqual(reordered, OME_TEMPLATE);
    const providersFirst = reordered.replace(
      /(<Providers>\s*<SRT \/>\s*<\/Providers>)(\s*)(<Publishers>[\s\S]*?<\/Publishers>)/,
      '$3$2$1',
    );

    assert.equal(omeContractProblem(OME_TEMPLATE, providersFirst), null);
  });

  it('allows more than the template has', () => {
    const more = edited(
      '</Applications>',
      '<Application><Name>extra</Name><Type>live</Type></Application></Applications>',
    ).replace('<Bind>', '<Managers><API><Port>8082</Port></API></Managers><Bind>');

    assert.equal(omeContractProblem(OME_TEMPLATE, more), null);
  });

  it('reads through comments and CDATA', () => {
    const noisy = OME_TEMPLATE.replace('<Name>video</Name>', '<!-- the main one --><Name><![CDATA[video]]></Name>');

    assert.equal(omeContractProblem(OME_TEMPLATE, noisy), null);
  });
});

describe('the protected part', () => {
  it('refuses a changed callback route with every placeholder still in place', () => {
    const problem = omeContractProblem(
      OME_TEMPLATE,
      edited('/engines/ome/admission', '/engines/ome/admit'),
    );

    assert.match(problem ?? '', /AdmissionWebhooks\/ControlServerUrl/);
    assert.match(problem ?? '', /engines\/ome\/admission/);
  });

  it('refuses the secret placeholder made a literal', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, edited('OME_ADMISSION_SECRET_PLACEHOLDER', 'hunter2')) ?? '',
      /SecretKey/,
    );
  });

  it('refuses a removed bind port', () => {
    const problem = omeContractProblem(
      OME_TEMPLATE,
      edited('<HLS>\n                <Port>8081</Port>\n            </HLS>', '<HLS/>'),
    );

    assert.match(problem ?? '', /Bind\/Publishers\/HLS\/Port/);
  });

  it('refuses admission enabled for another provider', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, edited('<Providers>srt</Providers>', '<Providers>rtmp</Providers>')) ?? '',
      /Enables\/Providers/,
    );
  });

  it('refuses a renamed application', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, edited('<Name>video</Name>', '<Name>main</Name>')) ?? '',
      /Application.*video/,
    );
  });

  it("refuses an application without the template's provider", () => {
    const problem = omeContractProblem(
      OME_TEMPLATE,
      edited('<Providers>\n                        <SRT />\n                    </Providers>', '<Providers/>'),
    );

    assert.match(problem ?? '', /Application.*video.*Providers\/SRT/);
  });

  it('refuses a changed stream name mapping', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, edited('${OriginStreamName}', 'fixed')) ?? '',
      /OutputStreamName/,
    );
  });

  it('refuses a file with no admission element at all', () => {
    const without = OME_TEMPLATE.replace(/<AdmissionWebhooks>[\s\S]*?<\/AdmissionWebhooks>/, '');

    assert.match(omeContractProblem(OME_TEMPLATE, without) ?? '', /AdmissionWebhooks/);
  });
});

describe('the tunable part', () => {
  it('accepts the segment duration as a literal in range, and T11 reports it as controlled by the file', () => {
    const literal = OME_TEMPLATE.split('SEGMENT_DURATION_PLACEHOLDER').join('4');

    assert.equal(omeContractProblem(OME_TEMPLATE, literal), null);
    assert.deepEqual(settingsNotInConfig('ome', literal), ['HLS_SEGMENT_DURATION']);
  });

  it("refuses a literal outside the setting's range, naming the range", () => {
    const problem = omeContractProblem(
      OME_TEMPLATE,
      OME_TEMPLATE.split('SEGMENT_DURATION_PLACEHOLDER').join('45'),
    );

    assert.match(problem ?? '', /Segment duration/);
    assert.match(problem ?? '', /0\.5/);
    assert.match(problem ?? '', /30/);
  });

  it('refuses a count that is not a whole number', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, OME_TEMPLATE.split('SEGMENT_COUNT_PLACEHOLDER').join('2.5')) ?? '',
      /Segment count/,
    );
  });

  it('refuses a literal that is not a number', () => {
    assert.match(
      omeContractProblem(OME_TEMPLATE, OME_TEMPLATE.split('SEGMENT_DURATION_PLACEHOLDER').join('fast')) ?? '',
      /Segment duration/,
    );
  });

  it('refuses the setting removed from one application only', () => {
    const oneGone = OME_TEMPLATE.replace('<SegmentDuration>SEGMENT_DURATION_PLACEHOLDER</SegmentDuration>', '');

    assert.match(omeContractProblem(OME_TEMPLATE, oneGone) ?? '', /SegmentDuration/);
  });
});
