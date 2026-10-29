import { describe, expect, it } from 'vitest';
import {
  DETAIL_LENGTH,
  MESSAGE_LENGTH,
  escapeXml,
  parseJunit,
  settleReruns,
  unescapeXml,
} from './junit.mjs';

describe('unescapeXml and escapeXml', () => {
  it('replaces named and numeric entities, and leaves unknown ones', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(unescapeXml('&#233;&#xE9;&#XE9;')).toBe('ééé');
    expect(unescapeXml('&nbsp; &#x110000; &#99999999;')).toBe('&nbsp; &#x110000; &#99999999;');
  });

  it('escapes what would read as markup, and reads back', () => {
    expect(escapeXml('<a> & </a>')).toBe('&lt;a&gt; &amp; &lt;/a&gt;');
    expect(unescapeXml(escapeXml('x < y && "z" > w'))).toBe('x < y && "z" > w');
  });
});

describe('parseJunit', () => {
  it("reads Maestro's report: a status attribute, failures inside with their message", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="iPhone 17 Pro" tests="2" failures="1" time="61.5">
    <testcase id="Swipe to Keep and Remove" name="Swipe to Keep and Remove" classname="Swipe to Keep and Remove" file=".maestro/19_swipe_decisions.yaml" time="30.738" timestamp="2026-10-29T06:56:07" status="ERROR">
      <failure>
        Assertion is false: "1 kept", id: stat-kept is visible
        at step 12
      </failure>
    </testcase>
    <testcase id="Setup" name="Setup &amp; sort" classname="Setup &amp; sort" file=".maestro/01_setup.yaml" time="12.1" status="SUCCESS"/>
  </testsuite>
</testsuites>`;
    expect(parseJunit(xml, 'suite.xml')).toEqual([
      {
        name: 'Swipe to Keep and Remove',
        seconds: 30.738,
        result: 'failed',
        file: 'suite.xml',
        message: 'Assertion is false: "1 kept", id: stat-kept is visible',
        detail: 'Assertion is false: "1 kept", id: stat-kept is visible\n        at step 12',
        suite: 'Swipe to Keep and Remove',
        source: '.maestro/19_swipe_decisions.yaml',
      },
      {
        name: 'Setup & sort',
        seconds: 12.1,
        result: 'passed',
        file: 'suite.xml',
        message: '',
        detail: '',
        suite: 'Setup & sort',
        source: '.maestro/01_setup.yaml',
      },
    ]);
  });

  it('counts a status other than a success as failed, even with nothing inside', () => {
    const xml =
      '<testcase name="a" status="CANCELED"/><testcase name="b" status="STOPPED"/>' +
      '<testcase name="c" status="WARNING"/><testcase name="d" status="passed"/>';
    expect(parseJunit(xml).map((c) => [c.result, c.message])).toEqual([
      ['failed', ''],
      ['failed', ''],
      ['passed', ''],
      ['passed', ''],
    ]);
  });

  it("reads Playwright's and Vitest's: the file before the name, errors and skips as elements", () => {
    const xml = `<testsuite>
<testcase name='home › filters by players' classname="e2e/home.spec.ts" time="4.2"></testcase>
<testcase name="phone › opens the menu" time="1.5"><error message="boom &amp; bust" type="Error">stack</error></testcase>
<testcase name="offline › later" time="0"><skipped/></testcase>
<testcase name="status skip" status="skipped"/>
</testsuite>`;
    expect(parseJunit(xml).map((c) => [c.name, c.seconds, c.result, c.message])).toEqual([
      ['e2e/home.spec.ts › home › filters by players', 4.2, 'passed', ''],
      ['phone › opens the menu', 1.5, 'failed', 'boom & bust'],
      ['offline › later', 0, 'skipped', ''],
      ['status skip', 0, 'skipped', ''],
    ]);
  });

  it('ignores what captured output and comments hold, but keeps a message in CDATA', () => {
    const xml = `<testsuite>
<testcase name="prints errors" time="1"><system-out><![CDATA[<error>not mine</error> <skipped/>
</testcase><testcase name="ghost" time="99"/>]]></system-out></testcase>
<!-- <testcase name="commented out"/> -->
<testcase name="real failure" time="2"><failure><![CDATA[expected <a> to be <b>
  at x.test.ts:3]]></failure></testcase>
<!-- an unclosed comment <testcase name="hidden"/>`;
    expect(parseJunit(xml).map((c) => [c.name, c.result, c.message])).toEqual([
      ['prints errors', 'passed', ''],
      ['real failure', 'failed', 'expected <a> to be <b>'],
    ]);
  });

  it('keeps the whole message for the report, once, without frames inside node_modules', () => {
    const [repeats, adds, long] = parseJunit(
      `<testcase name="a"><failure message="expected 1 to be 2">AssertionError: expected 1 to be 2
 ❯ helper node_modules/fast-check/lib/fast-check.js:12:3
 ❯ a.test.ts:3:9
    at run (node_modules/vitest/dist/x.js:1:1)</failure></testcase>` +
        `<testcase name="b"><failure message="boom">stack line</failure></testcase>` +
        `<testcase name="c"><failure>${'y'.repeat(5000)}</failure></testcase>`,
    );
    expect(repeats.detail).toBe('AssertionError: expected 1 to be 2\n ❯ a.test.ts:3:9');
    expect(adds.detail).toBe('boom\nstack line');
    expect(long.detail).toHaveLength(DETAIL_LENGTH);
    const [own] = parseJunit(
      '<testcase name="d"><failure message="x">x\n at y</failure></testcase>',
    );
    expect(own.detail).toBe('x\n at y');
    const [attrOnly] = parseJunit('<testcase name="e"><failure message="only this"/></testcase>');
    expect(attrOnly.detail).toBe('only this');
  });

  it('trims a long message to its length', () => {
    const [c] = parseJunit(`<testcase name="t"><failure message="${'x'.repeat(500)}"/></testcase>`);
    expect(c.message).toHaveLength(MESSAGE_LENGTH);
    expect(c.message.endsWith('…')).toBe(true);
  });

  it('names a case by its classname or file when it has no name, and zeroes a bad time', () => {
    expect(
      parseJunit(
        '<testcase classname="pkg/Only class" time="abc"/><testcase file="f.yaml" time="-3"/><testcase/>',
      ).map((c) => [c.name, c.seconds]),
    ).toEqual([
      ['pkg/Only class', 0],
      ['f.yaml', 0],
      ['?', 0],
    ]);
  });

  it('keeps a ">" inside an attribute, and finds nothing in what isn\'t JUnit', () => {
    expect(parseJunit('<testcase name="a > b" time="1"/>')[0].name).toBe('a > b');
    expect(parseJunit('<html><body>not junit</body></html>')).toEqual([]);
    expect(parseJunit('')).toEqual([]);
  });
});

describe('settleReruns', () => {
  /**
   * @param {string} name
   * @param {import('./junit.mjs').TestCase['result']} result
   * @param {string} file
   * @returns {import('./junit.mjs').TestCase}
   */
  const tc = (name, result, file) => ({
    name,
    seconds: 1,
    result,
    file,
    message: '',
    detail: '',
    suite: '',
    source: '',
  });

  it('reads a failure that passed in another report as passed on re-run, in either order', () => {
    expect(
      settleReruns([
        tc('Swipe', 'passed', '19_swipe.retry.xml'),
        tc('Swipe', 'failed', 'suite.xml'),
        tc('Setup', 'failed', 'suite.xml'),
        tc('Undo', 'failed', 'suite.xml'),
        tc('Undo', 'passed', 'Undo.retry.xml'),
      ]).map((c) => c.result),
    ).toEqual(['passed', 'passed on re-run', 'failed', 'passed on re-run', 'passed']);
  });

  it('leaves a failure alone when its re-run failed too, or it passed only in its own report', () => {
    expect(
      settleReruns([
        tc('B', 'failed', 'one.xml'),
        tc('B', 'failed', 'B.retry.xml'),
        tc('C', 'failed', 'one.xml'),
        tc('C', 'passed', 'one.xml'),
      ]).map((c) => c.result),
    ).toEqual(['failed', 'failed', 'failed', 'passed']);
  });
});
