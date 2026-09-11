/**
 * How the T02 harness judges eight concurrent parser checks, exercised
 * against answers recorded from the pinned SRS image on 2026-09-10.
 *
 * The harness itself starts eight containers and cannot run in a unit suite.
 * What can run here is the part that decides: which case each answer belongs
 * to, that an accepted file was accepted, and that a refusal names the
 * directive of its own file and no other file's. That last rule is the whole
 * point of T02, because a check that read another check's copy would refuse
 * with the wrong directive and still look like a refusal.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCEPTED_CASES,
  CHECK_CASES,
  REFUSED_CASES,
  applyCase,
  wrongAnswers,
} from '../docker/srsCheckIsolation.js';

/** The answers the pinned image gave on 2026-09-10, as the manager words them. */
const RECORDED: Record<string, string> = {
  'listen emptied':
    'SRS refused the file. invalid configcode=1023(ConfigInvalid) : check normal : listen requires params in your config',
  'max_connections without its semicolon':
    'SRS refused the file. invalid configcode=1023(ConfigInvalid) : parse buffer your config : root parse : read token, line=2, state=0 : line 2: unexpected end of line to parse token max_connections in your config',
  'pbkeylen without its semicolon':
    'SRS refused the file. invalid configcode=1023(ConfigInvalid) : parse buffer your config : root parse : parse dir : read token, line=24, state=0 : line 24: unexpected end of line to parse token pbkeylen in your config',
  'http_server left unclosed':
    'SRS refused the file. invalid configcode=1023(ConfigInvalid) : parse buffer your config : root parse : read token, line=5, state=0 : line 5: unexpected end of line to parse token http_server in your config',
};

const allRight = CHECK_CASES.map((one) => ({
  name: one.name,
  problem: one.accepted ? null : RECORDED[one.name] ?? null,
}));

/** A template that carries every anchor, so the edits are exercised without the submodule. */
const TEMPLATE = [...new Set(CHECK_CASES.map((one) => one.anchor))].join('\n');

describe('the eight cases', () => {
  it('is four files that differ in one directive value and four that break one directive', () => {
    assert.equal(CHECK_CASES.length, 8);
    assert.equal(ACCEPTED_CASES.length, 4);
    assert.equal(REFUSED_CASES.length, 4);
  });

  it('breaks a different directive in each refused file', () => {
    const directives = REFUSED_CASES.map((one) => one.directive);
    assert.equal(new Set(directives).size, 4);
  });

  it('changes a different directive in each accepted file', () => {
    assert.equal(new Set(ACCEPTED_CASES.map((one) => one.directive)).size, 4);
  });

  it('names no directive that is a piece of another, so a message cannot be read two ways', () => {
    for (const one of REFUSED_CASES) {
      for (const other of REFUSED_CASES) {
        if (one === other) continue;
        assert.ok(!one.directive.includes(other.directive), `${one.directive} contains ${other.directive}`);
      }
    }
  });

  it('gives every case a name and an edit of its own', () => {
    assert.equal(new Set(CHECK_CASES.map((one) => one.name)).size, 8);
    assert.equal(new Set(CHECK_CASES.map((one) => applyCase(TEMPLATE, one))).size, 8);
  });

  it('refuses to edit a template that lost the line the case is about', () => {
    const one = CHECK_CASES[0];
    assert.throws(() => applyCase('nothing of the sort', one), /anchor/i);
  });

  it('really changes the template, so a case cannot pass by leaving it alone', () => {
    for (const one of CHECK_CASES) assert.notEqual(applyCase(TEMPLATE, one), TEMPLATE);
  });
});

describe('judging the eight answers', () => {
  it('says nothing when every file got the answer it should', () => {
    assert.deepEqual(wrongAnswers(allRight), []);
  });

  it('reports an accepted file that was refused, and names it', () => {
    const answers = allRight.map((answer) =>
      answer.name === ACCEPTED_CASES[0].name ? { ...answer, problem: 'SRS refused the file. something' } : answer,
    );
    const wrong = wrongAnswers(answers);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0], new RegExp(ACCEPTED_CASES[0].name));
    assert.match(wrong[0], /refused/);
  });

  it('reports a broken file that was accepted', () => {
    const answers = allRight.map((answer) =>
      answer.name === REFUSED_CASES[0].name ? { ...answer, problem: null } : answer,
    );
    const wrong = wrongAnswers(answers);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0], /accepted/);
  });

  it('reports a refusal that does not name its own directive', () => {
    const answers = allRight.map((answer) =>
      answer.name === REFUSED_CASES[1].name
        ? { ...answer, problem: 'SRS refused the file. invalid config : something went wrong somewhere' }
        : answer,
    );
    const wrong = wrongAnswers(answers);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0], new RegExp(REFUSED_CASES[1].directive));
  });

  it('reports a refusal that names another file directive, which is one check reading another copy', () => {
    const intruder = REFUSED_CASES[3].directive;
    const answers = allRight.map((answer) =>
      answer.name === REFUSED_CASES[1].name
        ? { ...answer, problem: `${RECORDED[REFUSED_CASES[1].name]} and also token ${intruder}` }
        : answer,
    );
    const wrong = wrongAnswers(answers);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0], new RegExp(intruder));
  });

  it('reports a refusal that names a directive only another accepted file changed', () => {
    // The four accepted files differ in one directive each, and two of those
    // directives appear in no refused file. A refusal carrying one of them is
    // the same cross-talk as a refusal carrying another refused file's, so the
    // scan covers every case rather than only the four that are refused.
    const onlyAccepted = ACCEPTED_CASES.map(one => one.directive)
      .find(directive => !REFUSED_CASES.some(other => other.directive === directive))!;
    const answers = allRight.map((answer) =>
      answer.name === REFUSED_CASES[0].name
        ? { ...answer, problem: `${RECORDED[REFUSED_CASES[0].name]} and also token ${onlyAccepted}` }
        : answer,
    );
    const wrong = wrongAnswers(answers);
    assert.equal(wrong.length, 1, wrong.join(' | '));
    assert.match(wrong[0], new RegExp(onlyAccepted));
  });

  it('reports a directive two cases share once, not once per case', () => {
    const shared = ACCEPTED_CASES.map(one => one.directive)
      .find(directive => REFUSED_CASES.some(other => other.directive === directive))!;
    const carrier = REFUSED_CASES.find(one => one.directive !== shared)!;
    const answers = allRight.map((answer) =>
      answer.name === carrier.name
        ? { ...answer, problem: `${RECORDED[carrier.name]} and also token ${shared}` }
        : answer,
    );
    const wrong = wrongAnswers(answers).filter(line => line.includes(shared));
    assert.equal(wrong.length, 1, wrong.join(' | '));
  });

  it('reports an answer that belongs to no case at all', () => {
    assert.match(wrongAnswers([{ name: 'not a case', problem: null }]).join(' '), /not a case/);
  });

  it('reports a case that never answered', () => {
    assert.match(wrongAnswers(allRight.slice(1)).join(' '), new RegExp(CHECK_CASES[0].name));
  });
});
