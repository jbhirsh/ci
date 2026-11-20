// The changes tool and the description check read the revisions marker pair
// the same way (`revisionsPair`), so a description one calls fixable is one
// the other fixes: the check says "no pair" only where the tool puts it back,
// and a pair the tool leaves alone (torn or repeated) is one the check says
// to mend by hand. Run on the same bodies, through both.

import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import { revisions } from './revisions-run.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const START = '<!-- pr-changes:revisions -->';
const END = '<!-- /pr-changes:revisions -->';
const PAIR = `${START}\n${END}`;
const BASE =
  '## Goal\n\nMake it work. Closes #1.\n\n## Changes\n\n### 1. c\n\n[`abc1234`](https://github.com/o/r/commit/abc1234)\n\n## Checklist\n\nNothing to do.\n';
const FENCE = `\`\`\`\n${PAIR}\n\`\`\`\n`;

/**
 * The tool on a description at a push (head A to B), and what it wrote.
 *
 * @param {string} first
 */
function runTool(first) {
  let body = first;
  /** @type {string[]} */
  const logs = [];
  const wrote = revisions(
    {
      pull: () => ({ state: 'open', author: 'p', headRef: 'f', headSha: B, headRepo: REPO }),
      body: () => body,
      commits: () => [{ sha: '1', subject: 'One', skipped: false }],
      compare: () => ({ status: 'ahead', behindBy: 0, base: A, shas: ['1'] }),
      timeline: () => [],
      write: (b) => {
        body = b;
      },
      canWrite: true,
      log: (l) => logs.push(l),
    },
    { repo: REPO, before: A },
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
        expect(after).toContain('| 2 (current)');
      }
    });
  }
});
