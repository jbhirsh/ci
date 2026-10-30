// JUnit XML, read for job-summary (summary.mjs): each test's name, time,
// result, where it is (its suite and file attributes, which source.mjs turns
// into a path) and, for a failure, its message. A test retried within one
// report is read from Surefire's elements, which Playwright's reporter writes
// with its `includeRetries` option (off by default; or
// PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1): a passing test with a `<flakyFailure>`
// or `<flakyError>` for each try that failed passed on re-run; one that failed
// every try keeps its first try's `<failure>` or `<error>`, with a
// `<rerunFailure>` or `<rerunError>` for each later one, and reads failed.
// Without that option Playwright writes a retried pass as a plain pass, its
// time every try's, and nothing here can tell. Read with patterns rather than an
// XML library, as this repo installs nothing in the app. Comments are taken
// out first, and CDATA sections (captured output, messages) are turned into
// escaped text, so what they hold can't pass for elements while a failure's
// message survives. Anything that isn't JUnit yields no tests, never an
// error.

/**
 * One test (a flow, a spec) from a JUnit report.
 *
 * @typedef {object} TestCase
 * @property {string} name
 * @property {number} seconds
 * @property {'passed' | 'failed' | 'skipped' | 'passed on re-run'} result
 * @property {string} file the report it came from
 * @property {string} message a failure's first line ('' otherwise)
 * @property {string} detail a failure's whole message, up to DETAIL_LENGTH
 * @property {string} suite its classname: Vitest's and Playwright's file
 * @property {string} source its file attribute: Maestro's flow
 */

const ENTITIES = /** @type {Record<string, string>} */ ({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/** How much of a failure's first line to keep. */
export const MESSAGE_LENGTH = 300;
/** How much of a failure's whole message to keep, for the report. */
export const DETAIL_LENGTH = 4000;

/**
 * Text with XML's entities replaced.
 *
 * @param {string} text
 */
export function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const n =
      code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/**
 * Text escaped as XML would carry it.
 *
 * @param {string} text
 */
export function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A tag's attributes.
 *
 * @param {string} tag the text after the element's name, up to its `>`
 * @returns {Record<string, string>}
 */
function attributes(tag) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    found[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
  }
  return found;
}

/**
 * The first line of a failure's message, trimmed to MESSAGE_LENGTH.
 *
 * @param {string} text
 */
function firstLine(text) {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > MESSAGE_LENGTH ? `${line.slice(0, MESSAGE_LENGTH - 1)}…` : line;
}

/**
 * A test's name: its suite's (Vitest's and Playwright's file) and its own,
 * so tests named alike in two files stay apart (every tool's selftest.test.mjs
 * here has a "selftest" block); just one of them when the other is missing or
 * the same (Maestro's flows).
 *
 * @param {Record<string, string>} attrs
 */
function testName(attrs) {
  const suite = (attrs.classname ?? '').trim();
  const title = (attrs.name ?? '').trim();
  if (suite && title && suite !== title) return `${suite} › ${title}`;
  return title || suite || attrs.file?.trim() || '?';
}

/** Maestro's statuses for a flow that didn't fail: anything else did. */
const OK_STATUS = /^(|success|passed|pass|ok|warning)$/;

const ATTRS = /((?:[^>"']|"[^"]*"|'[^']*')*?)/.source;

/**
 * A failure's first line and whole message, from its element's `message`
 * attribute and its text.
 *
 * @param {string} attr the attribute, unescaped
 * @param {string} body the text, unescaped
 * @returns {{ message: string, detail: string }}
 */
function describeFailure(attr, body) {
  const message = firstLine(attr || body);
  // The text usually repeats the attribute ("Error: " and all), so it
  // stands alone then; stack frames inside node_modules are left out.
  const joined = !attr || body.includes(attr) ? body || attr : `${attr}\n${body}`;
  const whole = joined
    .split('\n')
    .filter((l) => !/^\s*(❯|at)\s.*node_modules\//.test(l))
    .join('\n')
    .trim();
  const detail = whole.length > DETAIL_LENGTH ? `${whole.slice(0, DETAIL_LENGTH - 1)}…` : whole;
  return { message, detail };
}

/**
 * The tests in a JUnit report. A `<failure>` or `<error>` inside a test, or
 * a status attribute other than a success (Maestro's), is a failure, its
 * message the element's `message` attribute or else its text; `<skipped>`
 * is a skip. A pass with a `<flakyFailure>` or `<flakyError>` inside passed
 * on re-run, its message the first one's `message` attribute or else its
 * `<stackTrace>`.
 *
 * @param {string} xml
 * @param {string} [file]
 * @returns {TestCase[]}
 */
export function parseJunit(xml, file = '') {
  const text = xml
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)(\]\]>|$)/g, (_, inner) => escapeXml(inner));
  /** @type {TestCase[]} */
  const cases = [];
  const testcase = new RegExp(`<testcase\\b${ATTRS}(\\/>|>([\\s\\S]*?)<\\/testcase\\s*>)`, 'g');
  const failure = new RegExp(`<(failure|error)\\b${ATTRS}(\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`);
  const flaky = new RegExp(`<(flakyFailure|flakyError)\\b${ATTRS}(\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`);
  for (const m of text.matchAll(testcase)) {
    const attrs = attributes(m[1]);
    const inner = m[3] ?? '';
    const status = (attrs.status ?? '').toLowerCase();
    const failed = inner.match(failure);
    /** @type {TestCase['result']} */
    let result = 'passed';
    let message = '';
    let detail = '';
    if (/<skipped\b/.test(inner) || /^(skip|skipped)$/.test(status)) result = 'skipped';
    if (failed || !(OK_STATUS.test(status) || result === 'skipped')) {
      result = 'failed';
      if (failed) {
        ({ message, detail } = describeFailure(
          (attributes(failed[2]).message ?? '').trim(),
          unescapeXml(failed[4] ?? '').trim(),
        ));
      }
    }
    const retried = result === 'passed' ? inner.match(flaky) : null;
    if (retried) {
      result = 'passed on re-run';
      // Playwright writes each try's text as a <stackTrace> beside its
      // captured output (<system-out>, <system-err>), which isn't the
      // failure: only the stack trace is read.
      const trace = (retried[4] ?? '').match(/<stackTrace\b[^>]*>([\s\S]*?)<\/stackTrace\s*>/);
      ({ message, detail } = describeFailure(
        (attributes(retried[2]).message ?? '').trim(),
        unescapeXml(trace?.[1] ?? '').trim(),
      ));
    }
    const seconds = Number(attrs.time);
    cases.push({
      name: testName(attrs),
      seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0,
      result,
      file,
      message,
      detail,
      suite: (attrs.classname ?? '').trim(),
      source: (attrs.file ?? '').trim(),
    });
  }
  return cases;
}

/**
 * The cases with re-runs settled: a failure whose test passed in another
 * report reads "passed on re-run" (the re-run's row stays as it is). Which
 * report came first isn't known: the patterns' files sort by name, and
 * sift's 19_swipe_decisions.retry.xml sorts before its suite.xml. So the
 * reports should be one suite and its re-runs: two suites sharing a test's
 * name would hide a failure.
 *
 * @param {TestCase[]} cases
 * @returns {TestCase[]}
 */
export function settleReruns(cases) {
  return cases.map((c) =>
    c.result === 'failed' &&
    cases.some((o) => o.file !== c.file && o.name === c.name && o.result === 'passed')
      ? { ...c, result: 'passed on re-run' }
      : c,
  );
}
