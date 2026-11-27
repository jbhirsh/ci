import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildModel } from './model.ts';
import { pagesBase, report, reportUrl, scriptJson, template } from './report.ts';
import type { Model } from './model.ts';
import type { Measurement } from '../probe/results.ts';

type Win = typeof globalThis;
type DomOptions = { runScripts: string; beforeParse: (window: Win) => void };
/** jsdom, which ships no types: the part of it these tests use. */
const { JSDOM }: { JSDOM: new (html: string, options: DomOptions) => { window: Win } } =
  createRequire(import.meta.url)('jsdom');

/**
 * A model with one of everything the page draws.
 */
const model = (): Model => ({
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
 */
function el(w: Win, selector: string) {
  const found = w.document.querySelector(selector);
  if (!(found instanceof w.HTMLElement)) throw new Error(`no ${selector}`);
  return found;
}

/**
 * The report page, run in jsdom.
 */
function open(m: Model) {
  const dom = new JSDOM(report(m), {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = (() => ({ matches: false })) as unknown as Win['matchMedia'];
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
    const $ = (s: string) => w.document.querySelector(s);
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
    // A long step name is cut short on the page, whole in its tooltip.
    expect($('#step-2 .stepname')?.getAttribute('title')).toBe('Test');
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
    const hidden = (id: string) => el(w, `#${id}`).hidden;
    expect(hidden('tests-card')).toBe(true);
    expect(hidden('history-card')).toBe(true);
    expect(hidden('notes-card')).toBe(true);
    expect(hidden('problem-card')).toBe(false);
    expect(w.document.getElementById('facts')?.textContent).toContain('No usual time yet');
  });
});

/**
 * A probe's measurements, as the model gives them: `name`'s request, cold
 * and warm, its browser time slower than its last 3 runs on main (each
 * `usualMs`).
 */
function measured(name = 'games', given?: Measurement[], usualMs = 230) {
  const rows: Measurement[] = given ?? [
    { name, phase: 'loaded', start: 'cold', ms: 800 },
    { name, phase: 'db-open', start: 'cold', ms: 40, atMs: 1 },
    { name, phase: 'total', start: 'cold', ms: 300 },
    { name, phase: 'browser', start: 'cold', ms: 1200, responseStartMs: 1150 },
    { name, phase: 'total', start: 'warm', ms: 34 },
    { name, phase: 'field.games', label: '<b>Query.games</b>', start: 'warm', ms: 20, atMs: 2 },
    { name, phase: 'browser', start: 'warm', ms: 410, responseStartMs: 300 },
    { name: 'session', phase: 'browser', start: 'warm', ms: 200, responseStartMs: 100 },
  ];
  const past = [3, 2, 1].map((n) => ({
    run: {
      id: n,
      run_number: n,
      html_url: `https://gh/run/${n}`,
      head_branch: 'main',
      head_sha: 'a',
      created_at: '2026-10-28T10:00:00Z',
    },
    job: { name: 'P', conclusion: 'success', started_at: null, completed_at: null },
    tests: null,
    recorded: false,
    seconds: null,
    measurements: {
      environment: 'production',
      values: [{ name, phase: 'browser', start: 'warm' as const, ms: usualMs }],
    },
  }));
  return buildModel({
    repo: 'o/r',
    workflow: 'W',
    job: 'P',
    noun: 'test',
    now: 0,
    run: null,
    current: null,
    steps: [],
    problem: '',
    tests: null,
    past: [],
    located: new Map(),
    changed: [],
    reportOf: () => '',
    notes: [],
    load: [],
    settle: null,
    measurements: {
      results: {
        version: 1,
        driver: 'web',
        target: '',
        environment: 'preview',
        measurements: rows,
        notes: ['cold carried by: <i>games</i>'],
      },
      past,
    },
  }).measurements;
}

describe('the measurements card', () => {
  it('is hidden without measurements', () => {
    expect(el(open(model()), '#measures-card').hidden).toBe(true);
    expect(el(open({ ...model(), measurements: null }), '#measures-card').hidden).toBe(true);
  });

  it('draws a lane per request, warm first, and its slower part in Needs attention', () => {
    const w = open({ ...model(), measurements: measured() });
    const all = (s: string) => [...w.document.querySelectorAll(s)];
    expect(el(w, '#measures-card').hidden).toBe(false);
    expect(el(w, '#measures-sub').textContent).toBe(
      "This run on preview, against the median of main's last 3 runs on production",
    );
    expect(all('#measures .lane').map((l) => l.querySelector('.opn')?.textContent)).toEqual([
      'requestgames',
      'requestsession',
    ]);
    expect(el(w, '#measures .lane.slow .mbig').textContent).toBe('410ms');
    expect(el(w, '#measures .lane.slow .mchip').textContent).toBe('+78%');
    expect(el(w, '#measures-notes').textContent).toBe('cold carried by: <i>games</i>');
    const item = el(w, '#attention [data-go^="measure:"]');
    expect(item.textContent).toContain(
      'games › browser, warm (measurement): 410ms, usually 230ms (+78%)',
    );
    // Opens its request and picks its row.
    item.click();
    expect(el(w, '#measures .wrow.sel').textContent).toContain('Browser');
    expect(el(w, '#measures .detail').textContent).toContain('230ms');
  });

  it('switches to the cold start, saying which request carried it', () => {
    const w = open({ ...model(), measurements: measured() });
    el(w, '#measures-card .mswitch button[data-mode="cold"]').click();
    const lanes = [...w.document.querySelectorAll('#measures .lane')];
    expect(lanes[0].querySelector('.why')?.textContent).toBe('67% starting up · server 300ms');
    expect(lanes[1].classList.contains('none')).toBe(true);
    expect(lanes[1].textContent).toContain('games carried this run’s cold start');
    el(w, '#measures button.sum[data-op="games"]').click();
    const names = [...w.document.querySelectorAll('#measures .wname')].map((n) => n.textContent);
    expect(names).toEqual([
      'Browser',
      'Loading the codeloaded',
      'Servertotal',
      'Opening the databasedb-open',
    ]);
    // A row picked shows its details, needing 3 runs for a usual; picked again, it closes.
    const row = () => el(w, '#measures .wrow[data-sel*="db-open"]');
    row().focus();
    row().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el(w, '#measures .detail').textContent).toContain('needs 3 runs (has 0)');
    expect(el(w, '#measures .detail pre').textContent).toBe('db-open;dur=40;start=1');
    expect(w.document.activeElement?.getAttribute('data-sel')).toBe(row().dataset.sel);
    row().click();
    expect(w.document.querySelector('#measures .detail')).toBeNull();
  });

  it('writes every name and note as text, never as HTML', () => {
    const w = open({ ...model(), measurements: measured('<img src=x onerror=alert(1)>') });
    el(w, '#measures button.sum').click();
    el(w, '#measures .wrow[data-sel*="field.games"]').click();
    expect(w.document.querySelector('#measures img, #measures-notes i, #attention img')).toBeNull();
    expect(el(w, '#measures .detail code').textContent).toBe('<b>Query.games</b>');
  });

  it('judges a lane with no browser row by its server, telling no network share', () => {
    const rows: Measurement[] = [
      { name: 'games', phase: 'loaded', start: 'cold', ms: 800 },
      { name: 'games', phase: 'total', start: 'cold', ms: 200 },
      { name: 'games', phase: 'browser', start: 'warm', ms: 400, responseStartMs: 300 },
    ];
    const w = open({ ...model(), measurements: measured('games', rows) });
    el(w, '#measures-card .mswitch button[data-mode="cold"]').click();
    expect(w.document.querySelector('#measures .lane.none')).toBeNull();
    expect(el(w, '#measures .lane .why').textContent).toBe('80% starting up · server 200ms');
    expect(el(w, '#measures .lane .mbig').textContent).toBe('200ms');
    el(w, '#measures button.sum').click();
    const names = [...w.document.querySelectorAll('#measures .wname')].map((n) => n.textContent);
    expect(names).toEqual(['Loading the codeloaded', 'Servertotal']);
  });

  it('draws a driver that writes no browser row at all', () => {
    const rows: Measurement[] = [
      { name: 'feed', phase: 'total', start: 'warm', ms: 50 },
      { name: 'feed', phase: 'field.feed', start: 'warm', ms: 30, atMs: 10 },
      { name: 'list', phase: 'render', start: 'warm', ms: 12 },
    ];
    const w = open({ ...model(), measurements: measured('feed', rows) });
    const lanes = [...w.document.querySelectorAll('#measures .lane')];
    expect(lanes.map((l) => l.classList.contains('none'))).toEqual([false, false]);
    expect(lanes[0].querySelector('.why')?.textContent).toBe('100% the server');
    // A lane with neither a server nor a start-up: its part's name.
    expect(lanes[1].querySelector('.why')?.textContent).toBe('render');
    expect(lanes[1].querySelector('.mbig')?.textContent).toBe('12ms');
  });

  it("draws the phases and fields of a request with no server row on the request's axis", () => {
    const rows: Measurement[] = [
      { name: 'games', phase: 'browser', start: 'warm', ms: 400, responseStartMs: 300 },
      { name: 'games', phase: 'db-open', start: 'warm', ms: 40, atMs: 0 },
      { name: 'games', phase: 'field.games', start: 'warm', ms: 20, atMs: 40 },
    ];
    const w = open({ ...model(), measurements: measured('games', rows) });
    el(w, '#measures button.sum').click();
    const names = [...w.document.querySelectorAll('#measures .wname')].map((n) => n.textContent);
    expect(names).toEqual(['Browser', 'Opening the databasedb-open', 'games']);
    expect(w.document.querySelectorAll('#measures .wgrid')).toHaveLength(1);
    // Needs attention's link to the slower browser row finds it.
    el(w, '#attention [data-go^="measure:"]').click();
    expect(el(w, '#measures .wrow.sel').textContent).toContain('Browser');
    // Every row Needs attention could name has a place on the page.
    for (const [k, m] of (measured('games', rows)?.rows ?? []).entries())
      if (m.start === 'warm') expect(w.document.getElementById(`measure-${k}`)).not.toBeNull();
  });

  it('draws a repeated field as long as its calls spanned, saying so beside its calls', () => {
    const rows: Measurement[] = [
      { name: 'games', phase: 'browser', start: 'warm', ms: 200, responseStartMs: 150 },
      { name: 'games', phase: 'total', start: 'warm', ms: 100 },
      {
        name: 'games',
        phase: 'field.games.wishlist.votes',
        label: 'Game.votes',
        start: 'warm',
        ms: 60,
        calls: 30,
        slowestMs: 2.4,
        atMs: 21,
        spanMs: 3.1,
      },
    ];
    const w = open({ ...model(), measurements: measured('games', rows) });
    el(w, '#measures button.sum').click();
    const row = () => el(w, '#measures .wrow[data-sel*="votes"]');
    // Inside the server, on its 100 ms: from 21 for 3.1, not for 60.
    expect(row().querySelector<HTMLElement>('.wbar')?.getAttribute('style')).toBe(
      'left:21.00%;width:3.10%',
    );
    expect(row().querySelector('.wval')?.textContent).toBe('60ms');
    row().click();
    expect(el(w, '#measures .detail').textContent).toContain('30 · slowest 2.4ms · over 3.1ms');
    expect(el(w, '#measures .detail pre').textContent).toBe(
      'field.games.wishlist.votes;dur=60;desc="Game.votes";calls=30;slowest=2.4;start=21;span=3.1',
    );
  });

  it('says how much more a part took when its usual is 0ms, never Infinity times', () => {
    const chip = (ms: number) => {
      const rows: Measurement[] = [{ name: 'games', phase: 'browser', start: 'warm', ms }];
      const w = open({ ...model(), measurements: measured('games', rows, 0) });
      const text = el(w, '#measures .lane .mchip').textContent;
      el(w, '#measures button.sum').click();
      el(w, '#measures .wrow').click();
      return [text, el(w, '#measures .detail').textContent?.includes('Infinity')];
    };
    expect(chip(30)).toEqual(['+30ms', false]);
    expect(chip(0)).toEqual(['≈ usual', false]);
  });

  it('says when there was nothing to measure', () => {
    const none = measured();
    if (!none) throw new Error('no measurements');
    const w = open({
      ...model(),
      measurements: { ...none, ops: [], rows: [], runs: [], environment: '' },
    });
    expect(el(w, '#measures').textContent).toBe('No measurements this run.');
    expect(el(w, '#measures-sub').textContent).toBe(
      'This run; main has no earlier runs to compare it with yet',
    );
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
