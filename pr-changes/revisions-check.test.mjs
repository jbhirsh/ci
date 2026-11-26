// The changes tool and the description check read the revisions marker pair
// the same way (`revisionsPair`), so a description one calls fixable is one
// the other fixes: the check says "no pair" only where the tool puts it back,
// and a pair the tool leaves alone (torn or repeated) is one the check says
// to mend by hand. Run on the same bodies, through both. And the row a push
// leaves to its author (ci#140): the check asks for it right after the tool's
// write, passes once it is filled, and asks again after the next push.

import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import { revisions } from './revisions-run.mjs';
import { parseTable } from './revisions.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const START = '<!-- pr-changes:revisions -->';
const END = '<!-- /pr-changes:revisions -->';
const PAIR = `${START}\n${END}`;
const BASE =
  '## Goal\n\nMake it work. Closes #1.\n\n## Changes\n\n### 1. c\n\n[`abc1234`](https://github.com/o/r/commit/abc1234)\n\n## Checklist\n\nNothing to do.\n';
const FENCE = `\`\`\`\n${PAIR}\n\`\`\`\n`;

/**
 * The tool on a description at a push (head A to B, or `before` to `head`), and what it wrote.
 *
 * @param {string} first
 * @param {{ head?: string, before?: string }} [push]
 */
function runTool(first, { head = B, before = A } = {}) {
  let body = first;
  /** @type {string[]} */
  const logs = [];
  const wrote = revisions(
    {
      pull: () => ({ state: 'open', author: 'p', headRef: 'f', headSha: head, headRepo: REPO }),
      body: () => body,
      commits: () => [{ sha: '1', subject: 'One', skipped: false }],
      compare: () => ({ status: 'ahead', behindBy: 0, base: before, shas: ['1'] }),
      timeline: () => [],
      write: (b) => {
        body = b;
      },
      canWrite: true,
      log: (l) => logs.push(l),
    },
    { repo: REPO, before },
  );
  return { wrote, body, logs };
}

/** @param {string} body */
const pairProblems = (body) =>
  bodyProblems(body, B, { pushed: true }).filter((p) =>
    /pr-changes:revisions` and|exactly one/.test(p),
  );

describe('the tool and the check agree on the revisions pair', () => {
  /** @type {[string, string][]} */
  const cases = [
    ['no marker at all', BASE],
    ['a fenced example and the real pair', `${BASE}\n${PAIR}\n\n${FENCE}`],
    ['the real pair and a fenced example after it', `${BASE}\n${FENCE}\n${PAIR}\n`],
    ['only a fenced example', `${BASE}\n${FENCE}`],
    ['only an inline mention', `${BASE}\nKeep \`${START}\` and ${END} in it.\n`],
    ['the real pair and an inline mention', `${BASE}\nSee ${START}.\n\n${PAIR}\n`],
    ['a start marker alone', `${BASE}\n${START}\n`],
    ['an end marker alone', `${BASE}\n${END}\n`],
    ['two pairs', `${BASE}\n${PAIR}\n\n${PAIR}\n`],
    ['an unclosed fence at the end', `${BASE}\n\`\`\`\ncode\n`],
    ['a CRLF description with no pair', BASE.replace(/\n/g, '\r\n')],
    ['a CRLF description with its pair', `${BASE}\n${PAIR}\n`.replace(/\n/g, '\r\n')],
  ];

  for (const [name, body] of cases) {
    it(name, () => {
      const before = pairProblems(body);
      const { wrote, body: after, logs } = runTool(body);
      if (before.length === 0) {
        // The check is content with the pair: the tool writes the row into it.
        expect(wrote).toBe(true);
      } else if (/no `<!-- pr-changes:revisions -->`/.test(before[0])) {
        // "No pair": the tool puts it back, and the check is then content with the pair.
        expect(wrote).toBe(true);
      } else {
        // "Torn or repeated": the tool leaves it alone, says so, and the check says to mend it.
        expect(wrote).toBe(false);
        expect(logs.some((l) => /torn or repeated/.test(l))).toBe(true);
      }
      if (wrote) {
        expect(pairProblems(after)).toEqual([]);
        expect(after).toContain('<b>👉 <a href="https://github.com/o/r/commit/');
      }
    });
  }
});

describe('the row a push leaves to its author (ci#140)', () => {
  /** The check's Revisions problems at `head`, on a push or on an edit. */
  const problems = (/** @type {string} */ body, /** @type {string} */ head, pushed = false) =>
    bodyProblems(body, head, { pushed }).filter((p) => /Revisions/.test(p));
  /** @param {string} head */
  const toFill = (head) => [
    expect.stringMatching(
      new RegExp(`^fill Revisions' current revision, \`${head.slice(0, 7)}\`: `),
    ),
  ];
  const ROW = '| The cap fails closed | It is the only paid API |';

  it('is asked for after the write, passes once filled, and is asked for again after the next push', () => {
    const { body: written } = runTool(`${BASE}\n${PAIR}\n`);
    // Right after the tool's write, the new revision's row is the only problem, on the push and on the edit.
    expect(problems(written, B, true)).toEqual(toFill(B));
    expect(problems(written, B)).toEqual(toFill(B));
    const filled = written.replace('|  |  |', ROW);
    expect(problems(filled, B)).toEqual([]);
    // The tool's run for the author's edit writes nothing: the filled row stays, and so does the pass.
    const edited = runTool(filled);
    expect(edited.wrote).toBe(false);
    expect(problems(edited.body, B)).toEqual([]);
    // The next push: the filled row stays with its revision, and the new one is asked for.
    const next = runTool(filled, { head: C, before: B });
    expect(next.wrote).toBe(true);
    expect(next.body).toContain(ROW);
    expect(problems(next.body, C, true)).toEqual(toFill(C));
    expect(problems(next.body.replace('|  |  |', ROW), C)).toEqual([]);
  });
});

describe("the tool and the check read a revision's rows alike (ci#140)", () => {
  const link = `<a href="https://github.com/${REPO}/commit/${B}"><code>bbbbbbb</code></a>`;
  const summary = `<summary><b>👉 ${link}</b> (current)</summary>`;
  const frame = '| What changed | Why |\n| --- | --- |';
  const older = `<details>\n<summary><a href="https://github.com/${REPO}/commit/${A}"><code>aaaaaaa</code></a> · Opened</summary>\n\n${frame}\n| Opened | For the goal |\n\n</details>`;
  /** @type {[string, (row: string) => string][]} */
  const shapes = [
    [
      'as the tool writes it',
      (row) => `<details open>\n${summary}\n\n${frame}\n${row}\n\n</details>`,
    ],
    [
      'a summary that ends with </details> on its own line',
      (row) => `<details open>\n${summary}</details>\n\n${frame}\n${row}\n`,
    ],
    [
      'a blank line and a line with </details> in a code span before the row',
      (row) =>
        `<details open>\n${summary}\n\n${frame}\nSee \`</details>\` here.\n\n${row}\n\n</details>`,
    ],
    [
      'no closing line, then the older revision',
      (row) => `<details open>\n${summary}\n\n${frame}\n${row}\n\n${older}`,
    ],
  ];
  const inner = (/** @type {string} */ block) => `## Revisions\n\n${block}\n\n${older}`;
  const body = (/** @type {string} */ block) => `${BASE}\n${START}\n${inner(block)}\n${END}\n`;
  const checkPasses = (/** @type {string} */ block) =>
    !bodyProblems(body(block), B).some((p) => /Revisions/.test(p));
  const toolRows = (/** @type {string} */ block) =>
    parseTable(inner(block), REPO).rows.find((r) => r.current)?.rows ?? [];

  it.each(shapes)('%s', (_name, shape) => {
    expect(toolRows(shape('| A | B |'))).toContain('| A | B |');
    expect(checkPasses(shape('| A | B |'))).toBe(true);
    expect(toolRows(shape('|  |  |'))).toEqual([]);
    expect(checkPasses(shape('|  |  |'))).toBe(false);
  });
});
