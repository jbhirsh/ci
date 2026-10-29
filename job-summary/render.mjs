// The job summary's Markdown, for job-summary (summary.mjs): the verdict,
// what needs attention and a link to the run's full report (report.html,
// on the repository's GitHub Pages), where the steps, tests and history
// are. GitHub's run page can't show more than Markdown well (no hover, no
// scripts, nested dropdowns that don't indent), so the summary stays short
// and the report does the rest. Written from the model (model.mjs).
//
// Text from outside (step and test names, failure messages) is escaped as
// it's written: shown as written, with nothing that would end a line or
// open Markdown or HTML of its own.

/** @typedef {import('./model.mjs').Model} Model */
/** @typedef {import('./model.mjs').ModelTest} ModelTest */

/** Each list in Needs attention names at most this many. */
export const ATTENTION = 5;
/** The most a summary may hold: GitHub drops one over 1 MiB. */
export const MAX_BYTES = 900_000;

/**
 * Inline text: one line, shown as written (no Markdown or HTML of its own,
 * so a test named "renders <Card />" keeps its tag).
 *
 * @param {string} text
 */
export function cell(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|])/g, '\\$1');
}

/**
 * A time as people read it: 40ms, 3.2s, 12s, 3m 05s, 1h 02m.
 *
 * @param {number} seconds
 */
export function duration(seconds) {
  if (seconds === 0) return '0s';
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * How much over its usual time, as "+18%", or "+40s" over a usual time of
 * nothing (the API times steps to the second).
 *
 * @param {number} seconds
 * @param {number} typical
 */
export function over(seconds, typical) {
  if (typical <= 0) return `+${duration(seconds - typical)}`;
  return `+${Math.round((seconds / typical - 1) * 100)}%`;
}

/**
 * A noun, plural unless one.
 *
 * @param {number} n
 * @param {string} noun
 */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A test's name in a sentence: its title, and where it is.
 *
 * @param {ModelTest} t
 */
function testName(t) {
  const where = [t.folder + t.file, t.block].filter(Boolean).join(' › ');
  return where ? `${cell(t.title)} (${cell(where)})` : cell(t.title);
}

/**
 * Lists capped at ATTENTION, saying how many more the report has.
 *
 * @param {string[]} items
 */
function capped(items) {
  return items.length > ATTENTION
    ? [...items.slice(0, ATTENTION), `…and ${items.length - ATTENTION} more in the report`]
    : items;
}

/**
 * The verdict: what failed, or that everything passed, then the job's time
 * and how it compares with its usual time.
 *
 * @param {Model} model
 */
export function verdict(model) {
  const tests = model.tests ?? [];
  const ran = tests.filter((t) => t.result !== 'skipped');
  const failed = tests.filter((t) => t.result === 'failed');
  const rerun = tests.filter((t) => t.result === 'passed on re-run');
  const failedSteps = model.steps.filter((s) => s.conclusion === 'failure');
  const unfinished = model.steps.some((s) => s.conclusion === 'running');
  const passed = `${count(ran.length, model.noun)} passed${rerun.length ? `, ${rerun.length} on re-run` : ''}`;
  /** @type {string[]} */
  const parts = [];
  if (failed.length) parts.push(`❌ ${failed.length} of ${count(ran.length, model.noun)} failed`);
  else if (failedSteps.length) {
    // A step can fail after every test passed (a coverage threshold).
    parts.push(`❌ ${cell(failedSteps[0].name)} failed`);
    if (model.tests) parts.push(passed);
  } else if (model.tests && !ran.length && tests.length) {
    parts.push(`⚪ all ${count(tests.length, model.noun)} skipped`);
  } else if (model.tests) parts.push(`✅ ${passed}`);
  else parts.push(unfinished ? '✅ no step failed so far' : '✅ no step failed');
  if (model.run) parts.push(duration(model.seconds));
  if (model.run && model.usual) {
    const pct = Math.round((model.seconds / model.usual - 1) * 100);
    parts.push(
      Math.abs(pct) < 5
        ? 'about as long as usual'
        : `${Math.abs(pct)}% ${pct > 0 ? 'slower' : 'faster'} than usual`,
    );
  }
  return parts.join(' · ');
}

/**
 * The summary's Markdown.
 *
 * @param {Model} model
 * @param {string} reportLink the run's report ('' when there's none)
 * @returns {string}
 */
export function render(model, reportLink) {
  const tests = model.tests ?? [];
  const failed = tests.filter((t) => t.result === 'failed');
  const rerun = tests.filter((t) => t.result === 'passed on re-run');
  const flaky = tests.filter((t) => t.flaky);
  const failedSteps = model.steps.filter((s) => s.conclusion === 'failure');
  const lines = [`### ${cell(model.job)}: ${verdict(model)}`, ''];
  if (reportLink) {
    lines.push(
      `**[Full report](${reportLink})**: every step and ${model.noun} beside its recent runs. It's published once the workflow finishes.`,
      '',
    );
  }
  if (model.problem) lines.push(`No step times or history: ${cell(model.problem)}`, '');

  /** @type {string[]} */
  const attention = [];
  for (const t of failed.slice(0, ATTENTION)) {
    const first = t.message.split('\n').find((l) => l.trim()) ?? '';
    attention.push(
      `- **Failed:** ${testName(t)} after ${duration(t.seconds)}${first ? `: ${cell(first)}` : ''}`,
    );
  }
  if (failed.length > ATTENTION) {
    attention.push(`- …and ${failed.length - ATTENTION} more failed ${model.noun}s, in the report`);
  }
  if (!failed.length) {
    for (const s of failedSteps) attention.push(`- **Failed step:** ${cell(s.name)}`);
  }
  if (rerun.length) {
    attention.push(`- **Passed on re-run:** ${capped(rerun.map(testName)).join(' · ')}`);
  }
  if (flaky.length) {
    attention.push(
      `- **Flaky:** ${capped(
        flaky.map((t) => {
          const results = [...t.hist, t.result].filter(Boolean);
          const bad = results.filter((r) => r === 'failed' || r === 'passed on re-run').length;
          return `${testName(t)}, failed ${bad} of its last ${results.length} runs`;
        }),
      ).join(' · ')}`,
    );
  }
  const slow = [
    ...model.steps
      .filter((s) => s.slower)
      .map((s) => ({ name: cell(s.name), seconds: s.seconds, usual: s.usual })),
    ...tests
      .filter((t) => t.slower)
      .map((t) => ({ name: testName(t), seconds: t.seconds, usual: t.usual })),
  ];
  if (slow.length) {
    attention.push(
      `- **Slower than usual:** ${capped(
        slow.map(({ name, seconds, usual }) => {
          const typical = usual ?? seconds;
          return `${name}: ${duration(seconds)}, usually ${duration(typical)} (${over(seconds, typical)})`;
        }),
      ).join(' · ')}`,
    );
  }
  if (attention.length) lines.push('**Needs attention**', '', ...attention, '');
  return fit(lines.join('\n').trimEnd());
}

/**
 * The summary, cut to MAX_BYTES at a line, saying so.
 *
 * @param {string} text
 */
export function fit(text) {
  if (Buffer.byteLength(text) <= MAX_BYTES) return text;
  const note = "\n\n…cut here: the summary would be over GitHub's 1 MiB limit.";
  const cut = Buffer.from(text)
    .subarray(0, MAX_BYTES - Buffer.byteLength(note))
    .toString();
  return cut.slice(0, Math.max(0, cut.lastIndexOf('\n'))) + note;
}
