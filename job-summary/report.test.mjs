import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { pagesBase, report, reportUrl, scriptJson, template } from './report.mjs';

/**
 * jsdom, which ships no types: the part of it these tests use.
 *
 * @typedef {typeof globalThis} Win
 * @typedef {{ runScripts: string, beforeParse: (window: Win) => void }} DomOptions
 * @type {{ JSDOM: new (html: string, options: DomOptions) => { window: Win } }}
 */
const { JSDOM } = createRequire(import.meta.url)('jsdom');

/**
 * A model with one of everything the page draws.
 *
 * @returns {import('./model.mjs').Model}
 */
const model = () => ({
  repo: 'jbhirsh/ci',
  workflow: 'CI',
  job: 'Check',
  noun: 'test',
  problem: '',
  run: {
    number: 12,
    url: 'https://gh/job/12',
    sha: 'abcdef1234',
    branch: 'feat',
    when: '2026-10-29T10:00:00Z',
  },
  seconds: 70,
  usual: 60,
  steps: [
    {
      i: 1,
      name: 'Set up',
      start: 0,
      seconds: 5,
      conclusion: 'success',
      usual: 5,
      slower: false,
      past: [5, 5, null],
    },
    {
      i: 2,
      name: 'Test',
      start: 5,
      seconds: 65,
      conclusion: 'failure',
      usual: 50,
      slower: true,
      past: [50, 52, 49],
    },
  ],
  runs: [
    {
      number: 9,
      url: 'https://pages/runs/9/check/',
      sha: 'aaa1111',
      branch: 'main',
      when: '2026-10-28T10:00:00Z',
      seconds: 55,
      conclusion: 'success',
    },
    {
      number: 10,
      url: 'https://gh/job/10',
      sha: 'bbb2222',
      branch: 'feat',
      when: '2026-10-28T12:00:00Z',
      seconds: 62,
      conclusion: 'failure',
    },
    {
      number: 11,
      url: 'https://pages/runs/11/check/',
      sha: 'ccc3333',
      branch: 'main',
      when: '2026-10-29T08:00:00Z',
      seconds: 58,
      conclusion: 'success',
    },
  ],
  tests: [
    {
      name: 'a/x.test.mjs › block › </script><img src=x onerror=alert(1)>',
      folder: 'a/',
      file: 'x.test.mjs',
      block: 'block',
      title: '</script><img src=x onerror=alert(1)>',
      path: 'a/x.test.mjs',
      line: 4,
      seconds: 3,
      usual: 1,
      result: 'failed',
      slower: false,
      flaky: true,
      message: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'),
      hist: ['passed', 'failed', 'passed'],
      times: [1, 2, 1],
      edited: [1],
      code: [[4, "it('x', () => {", true]],
    },
    {
      name: 'a/y.test.mjs › keeps it',
      folder: 'a/',
      file: 'y.test.mjs',
      block: '',
      title: 'keeps it',
      path: '',
      line: 1,
      seconds: 4,
      usual: 1,
      result: 'passed',
      slower: true,
      flaky: false,
      message: '',
      hist: ['passed', '', 'passed'],
      times: [1, null, 1],
      edited: [],
      code: null,
    },
  ],
  notes: [['Simulator', 'iPhone 17 Pro']],
  load: [
    { t: 0, load: 300, busy: 95 },
    { t: 30, load: 40, busy: 20 },
    { t: 60, load: 30, busy: 15 },
  ],
  settle: 80,
});

/**
 * An element the page drew, to click or check.
 *
 * @param {Win} w
 * @param {string} selector
 */
function el(w, selector) {
  const found = w.document.querySelector(selector);
  if (!(found instanceof w.HTMLElement)) throw new Error(`no ${selector}`);
  return found;
}

/**
 * The report page, run in jsdom.
 *
 * @param {import('./model.mjs').Model} m
 */
function open(m) {
  const dom = new JSDOM(report(m), {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = /** @type {Win['matchMedia']} */ (
        /** @type {unknown} */ (() => ({ matches: false }))
      );
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = () => {
        throw new Error('the page ran a test name as HTML');
      };
    },
  });
  return dom.window;
}

describe('scriptJson', () => {
  it('writes JSON that no string can break out of a script element with', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const value = { a: '</script><b>', b: `x${ls}y${ps}z` };
    const text = scriptJson(value);
    expect(text.includes('<') || text.includes(ls) || text.includes(ps)).toBe(false);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('report', () => {
  it("fills the template's data slot, however it's laid out", () => {
    const page = '<p>x</p><script>\n  const data = /* __REPORT_DATA__ */ null;\n</script>';
    expect(report(model(), page)).toContain('<script>\n  const data = {"repo":"jbhirsh/ci"');
    expect(() => report(model(), '<p>no slot</p>')).toThrow('report.html has no data slot');
    expect(template()).toContain('__REPORT_DATA__');
  });

  it('draws the run: the verdict, what needs attention, the steps, the tests and the history', () => {
    const w = open(model());
    const $ = (/** @type {string} */ s) => w.document.querySelector(s);
    expect(w.document.title).toBe('Check · run #12');
    expect($('#title')?.textContent).toBe('Check 1 of 2 tests failed');
    expect($('#facts')?.textContent).toContain('Usual 1m 00s 17% slower');
    const tags = [...w.document.querySelectorAll('#attention .tag')].map((t) => t.textContent);
    expect(tags).toEqual(['Failed', 'Flaky', 'Slower', 'Slower']);
    expect(w.document.querySelectorAll('#steps tbody tr')).toHaveLength(2);
    const sort = el(w, '#steps .sortbtn[data-k="seconds"]');
    sort.click();
    expect(
      el(w, '#steps .sortbtn[data-k="seconds"]').closest('th')?.getAttribute('aria-sort'),
    ).toBe('ascending');
    expect(w.document.activeElement?.getAttribute('data-k')).toBe('seconds');
    el(w, '#steps .sortbtn[data-k="seconds"]').click();
    expect(w.document.querySelector('#steps tbody tr')?.id).toBe('step-2');
    expect($('#step-2 .seg.bad')).not.toBeNull();
    expect(w.document.querySelectorAll('#history rect.bar')).toHaveLength(4);
    expect($('#history text')).not.toBeNull();
    expect($('#notes')?.textContent).toBe('SimulatoriPhone 17 Pro');
    expect($('#load polyline')).not.toBeNull();
    expect($('#stepkey')?.textContent).toContain('2 Test');
    expect($('#foot')?.textContent).toContain('run #12');
  });

  it('shows a test name as text, never as HTML', () => {
    const w = open(model());
    expect(w.document.querySelector('#tree img')).toBeNull();
    expect(w.document.querySelector('#attention img')).toBeNull();
  });

  it('opens a failed test with its code, and a long message to its first lines', () => {
    const w = open(model());
    const row = w.document.querySelector('#tree [data-ti="0"]');
    expect(row?.querySelector('.code .hit')?.textContent).toContain("it('x', () => {");
    expect(row?.querySelector('a.t')?.getAttribute('href')).toBe(
      'https://github.com/jbhirsh/ci/blob/abcdef1234/a/x.test.mjs#L4',
    );
    const more = el(w, '#tree [data-ti="0"] .msgmore');
    expect(more.textContent).toBe('Show all 14 lines');
    more.click();
    expect(w.document.querySelector('#tree [data-ti="0"] .msgmore')?.textContent).toBe('Show less');
    expect(
      w.document.querySelector('#tree [data-ti="0"] .dots a.changed')?.getAttribute('data-h'),
    ).toBe('1');
  });

  it('filters the tests, and goes to one from Needs attention', () => {
    const w = open(model());
    const chip = el(w, '.chip[data-f="slower"]');
    chip.click();
    expect(w.document.querySelectorAll('#tree [data-ti]')).toHaveLength(1);
    const item = el(w, '#attention [data-go="test:0"]');
    item.click();
    expect(w.document.querySelector('.chip[aria-pressed="true"]')?.getAttribute('data-f')).toBe(
      'all',
    );
    expect(w.document.querySelector('#tree [data-ti="0"]')?.classList.contains('flash')).toBe(true);
    el(w, '.chip[data-f="all"]').click();
    expect(w.document.querySelector('#tree [data-ti="0"]')).not.toBeNull();
    // Enter on a control inside an item is left to that control.
    const key = () =>
      new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const onButton = key();
    el(w, '#attention [data-go="test:0"] .msgmore').dispatchEvent(onButton);
    expect(onButton.defaultPrevented).toBe(false);
    const onItem = key();
    el(w, '#attention [data-go="test:0"]').dispatchEvent(onItem);
    expect(onItem.defaultPrevented).toBe(true);
  });

  it('keeps its state readable to a screen reader and a keyboard', () => {
    const m = model();
    if (m.run) m.run.when = 'not a time';
    const w = open(m);
    expect(w.document.getElementById('crumbs')?.textContent).not.toContain('Invalid');
    const search = w.document.getElementById('q');
    if (!(search instanceof w.HTMLInputElement)) throw new Error('no search box');
    search.value = 'x';
    search.dispatchEvent(new w.Event('input'));
    const groups = [...w.document.querySelectorAll('#tree .group')];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.map((g) => g.getAttribute('aria-expanded'))).toEqual(groups.map(() => 'true'));
    const link = w.document.querySelector('#history a');
    link?.dispatchEvent(new w.FocusEvent('focus'));
    expect(w.document.getElementById('tip')?.textContent).toContain('Run #9');
  });

  it('keeps keyboard focus on the control that redrew the tree', () => {
    const w = open(model());
    for (const selector of ['#tree .codebtn', '#tree .msgmore']) {
      const button = el(w, selector);
      button.focus();
      button.click();
      expect(w.document.activeElement?.className).toBe(button.className);
      expect(w.document.activeElement).not.toBe(button);
    }
    const row = el(w, '#tree .group');
    const id = row.dataset.id;
    row.focus();
    row.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(w.document.activeElement?.getAttribute('data-id')).toBe(id);
    expect(w.document.activeElement).not.toBe(row);
  });

  it('hides what it has nothing for', () => {
    const w = open({
      ...model(),
      tests: null,
      runs: [],
      usual: null,
      notes: [],
      load: [],
      problem: 'the run could not be read',
    });
    const hidden = (/** @type {string} */ id) => el(w, `#${id}`).hidden;
    expect(hidden('tests-card')).toBe(true);
    expect(hidden('history-card')).toBe(true);
    expect(hidden('notes-card')).toBe(true);
    expect(hidden('problem-card')).toBe(false);
    expect(w.document.getElementById('facts')?.textContent).toContain('No usual time yet');
  });
});

describe('reportUrl and pagesBase', () => {
  it("names a run's report on the repository's Pages site", () => {
    expect(reportUrl('https://jbhirsh.github.io/sift/', 41, 'job-summary-e2e-tests-maestro')).toBe(
      'https://jbhirsh.github.io/sift/runs/41/e2e-tests-maestro/',
    );
    expect(pagesBase('jbhirsh/BoardGames')).toBe('https://jbhirsh.github.io/BoardGames');
    expect(pagesBase('JBHirsh/jbhirsh.github.io')).toBe('https://jbhirsh.github.io');
    expect(pagesBase('nope')).toBe('');
  });
});
