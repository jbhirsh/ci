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

  // Trimmed from Playwright 1.64's junit reporter with includeRetries on and
  // retries: 2: two tests that failed and then passed, one that failed every try.
  const retried = `<testsuites tests="4" failures="1">
<testsuite name="a.spec.mjs" tests="4" failures="1">
<testcase name="flaky" classname="a.spec.mjs" time="0.01">
<system-out>
<![CDATA[try 1
]]>
</system-out>
<flakyFailure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe" time="0.012">
<stackTrace>
<![CDATA[Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 0
    at /w/a.spec.mjs:2:88]]>
</stackTrace>
<system-out>
<![CDATA[try 0
<failure>not mine</failure>
[[ATTACHMENT|../test-results/a-flaky/error-context.md]]
]]>
</system-out>
</flakyFailure>
</testcase>
<testcase name="throws then passes" classname="a.spec.mjs" time="0.004">
<flakyError message="boom &amp; &lt;bust&gt;" type="Error" time="0.006">
<stackTrace>
<![CDATA[Error: boom & <bust>
    at /w/a.spec.mjs:3:78]]>
</stackTrace>
</flakyError>
<flakyError message="second" type="Error" time="0.005">
<stackTrace>
<![CDATA[Error: second]]>
</stackTrace>
</flakyError>
</testcase>
<testcase name="always fails" classname="a.spec.mjs" time="0.024">
<rerunFailure message="retry's own" type="expect.toBe" time="0.008">
<stackTrace>
<![CDATA[Error: retry's own]]>
</stackTrace>
</rerunFailure>
<rerunError message="later" type="Error" time="0.01">
<stackTrace>
<![CDATA[Error: later]]>
</stackTrace>
</rerunError>
<failure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe">
<![CDATA[  a.spec.mjs:4:1 › always fails

    Error: expect(received).toBe(expected) // Object.is equality]]>
</failure>
</testcase>
<testcase name="fine" classname="a.spec.mjs" time="0.002">
</testcase>
</testsuite>
</testsuites>`;

  it("reads Playwright's retries: a pass with flaky tries passed on re-run, the first try's message", () => {
    expect(
      parseJunit(retried, 'pw.xml').map((c) => [c.name, c.seconds, c.result, c.message, c.detail]),
    ).toEqual([
      [
        'a.spec.mjs › flaky',
        0.01,
        'passed on re-run',
        'expect(received).toBe(expected) // Object.is equality',
        'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 1\nReceived: 0\n    at /w/a.spec.mjs:2:88',
      ],
      [
        'a.spec.mjs › throws then passes',
        0.004,
        'passed on re-run',
        'boom & <bust>',
        'Error: boom & <bust>\n    at /w/a.spec.mjs:3:78',
      ],
      [
        'a.spec.mjs › always fails',
        0.024,
        'failed',
        'expect(received).toBe(expected) // Object.is equality',
        'a.spec.mjs:4:1 › always fails\n\n    Error: expect(received).toBe(expected) // Object.is equality',
      ],
      ['a.spec.mjs › fine', 0.002, 'passed', '', ''],
    ]);
  });

  it('reads a flaky try with no stack trace from its message, never its captured output', () => {
    expect(
      parseJunit(
        '<testcase name="a"><flakyFailure message="timed out" time="30"/></testcase>' +
          '<testcase name="b"><flakyFailure><system-out>printed</system-out></flakyFailure></testcase>' +
          '<testcase name="c"><flakyError/></testcase>',
      ).map((c) => [c.result, c.message, c.detail]),
    ).toEqual([
      ['passed on re-run', 'timed out', 'timed out'],
      ['passed on re-run', '', ''],
      ['passed on re-run', '', ''],
    ]);
  });

  it('lets a failure, a skip or a failing status win over a flaky try', () => {
    expect(
      parseJunit(
        '<testcase name="a"><flakyFailure message="x"/><failure message="real"/></testcase>' +
          '<testcase name="b"><skipped/><flakyFailure message="x"/></testcase>' +
          '<testcase name="c" status="ERROR"><flakyError message="x"/></testcase>',
      ).map((c) => [c.result, c.message]),
    ).toEqual([
      ['failed', 'real'],
      ['skipped', ''],
      ['failed', ''],
    ]);
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
