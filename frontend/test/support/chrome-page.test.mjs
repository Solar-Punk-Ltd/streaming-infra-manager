/**
 * The reads and the clicks the Chrome suites share, exercised without a Chrome.
 *
 * Every one of them exists because the two-step shape it replaces is a race:
 * a read of a page that has no body yet throws instead of answering, and a
 * wait that finds a control followed by an evaluate that clicks it are two
 * reads of a page that renders in between. The expressions these build are
 * plain JavaScript over `document`, so a stand-in document is enough to prove
 * what they answer, and a recording `evaluate` is enough to prove when they act.
 *
 * A Node-only file: no browser, no Vite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  pageShows,
  paintedInView,
  pointToClick,
  readWhenPresent,
  stillWithin,
} from './chrome.mjs';

/** The window names these expressions reach for besides `document`, and Node has none of them. */
const PAGE_GLOBALS = ['HTMLInputElement', 'HTMLTextAreaElement', 'innerHeight'];

/** Runs one of these expressions over a stand-in page, which is all they touch. */
const inPage = (expression, document, globals = {}) =>
  new Function('document', ...PAGE_GLOBALS, `return ${expression};`)(document, ...PAGE_GLOBALS.map((name) => globals[name]));

const NO_BODY_YET = { body: null };
const showing = (text) => ({ body: { innerText: text } });

/** An `evaluate` that answers what the page would, and remembers every expression it was given. */
function pageOf(document, globals) {
  const seen = [];
  return {
    seen,
    evaluate: async (expression) => {
      seen.push(expression);
      return inPage(expression, document, globals);
    },
  };
}

function elementNamed(name, extra = {}) {
  return { name, clicks: 0, click() { this.clicks++; }, scrollIntoView() {}, getBoundingClientRect: () => ({ x: 10, y: 20, width: 40, height: 8 }), ...extra };
}

describe('what the page shows', () => {
  it('answers false rather than throwing while a navigation has left no body', () => {
    assert.equal(inPage(pageShows('Recovery actions'), NO_BODY_YET), false);
  });

  it('answers whether the text is on the page', () => {
    assert.equal(inPage(pageShows('Recovery actions'), showing('Transfer. Recovery actions. Sign out.')), true);
    assert.equal(inPage(pageShows('Recovery actions'), showing('Transfer history')), false);
  });
});

describe('the button an expression names', () => {
  const document = {
    querySelectorAll: () => [
      { textContent: ' Record assertion ' },
      { textContent: 'Record operator assertion' },
    ],
  };

  it('takes the one whose own text matches once trimmed', () => {
    assert.equal(inPage(buttonWithText('Record assertion'), document).textContent, ' Record assertion ');
  });

  it('takes nothing when no button says it', () => {
    assert.equal(inPage(buttonWithText('Sign out'), document), undefined);
  });
});

describe('an element the page paints where it is laid out', () => {
  const title = { name: 'the row title' };
  const row = {
    getBoundingClientRect: () => ({ left: 0, width: 200, top: 100, bottom: 300 }),
    contains(node) { return node === this || node === title; },
  };
  const paintingAt = (paint) => ({ row, missing: null, elementFromPoint: (_x, y) => paint(y) });
  const TALL = { innerHeight: 900 };

  it('answers true when the page paints the element at its top edge and at its bottom edge', () => {
    assert.equal(inPage(paintedInView('document.row'), paintingAt(() => title), TALL), true);
  });

  it('answers false while something else is painted over its top, as a fold that is still opening leaves it', () => {
    const heading = { name: 'the section heading' };
    assert.equal(inPage(paintedInView('document.row'), paintingAt((y) => (y < 200 ? heading : title)), TALL), false);
  });

  it('answers false when the element reaches past the viewport, and when there is none', () => {
    assert.equal(inPage(paintedInView('document.row'), paintingAt(() => title), { innerHeight: 250 }), false);
    assert.equal(inPage(paintedInView('document.missing'), paintingAt(() => title), TALL), false);
  });
});

describe('an element with nothing inside it animating', () => {
  const fold = { name: 'a fold opening' };
  const card = { contains(node) { return node === this || node === fold; } };
  const animating = (...targets) => ({ card, missing: null, getAnimations: () => targets.map((target) => ({ effect: target && { target } })) });

  it('answers true when nothing animates, or only something outside it, or an animation with no effect', () => {
    assert.equal(inPage(stillWithin('document.card'), animating()), true);
    assert.equal(inPage(stillWithin('document.card'), animating({ name: 'a spinner elsewhere' }, null)), true);
  });

  it('answers false while something inside it animates', () => {
    assert.equal(inPage(stillWithin('document.card'), animating({ name: 'a spinner elsewhere' }, fold)), false);
  });

  it('answers false when there is no such element', () => {
    assert.equal(inPage(stillWithin('document.missing'), animating()), false);
  });
});

describe('a click that waits for what it clicks', () => {
  it('clicks the element once, and only once it is there', async () => {
    const button = elementNamed('Continue');
    let renders = 0;
    const page = pageOf({ get button() { return ++renders < 3 ? null : button; } });

    await clickWhenEnabled(page.evaluate, 'document.button', 'the Continue button');

    assert.equal(button.clicks, 1);
    assert.equal(renders, 3);
  });

  it('waits out a disabled control rather than clicking it, and names it when it never enables', async () => {
    const button = elementNamed('Save', { disabled: true });
    const page = pageOf({ button });

    await assert.rejects(
      () => clickWhenEnabled(page.evaluate, 'document.button', 'an enabled Save button', 40),
      /Timed out waiting for an enabled Save button/,
    );
    assert.equal(button.clicks, 0);
  });

  it('finds and clicks in one expression, so nothing renders in between', async () => {
    const page = pageOf({ button: elementNamed('Continue') });

    await clickWhenEnabled(page.evaluate, 'document.button', 'the Continue button');

    assert.equal(page.seen.length, 1);
  });
});

describe('a point to click, for the suites that drive a real mouse', () => {
  it('answers the middle of the element, after scrolling it into view', async () => {
    let scrolled = 0;
    const page = pageOf({ button: elementNamed('Set as default', { scrollIntoView() { scrolled++; } }) });

    assert.deepEqual(await pointToClick(page.evaluate, 'document.button', 'the Set as default button'), { x: 30, y: 24 });
    assert.equal(scrolled, 1);
  });

  it('names what it never found', async () => {
    const page = pageOf({ button: null });

    await assert.rejects(
      () => pointToClick(page.evaluate, 'document.button', 'the Remove button in the dialog', 40),
      /Timed out waiting for the Remove button in the dialog/,
    );
  });
});

describe('a property read that waits for its element', () => {
  it('answers the property once the element is there', async () => {
    let renders = 0;
    const page = pageOf({ get field() { return ++renders < 2 ? null : { value: 'retained-uploader' }; } });

    assert.equal(await readWhenPresent(page.evaluate, 'document.field', 'value', 'the deployment name'), 'retained-uploader');
  });

  it('takes a property that is false, which is a reading and not an absence', async () => {
    const page = pageOf({ field: { disabled: false } });

    assert.equal(await readWhenPresent(page.evaluate, 'document.field', 'disabled', 'the Save button state'), false);
  });

  it('names what it never found rather than throwing from inside the page', async () => {
    const page = pageOf({ field: null });

    await assert.rejects(
      () => readWhenPresent(page.evaluate, 'document.field', 'innerText', 'the open dialog', 40),
      /Timed out waiting for the open dialog/,
    );
  });
});

describe('a fill that waits for its field', () => {
  it('sets the value through the native setter and tells React with one input event', async () => {
    const events = [];
    const typed = {};
    const field = { tagName: 'INPUT', focus() { events.push('focus'); }, dispatchEvent: (event) => events.push(event.type) };
    const page = pageOf({ field }, {
      HTMLInputElement: { prototype: { set value(next) { typed.value = next; } } },
      HTMLTextAreaElement: { prototype: { set value(next) { typed.textarea = next; } } },
    });

    await fillWhenPresent(page.evaluate, 'document.field', 'operator-8', 'the username field');

    assert.deepEqual(typed, { value: 'operator-8' });
    assert.deepEqual(events, ['focus', 'input']);
  });

  it('sets a textarea through the setter a textarea has, which is not the input one', async () => {
    const typed = {};
    const page = pageOf({ field: { tagName: 'TEXTAREA', focus() {}, dispatchEvent: () => true } }, {
      HTMLInputElement: { prototype: { set value(next) { typed.value = next; } } },
      HTMLTextAreaElement: { prototype: { set value(next) { typed.textarea = next; } } },
    });

    await fillWhenPresent(page.evaluate, 'document.field', 'retained note', 'the notes field');

    assert.deepEqual(typed, { textarea: 'retained note' });
  });

  it('waits out a disabled field rather than typing into it', async () => {
    const page = pageOf({ field: { tagName: 'INPUT', disabled: true } });

    await assert.rejects(
      () => fillWhenPresent(page.evaluate, 'document.field', '0.5', 'the editable amount', 40),
      /Timed out waiting for the editable amount/,
    );
  });
});
