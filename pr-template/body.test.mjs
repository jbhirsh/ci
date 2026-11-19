import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyProblems, renderedLines } from './body.mjs';

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const master = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);

const GOOD = [
  '## Goal',
  '',
  'Make it work.',
  '',
  'Closes #1.',
  '',
  '## Changes',
  '',
  '### 1. The change',
  '',
  '[`abc1234`](https://github.com/o/r/commit/abc1234)',
  '',
  'Why.',
  '',
  '## Checklist',
  '',
  '- [x] done',
  '',
  '## Revisions',
  '',
  '| Rev | Head |',
].join('\n');

describe('bodyProblems', () => {
  it('passes descriptions that tools have filled in, written from the template', () => {
    expect(bodyProblems(fixture('step-of-a-plan.md'))).toEqual([]);
    expect(bodyProblems(fixture('with-boxes.md'))).toEqual([]);
    expect(bodyProblems(GOOD)).toEqual([]);
  });

  it('fails the template as it comes: a goal, a change and a plan row still to write', () => {
    const found = bodyProblems(master);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/write the goal/);
    expect(found[1]).toMatch(/replace the template's sample change/);
    expect(found[2]).toMatch(/plan table's template row/);
  });

  it('says each missing heading, and takes Problem for Goal and Solution for Plan', () => {
    expect(bodyProblems('')).toEqual([
      'add the heading `## Goal` or `## Problem`',
      'add the heading `## Changes`',
      'add the heading `## Revisions`',
    ]);
    expect(bodyProblems(undefined)).toHaveLength(3);
    expect(
      bodyProblems(
        GOOD.replace('## Goal', '## Problem\n\n**Example**\n').replace(
          '## Changes',
          '## Solution\n\nx\n\n## Changes',
        ),
      ),
    ).toEqual([]);
  });

  it('wants Plan only when it is there: a step of a plan, with its row filled', () => {
    expect(bodyProblems(GOOD)).toEqual([]);
    const html =
      '<table>\n<tbody><tr></tr><tr><td><b>1</b></td><td><b>this PR</b></td><td><b></b></td><td><b>👉 this PR</b></td></tr></tbody>\n</table>';
    const markdown = '| **1** | **this PR** |      | 👉 this PR |';
    expect(bodyProblems(GOOD.replace('## Changes', `## Plan\n\n${html}\n\n## Changes`))[0]).toMatch(
      /plan table's template row/,
    );
    expect(
      bodyProblems(GOOD.replace('## Changes', `## Plan\n\n${markdown}\n\n## Changes`))[0],
    ).toMatch(/HTML table/);
    const filled = html.replace('<b></b>', '<b>The thing</b>');
    expect(bodyProblems(GOOD.replace('## Changes', `## Plan\n\n${filled}\n\n## Changes`))).toEqual(
      [],
    );
  });

  it('flags a heading twice and headings out of order', () => {
    expect(bodyProblems(GOOD.replace('## Checklist', '## Checklist\n\n## Checklist'))).toEqual([
      'keep one `## Checklist` heading, not 2',
    ]);
    expect(bodyProblems(GOOD.replace('## Checklist\n\n- [x] done\n\n', ''))).toEqual([]);
    const swapped = GOOD.replace('## Checklist', '## Zzz')
      .replace('## Revisions', '## Checklist')
      .replace('## Zzz', '## Revisions');
    expect(bodyProblems(swapped)[0]).toMatch(/template's order/);
  });

  it('wants words under the goal and a numbered change under Changes', () => {
    expect(bodyProblems(GOOD.replace('Make it work.\n\nCloses #1.', '<!-- later -->'))[0]).toMatch(
      /write the goal/,
    );
    expect(bodyProblems(GOOD.replace('### 1. The change', '### The change'))[0]).toMatch(
      /numbered change heading/,
    );
  });

  it('wants the goal to say its issue: Closes or Part of, or that there is none', () => {
    const goal = (/** @type {string} */ text) => GOOD.replace('Closes #1.', text);
    for (const ok of [
      'Closes #1.',
      'Part of [#9](https://x/9).',
      'Part of jbhirsh/ci#92.',
      'Closes https://github.com/o/r/issues/3',
      'There are no issues for this.',
      'closes #12',
      'There is no issue.',
    ]) {
      expect(bodyProblems(goal(ok))).toEqual([]);
    }
    expect(bodyProblems(goal('Fixes it.'))[0]).toMatch(/Closes #N/);
    expect(bodyProblems(goal('Closes it.'))[0]).toMatch(/Closes #N/);
    expect(bodyProblems(goal('Closes the gap between #3 and #4.'))[0]).toMatch(/Closes #N/);
  });

  it('wants an Example on a bug fix, in the problem or under a change, and not in a code block', () => {
    const fix = GOOD.replace('## Goal', '## Problem');
    expect(bodyProblems(fix)[0]).toMatch(/\*\*Example\*\*/);
    expect(bodyProblems(fix.replace('Why.', '**Example**\n\nA case.'))).toEqual([]);
    expect(bodyProblems(fix.replace('Closes #1.', 'Closes #1.\n\n**Example**'))).toEqual([]);
    expect(bodyProblems(fix.replace('Why.', '```\n**Example**\n```'))[0]).toMatch(/Example/);
    expect(bodyProblems(GOOD)).toEqual([]);
  });

  it("wants the plan as the template's HTML table, so only this PR's row is shaded", () => {
    const row = (/** @type {string} */ n) =>
      `<tr><td>${n}</td><td>x</td><td>y</td><td>next</td></tr>`;
    const mine =
      '<tbody><tr></tr><tr><td><b>2</b></td><td><b>this PR</b></td><td><b>y</b></td><td><b>👉 this PR</b></td></tr></tbody>';
    const plan = (/** @type {string} */ rows) =>
      GOOD.replace('## Changes', `## Plan\n\n<table>\n${rows}\n</table>\n\n## Changes`);
    expect(bodyProblems(plan(`<tbody>${row('1')}</tbody>\n${mine}`))).toEqual([]);
    // Two steps in one body: GitHub shades every other row of it.
    expect(bodyProblems(plan(`<tbody>${row('1')}${row('3')}</tbody>\n${mine}`))[0]).toMatch(
      /own `<tbody>`/,
    );
    // No body marked as this PR's, or two.
    expect(bodyProblems(plan(`<tbody>${row('1')}</tbody>`))[0]).toMatch(/empty `<tr><\/tr>`/);
    expect(bodyProblems(plan(`${mine}\n${mine}`))[0]).toMatch(/empty `<tr><\/tr>`/);
    // Prose instead of a table.
    expect(bodyProblems(GOOD.replace('## Changes', '## Plan\n\nSteps.\n\n## Changes'))[0]).toMatch(
      /HTML table/,
    );
    // A bug fix's Solution is prose.
    const solved = GOOD.replace('## Goal', '## Problem\n\n**Example**\n').replace(
      '## Changes',
      '## Solution\n\nIt does.\n\n## Changes',
    );
    expect(bodyProblems(solved)).toEqual([]);
  });

  it('wants each change to have its commit: a marker pair or a commit link', () => {
    const link = '[`abc1234`](https://github.com/o/r/commit/abc1234)';
    const pair = '<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->';
    expect(bodyProblems(GOOD.replace(link, pair))).toEqual([]);
    const without = GOOD.replace(link, '');
    expect(bodyProblems(without)[0]).toMatch(/under change 1, add its commit/);
    const two = without.replace('Why.', `Why.\n\n### 2. More\n\n${link}`);
    expect(bodyProblems(two)).toHaveLength(1);
    expect(bodyProblems(GOOD.replace(link, '<!-- pr-changes:other -->'))[0]).toMatch(/change 1/);
  });

  it("wants Revisions' current row to name the head, when the head is known", () => {
    const table = (/** @type {string} */ head) =>
      `${GOOD}\n| Rev | Head | What |\n| --- | --- | --- |\n| 2 (current) | [\`${head}\`](https://x/${head}) | \`1111111\` → \`${head}\` |\n| 1 | [\`1111111\`](https://x/1111111) | Opened |\n`;
    const head = 'abcdef0123456789abcdef0123456789abcdef01';
    expect(bodyProblems(table('abcdef0'), head)).toEqual([]);
    expect(bodyProblems(table('2222222'), head)[0]).toMatch(/update Revisions.*abcdef0/);
    // Only the Head cell counts, not the sha in a later cell.
    expect(bodyProblems(table('1111111').replace('1111111` →', 'abcdef0` →'), head)).toHaveLength(
      1,
    );
    // Not a row quoted in a code block, and any case of the sha.
    const quoted = `\`\`\`\n| 1 (current) | x |\n\`\`\`\n${table('abcdef0')}`;
    expect(bodyProblems(quoted, head)).toEqual([]);
    expect(bodyProblems(table('ABCDEF0'), head)).toEqual([]);
    // Nothing to compare: no head given, or no current row.
    expect(bodyProblems(table('2222222'))).toEqual([]);
    expect(bodyProblems(GOOD, head)).toEqual([]);
  });

  it('does no quadratic work on the new checks: blank lines in a Plan, a long run of "closes"', () => {
    // Sized to a body's 65,536-character limit: a regex that backtracked from
    // every line start would take seconds and hit the test timeout.
    bodyProblems(`## Plan${'\n'.repeat(60000)}`);
    bodyProblems(`## Goal\n\n${'closes '.repeat(9000)}`);
    bodyProblems(`## Plan\n\n${'<tbody>'.repeat(9000)}`);
    expect(bodyProblems(`## Plan${'\n'.repeat(60000)}`)).toContain(
      "write the Plan as the template's HTML table, not a Markdown one: GitHub shades every other row of a Markdown table, and only this PR's row of the template's",
    );
  });

  it("reads a change's commit past fences, multi-line comments and filled blocks, and past a stray backtick", () => {
    const link = '[`abc1234`](https://github.com/o/r/commit/abc1234)';
    const filled = `<!-- pr-changes:change:2 -->\n${link}\n\n<details><summary>1 file</summary>\n\n- a +1 −0\n\n</details>\n<!-- /pr-changes:change:2 -->`;
    const body = GOOD.replace(
      '## Checklist',
      `\`\`\`\n### 9. in a fence\n\`\`\`\n\n<!--\nnote\n-->\n## Checklist`,
    ).replace('Why.', `Why.\n\n### 2. Two\n\n${filled}`);
    expect(bodyProblems(body)).toEqual([]);
    const stray = GOOD.replace(
      link,
      '`a\n<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->\nb`',
    );
    expect(bodyProblems(stray)).toEqual([]);
    // A marker typed by hand is only text.
    expect(bodyProblems(GOOD.replace(link, '@@tool:pr-changes:change:1@@'))[0]).toMatch(/change 1/);
  });

  it('flags the "No visible UI change" box', () => {
    expect(bodyProblems(`${GOOD}\n\n- [x] No visible UI change`).join()).toMatch(
      /No visible UI change/,
    );
  });

  it("reads what a reader sees, not code, comments or tools' blocks", () => {
    const noRevisions = GOOD.replace('## Revisions', '```\n## Revisions\n```');
    expect(bodyProblems(noRevisions)).toEqual(['add the heading `## Revisions`']);
    expect(bodyProblems(GOOD.replace('## Revisions', '<!-- ## Revisions -->'))).toHaveLength(1);
    const block = '<!-- pr-changes:revisions -->\n## Revisions\n<!-- /pr-changes:revisions -->';
    expect(bodyProblems(GOOD.replace('## Revisions', block))).toEqual([
      'add the heading `## Revisions`',
    ]);
  });

  it('gives the same answer with Windows line endings, closing hashes and a trailing fingerprint', () => {
    expect(bodyProblems(GOOD.replace(/\n/g, '\r\n'))).toEqual([]);
    expect(bodyProblems(GOOD.replace('## Goal', '## Goal ##'))).toEqual([]);
    expect(bodyProblems(`${GOOD}\n\n[vr:abc123@1700000000]`)).toEqual([]);
  });
});

describe('renderedLines', () => {
  it('drops code, comments and the blocks other tools keep, a line at a time', () => {
    const text = renderedLines('a\r\n`b`\n<!-- c -->\n<!-- x:y -->\nz\n<!-- /x:y -->\nd');
    expect(text).toEqual(['a', '', '', '', 'd']);
  });

  it('reads code spans the way GitHub does: within a paragraph, by equal runs, a lone backtick is text', () => {
    const body = GOOD.replace(
      'Make it work.',
      'Press the ` key, and escape a `` ` `` in names.',
    ).replace('- [x] done', '- [x] ran `npm test`');
    expect(bodyProblems(body)).toEqual([]);
    const fenced = GOOD.replace('Why.', '````md\n```js\nx\n```\n````\n\nthen `code`.');
    expect(bodyProblems(fenced)).toEqual([]);
  });

  it('reads an unclosed <!-- mid-line as text, and one that starts a line as hiding the rest', () => {
    expect(bodyProblems(GOOD.replace('Why.', 'a <!-- b'))).toEqual([]);
    expect(bodyProblems(GOOD.replace('Why.', '<!-- never closed'))).toEqual([
      'add the heading `## Revisions`',
    ]);
  });

  it('takes a block comment that closes on a later line, and text after its end', () => {
    expect(bodyProblems(GOOD.replace('Why.', '<!--\nnote\n-->\nWhy.'))).toEqual([]);
  });

  it('is linear on a long heading or a long run of markers', () => {
    // Large enough that a parser quadratic in a line's length would run for
    // minutes and hit the test timeout, which only ends a hang; there is no
    // clock to compare against.
    bodyProblems(`## a${' '.repeat(400000)}b`);
    bodyProblems(`## Changes\n### 1.${' '.repeat(400000)}b`);
    bodyProblems('<!-- x:y -->\n'.repeat(5000));
    expect(bodyProblems(`## a${' '.repeat(400000)}b`)).toHaveLength(3);
  });
});

describe("the template's Example", () => {
  const start = master.indexOf('\n**Example**\n') + 1;
  const example = master.slice(start, master.indexOf('_Real case'));

  it('is hidden: a reader of the template sees none of it, not even its last lines', () => {
    const seen = renderedLines(master).join('\n');
    for (const text of ['In one line', 'What it does now', 'Real case', 'BoardGames#343', '```']) {
      expect(seen).not.toContain(text);
    }
    expect(bodyProblems(master).join()).toMatch(/write the goal/);
  });

  it('is a description that passes once it is written in', () => {
    expect(example.startsWith('**Example**\n')).toBe(true);
    expect(example).toContain('```diff');
    const written = GOOD.replace('Make it work.', () => `Make it work.\n\n${example}`);
    expect(bodyProblems(written)).toEqual([]);
  });
});
