import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bodyProblems,
  holdsText,
  maskFences,
  renderedLines,
  revisionRowProblems,
  revisionsPair,
} from './body.mjs';

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
    expect(found).toHaveLength(4);
    expect(found[0]).toMatch(/write the goal/);
    expect(found[1]).toMatch(/under change 1, its `<!-- pr-changes:change:1 -->` pair is empty/);
    expect(found[2]).toMatch(/replace the template's sample change/);
    expect(found[3]).toMatch(/plan table's template row/);
  });

  it('says each missing heading, and takes Problem for Goal and Solution for Plan', () => {
    expect(bodyProblems('')).toEqual([
      'add the heading `## Goal` or `## Problem`',
      'add the heading `## Changes`',
    ]);
    expect(bodyProblems(undefined)).toHaveLength(2);
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
      /add a change: an empty `<!-- pr-changes:change:1 -->`/,
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

  it('wants each change to have its commit: a commit link, or a pair the tool has filled', () => {
    const link = '[`abc1234`](https://github.com/o/r/commit/abc1234)';
    const filled = `<!-- pr-changes:change:1 -->\n${link}\n<!-- /pr-changes:change:1 -->`;
    expect(bodyProblems(GOOD.replace(link, filled))).toEqual([]);
    // The empty pair is where the tool writes it, not a commit.
    const empty = '<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->';
    expect(bodyProblems(GOOD.replace(link, empty))[0]).toMatch(
      /its `<!-- pr-changes:change:1 -->` pair is empty/,
    );
    expect(
      bodyProblems(
        GOOD.replace(link, `<!-- pr-changes:change:1 -->\n \n<!-- /pr-changes:change:1 -->`),
      ),
    ).toHaveLength(1);
    // A pair of another change doesn't fill this one.
    const another = GOOD.replace(link, empty).replace(
      'Why.',
      `Why.\n\n### 2. More\n\n<!-- pr-changes:change:2 -->\n${link}\n<!-- /pr-changes:change:2 -->`,
    );
    expect(bodyProblems(another)).toHaveLength(1);
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
    // Sized past a body's 65,536-character limit, to where a quadratic regex
    // that backtracked from every line start runs for a minute or more and hits
    // the test timeout, which only ends a hang (there is no clock to compare
    // with). Measured: 400,000 blank lines take ~0.2 s here as written and ~80 s
    // with such a regex; at the body limit (60,000) it takes only ~2 s, which the
    // hang limit could not tell from linear work.
    bodyProblems(`## Plan${'\n'.repeat(400000)}`);
    bodyProblems(`## Goal\n\n${'closes '.repeat(60000)}`);
    bodyProblems(`## Plan\n\n${'<tbody>'.repeat(60000)}`);
    expect(bodyProblems(`## Plan${'\n'.repeat(400000)}`)).toContain(
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
      `\`a\n<!-- pr-changes:change:1 -->\n${link}\n<!-- /pr-changes:change:1 -->\nb\``,
    );
    expect(bodyProblems(stray)).toEqual([]);
    // A marker typed by hand is only text.
    expect(bodyProblems(GOOD.replace(link, '@@tool:pr-changes:change:1@@'))[0]).toMatch(/change 1/);
  });

  describe('the GIF and screen blocks the tools write', () => {
    const gif = (
      /** @type {string} */ name,
      /** @type {string} */ text = 'Recorded automatically at `abc1234`.\n\n![GIF: x after](https://github.com/user-attachments/assets/1)',
    ) => `<!-- pr-gif:${name} -->\n${text}\n<!-- /pr-gif:${name} -->`;
    const under = (/** @type {string} */ block) => GOOD.replace('Why.', `Why.\n\n${block}`);
    const atEnd = (/** @type {string} */ block) => `${GOOD}\n${block}\n`;

    it('passes a GIF or a screen under a change, and an empty pair waiting for one', () => {
      expect(bodyProblems(under(gif('rules')))).toEqual([]);
      expect(bodyProblems(under('<!-- pr-gif:rules -->\n<!-- /pr-gif:rules -->'))).toEqual([]);
      expect(
        bodyProblems(
          under(
            '<!-- describe:visual-review:home -->\ntable\n<!-- /describe:visual-review:home -->',
          ),
        ),
      ).toEqual([]);
      expect(
        bodyProblems(under(gif('a')).replace('## Checklist', `${gif('b')}\n\n## Checklist`)),
      ).toEqual([]);
    });

    it('wants a block under a change, not at the top of Changes or the very end, and says how to move it', () => {
      for (const body of [
        atEnd(gif('rules')),
        GOOD.replace('### 1.', `${gif('rules')}\n\n### 1.`),
      ]) {
        const found = bodyProblems(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/put the GIF block `pr-gif:rules` under the change it belongs to/);
        expect(found[0]).toMatch(/empty `<!-- pr-gif:rules -->`/);
      }
      const slot = '<!-- describe:visual-review:home -->\n<!-- /describe:visual-review:home -->';
      expect(bodyProblems(atEnd(slot))[0]).toMatch(/screen block `describe:visual-review:home`/);
    });

    it("says a GIF didn't attach: a local path is left in its block", () => {
      const local = gif('rules', '![GIF: rules after](./pr-gif/rules-after.gif)');
      expect(bodyProblems(under(local))[0]).toMatch(/didn't attach.*re-run PR GIFs/);
      // A relative link of the author's in a GIF block isn't a GIF.
      expect(bodyProblems(under(gif('rules', 'See [the doc](./docs/x.md).')))).toEqual([]);
      // Only in a GIF's block, and not as quoted code or a comment.
      expect(bodyProblems(under('```\n![x](./a.gif)\n```\n<!-- ![x](./a.gif) -->'))).toEqual([]);
    });

    it('says a GIF is stale when the tool marked it, by its exact phrase at the block start', () => {
      const stale = gif(
        'rules',
        '**Not updated for `abc1234`: recording failed ([run](https://x)).** Recorded automatically at `abc1234`.',
      );
      expect(bodyProblems(under(stale))[0]).toMatch(/marked "Not updated".*Re-run PR GIFs/);
      expect(
        bodyProblems(under(gif('rules', 'Recorded.\n\nNot updated for `abc1234`: x'))),
      ).toEqual([]);
    });

    it('flags one marker pair twice, but not a lone unpaired marker', () => {
      const twice = under(`${gif('rules')}\n\n${gif('rules')}`);
      expect(bodyProblems(twice)).toHaveLength(1);
      expect(bodyProblems(twice)[0]).toMatch(/keep one `pr-gif:rules` block/);
      expect(bodyProblems(under(`<!-- pr-gif:rules -->\n\n${gif('rules')}`))).toEqual([]);
      expect(bodyProblems(under(`${gif('a')}\n\n${gif('b')}`))).toEqual([]);
    });

    it("leaves visual review's own block, a block in code or a comment, and CRLF alone", () => {
      expect(
        bodyProblems(
          atEnd('<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->'),
        ),
      ).toEqual([]);
      expect(bodyProblems(atEnd(`\`\`\`\n${gif('rules')}\n\`\`\``))).toEqual([]);
      expect(bodyProblems(atEnd(`<!--\n${gif('rules')}\n-->`))).toEqual([]);
      expect(bodyProblems(under(gif('rules')).replace(/\n/g, '\r\n'))).toEqual([]);
    });
  });

  it('does not want Revisions until the PR has a revision, but holds a table that is there', () => {
    const without = GOOD.slice(0, GOOD.indexOf('## Revisions')).trimEnd();
    expect(bodyProblems(without)).toEqual([]);
    expect(bodyProblems(GOOD)).toEqual([]);
    const row = '| 1 (current) | [`2222222`](https://x/2222222) | Opened | Why |';
    const stale = `${without}\n\n## Revisions\n\n| Rev | Head | What | Why |\n| --- | --- | --- | --- |\n${row}\n`;
    expect(bodyProblems(stale, 'abcdef0123')[0]).toMatch(/update Revisions/);
  });

  it('flags the "No visible UI change" box', () => {
    expect(bodyProblems(`${GOOD}\n\n- [x] No visible UI change`).join()).toMatch(
      /No visible UI change/,
    );
  });

  it("reads what a reader sees, not code, comments or tools' blocks", () => {
    const noChanges = GOOD.replace('## Changes', '```\n## Changes\n```');
    expect(bodyProblems(noChanges)).toEqual(['add the heading `## Changes`']);
    expect(bodyProblems(GOOD.replace('## Changes', '<!-- ## Changes -->'))).toHaveLength(1);
    const block = '<!-- pr-changes:revisions -->\n## Changes\n<!-- /pr-changes:revisions -->';
    expect(bodyProblems(GOOD.replace('## Changes', block))).toEqual([
      'add the heading `## Changes`',
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
    expect(bodyProblems(GOOD.replace('Why.', '<!-- never closed'))).toEqual([]);
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
    bodyProblems(`${GOOD}\n${'<!-- pr-gif:a -->\n'.repeat(5000)}`);
    expect(bodyProblems(`## a${' '.repeat(400000)}b`)).toHaveLength(2);
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

describe("bodyProblems: Revisions' current revision, in its details block and every shape before", () => {
  const base = GOOD.slice(0, GOOD.indexOf('## Revisions')).trimEnd();
  const link = (/** @type {string} */ sha) =>
    `[\`${sha.slice(0, 7)}\`](https://github.com/o/r/commit/${sha.padEnd(40, '0')})`;
  const wrap = (/** @type {string} */ table) =>
    `${base}\n\n<!-- pr-changes:revisions -->\n## Revisions\n\n${table}\n<!-- /pr-changes:revisions -->\n`;
  const fresh = (/** @type {string[]} */ ...lines) =>
    ['| What changed | Why |', '| --- | --- |', ...lines].join('\n');
  const revisions = (/** @type {string} */ body, /** @type {string} */ head) =>
    bodyProblems(body, head).filter((p) => /Revisions/.test(p));
  const html = (/** @type {string} */ sha, /** @type {string} */ repo = 'o/r') =>
    `<a href="https://github.com/${repo}/commit/${sha.padEnd(40, '0')}"><code>${sha.slice(0, 7)}</code></a>`;
  const htmlTable = (/** @type {string[]} */ ...rows) =>
    [
      '<table width="100%">',
      '<thead><tr><th width="30%">Revision</th><th width="70%">Why</th></tr></thead>',
      '<tbody>',
      ...rows,
      '</tbody>',
      '</table>',
    ].join('\n');
  const summaryOf = (/** @type {string} */ lead, /** @type {string} */ rows = '| a | b |') =>
    `<details open>\n<summary>${lead}</summary>\n\n| What changed | Why |\n| --- | --- |\n${rows}\n\n</details>`;
  const tables = {
    'the details block, the head bold with a pointer': [
      summaryOf(
        `<b>👉 ${html('abcdef0')}</b> (current) · compare · rewritten from <code>1111111</code>`,
      ),
      summaryOf(html('1111111')).replace('<details open>', '<details>'),
    ].join('\n\n'),
    'a details block an author took the pointer and the bold off': summaryOf(
      `${html('abcdef0')} (current)`,
    ),
    'a details block with the summary on the details line': `<details open><summary><b>${html('abcdef0')}</b> (current)</summary>\n\n| a | b |\n\n</details>`,
    'the HTML table, the current row bold with a pointer': htmlTable(
      `<tr><td><b>👉 ${html('abcdef0')}</b> (current)</td><td>y</td></tr>`,
      '<tr><td colspan="2">one</td></tr>',
      '<tr><td colspan="2">two</td></tr>',
      `<tr><td>${html('1111111')}</td><td></td></tr>`,
      '<tr><td colspan="2">old</td></tr>',
    ),
    'an HTML current row an author took the pointer off': htmlTable(
      `<tr><td><b>${html('abcdef0')}</b> (current)</td><td>y</td></tr>`,
    ),
    'the two-column table, the current row bold with a pointer': fresh(
      `| **👉 ${link('abcdef0')}** (current)<br>**w** | y |`,
      `| ${link('1111111')}<br>old | |`,
    ),
    'a current row an author took the pointer off': fresh(
      `| **${link('abcdef0')}** (current)<br>w | y |`,
    ),
    'a current row an author made plain': fresh(`| ${link('abcdef0')} (current)<br>w | y |`),
    'the old four-column table': [
      '| Rev | Head | What changed | Why |',
      '| --- | --- | --- | --- |',
      `| 2 (current) | ${link('abcdef0')} | w | y |`,
      `| 1 | ${link('1111111')} | Opened | |`,
    ].join('\n'),
  };

  it.each(Object.entries(tables))(
    'passes %s for its head, and fails it for another',
    (_name, table) => {
      expect(revisions(wrap(table), 'abcdef0123')).toEqual([]);
      const [problem] = revisions(wrap(table), '2222222333');
      expect(problem).toMatch(/names another commit than this PR's head, `2222222`/);
    },
  );

  it('reads only the summary of a details block, never the table an author wrote under it', () => {
    const rows = [
      '| fix (current) thing | (current) |',
      `| 2 (current) | ${link('1111111')} | w | y |`,
      `| ${link('1111111')} (current) | y |`,
      `| **👉 ${link('1111111')}** (current)<br>w | y |`,
    ].join('\n');
    const body = wrap(summaryOf(`<b>👉 ${html('abcdef0')}</b> (current)`, rows));
    expect(revisions(body, 'abcdef0123')).toEqual([]);
    // Another head: the summary's, not a row's, is the one named.
    expect(revisions(body, '2222222333')[0]).toMatch(
      /names another commit than this PR's head, `2222222`/,
    );
    // With no current summary, a row that says (current) in a table is no current revision.
    const plain = wrap(summaryOf(html('abcdef0'), rows));
    expect(revisions(plain, '2222222333')).toEqual([]);
  });

  it('reads the old four-column row as it always was: whatever its Head cell holds is compared with the head', () => {
    const row = (/** @type {string} */ head) => wrap(fresh(`| 2 (current) | ${head} | w | y |`));
    const bare = 'bbbbbbb';
    for (const head of [
      `[bbbbbbb](https://github.com/o/r/commit/${'b'.repeat(40)})`,
      `**${link('bbbbbbb')}**`,
      `\`${'b'.repeat(40)}\``,
      bare,
      `👉 ${link('bbbbbbb')}`,
      link('bbbbbbb'),
    ]) {
      expect(revisions(row(head), 'bbbbbbb123')).toEqual([]);
      expect(revisions(row(head), '2222222333')[0]).toMatch(/names another commit/);
    }
    // No head in the cell: another commit than the head, as ever.
    expect(revisions(row('not a link'), '2222222333')[0]).toMatch(/names another commit/);
  });
  it('reads an HTML row only when its cell opens on the row line, as the tool writes it', () => {
    expect(
      revisions(
        wrap(htmlTable(`<tr>\n<td>\n<b>👉 ${html('abcdef0')}</b> (current)</td><td>y</td></tr>`)),
        '2222222333',
      ),
    ).toEqual([]);
  });
  it('takes out only what the tool wrote: an author details block, closed or not, hides nothing', () => {
    const old = (/** @type {string} */ head) =>
      fresh(`| 2 (current) | ${link(head)} | w | y |`, `| 1 | ${link('1111111')} | Opened | |`);
    // An author's own <details> that is never closed, ahead of the old table.
    expect(
      revisions(
        wrap(`<details>\n<summary>my notes</summary>\n\n${old('bbbbbbb')}`),
        '2222222333',
      )[0],
    ).toMatch(/names another commit/);
    expect(revisions(wrap(`<details open>\n${old('bbbbbbb')}`), '2222222333')[0]).toMatch(
      /names another commit/,
    );
    // The table in a block the author wrapped in their own details (a summary that is no head link).
    const wrapped = `<details>\n<summary>Revisions</summary>\n\n${old('bbbbbbb')}\n\n</details>`;
    expect(revisions(wrap(wrapped), '2222222333')[0]).toMatch(/names another commit/);
    expect(revisions(wrap(wrapped), 'bbbbbbb123')).toEqual([]);
    // A tool block that is never closed has nothing taken out: the row after it is read, as before.
    const open = `<details>\n<summary>${html('abcdef0')}</summary>\n\n${old('bbbbbbb')}`;
    expect(revisions(wrap(open), '2222222333')[0]).toMatch(/names another commit/);
  });

  it('reads the HTML current row, not an older row that says (current) in its text or its Why', () => {
    const body = wrap(
      htmlTable(
        `<tr><td><b>👉 ${html('abcdef0')}</b> (current)</td><td>y</td></tr>`,
        `<tr><td>${html('1111111')}</td><td>(current)</td></tr>\n<tr><td colspan="2">fix (current) thing</td></tr>`,
      ),
    );
    expect(revisions(body, 'abcdef0123')).toEqual([]);
    const plainOnly = wrap(
      htmlTable(
        `<tr><td>${html('1111111')}</td><td>(current)</td></tr>\n<tr><td colspan="2">fix (current) thing</td></tr>`,
      ),
    );
    expect(revisions(plainOnly, '2222222333')).toEqual([]);
  });

  it('reads the current row of a description that mixes the HTML table and a Markdown one', () => {
    const mixed = wrap(
      [
        htmlTable(`<tr><td>${html('1111111')}</td><td></td></tr>`),
        '',
        fresh(`| ${link('abcdef0')} (current)<br>w | y |`),
      ].join('\n'),
    );
    expect(revisions(mixed, 'abcdef0123')).toEqual([]);
    expect(revisions(mixed, '2222222333')[0]).toMatch(/names another commit/);
  });

  it.each([
    ['a link that is no commit', `<a href="https://elsewhere.example/x"><code>abcdef0</code></a>`],
    [
      'another host',
      `<a href="https://example.com/o/r/commit/${'a'.repeat(40)}"><code>aaaaaaa</code></a>`,
    ],
    [
      'a sha that is not the one shown',
      `<a href="https://github.com/o/r/commit/${'1'.repeat(40)}"><code>abcdef0</code></a>`,
    ],
    [
      'a short sha in the link',
      `<a href="https://github.com/o/r/commit/abcdef0"><code>abcdef0</code></a>`,
    ],
  ])('does not read an HTML cell with %s as a current row', (_name, a) => {
    expect(
      revisions(wrap(htmlTable(`<tr><td>${a} (current)</td><td>y</td></tr>`)), '2222222333'),
    ).toEqual([]);
    expect(
      revisions(
        wrap(htmlTable(`<tr><td><b>👉 ${a}</b> (current)</td><td>y</td></tr>`)),
        '2222222333',
      ),
    ).toEqual([]);
  });

  it('does not read (current) after text in the cell, or a row that is no row, as the current row', () => {
    const cell = (/** @type {string} */ c) => wrap(htmlTable(`<tr><td>${c}</td></tr>`));
    expect(revisions(cell(`see ${html('abcdef0')} (current)`), '2222222333')).toEqual([]);
    expect(revisions(cell(`${html('abcdef0')} now`), '2222222333')).toEqual([]);
    expect(
      revisions(wrap(`text <tr><td>${html('abcdef0')} (current)</td></tr>`), '2222222333'),
    ).toEqual([]);
  });

  it('reads the current row, not an older row that says (current) in its text', () => {
    const body = wrap(
      fresh(
        `| **👉 ${link('abcdef0')}** (current)<br>**w** | y |`,
        `| ${link('1111111')}<br>fix (current) thing | |`,
      ),
    );
    expect(revisions(body, 'abcdef0123')).toEqual([]);
    const plainOnly = wrap(fresh(`| ${link('1111111')}<br>fix (current) thing | |`));
    expect(revisions(plainOnly, '2222222333')).toEqual([]);
  });

  it.each([
    ['a pointer with no bold', `👉 ${link('abcdef0')} (current)<br>w`],
    ['the (current) inside the bold', `**👉 ${link('abcdef0')} (current)**<br>w`],
    ['no space before (current)', `**👉 ${link('abcdef0')}**(current)<br>w`],
    ['a link that is no commit', '**👉 [`abcdef0`](https://elsewhere.example/x)** (current)<br>w'],
    [
      'a sha that is not the one shown',
      `**👉 [\`abcdef0\`](https://github.com/o/r/commit/${'1'.repeat(40)})** (current)<br>w`,
    ],
  ])('does not read %s as a current row', (_name, cell) => {
    expect(revisions(wrap(fresh(`| ${cell} | y |`)), '2222222333')).toEqual([]);
  });

  it('does not take a code fence for the table', () => {
    const fenced = `${base}\n\n\`\`\`\n${tables['the two-column table, the current row bold with a pointer']}\n\`\`\`\n`;
    expect(revisions(fenced, '2222222333')).toEqual([]);
  });
});

describe("bodyProblems: Revisions' marker pair, once a push has moved the head", () => {
  const START = '<!-- pr-changes:revisions -->';
  const END = '<!-- /pr-changes:revisions -->';
  const base = GOOD.slice(0, GOOD.indexOf('## Revisions')).trimEnd();
  const head = 'abcdef0123';
  const row = '| 2 (current) | [`abcdef0`](https://github.com/o/r/commit/abcdef0123) | w | y |';
  const withPair = `${base}\n\n${START}\n${END}\n`;
  const withTable = `${base}\n\n${START}\n## Revisions\n\n| Rev | Head | What changed | Why |\n| --- | --- | --- | --- |\n${row}\n${END}\n`;
  const revisions = (/** @type {string} */ body, /** @type {{ pushed?: boolean }} */ event) =>
    bodyProblems(body, head, event).filter((p) =>
      /pr-changes:revisions|Revisions:|update Revisions/.test(p),
    );

  it('asks for the pair after a push, and says how to fix it', () => {
    const [problem] = revisions(base, { pushed: true });
    expect(problem).toMatch(/no `<!-- pr-changes:revisions -->`.*pair/);
    expect(problem).toMatch(/puts a missing pair back/);
  });

  it('does not ask for it of a PR that has not been pushed to, whatever its commits', () => {
    for (const event of [{}, { pushed: false }]) expect(revisions(base, event)).toEqual([]);
    // A multi-commit PR opened, reopened, edited or marked ready is not asked: the event is no push,
    // and the check is not given a commit count.
  });

  it('wants one clean pair, in order, each marker alone on its line and outside code', () => {
    expect(revisions(withPair, { pushed: true })[0]).toMatch(/no current row/);
    for (const torn of [
      `${base}\n${START}\n`,
      `${base}\n${END}\n${START}\n`,
      `${withPair}\n${START}\n${END}\n`,
    ]) {
      expect(revisions(torn, { pushed: true })[0]).toMatch(/exactly one/);
    }
    const fenced = `${base}\n\n\`\`\`\n${START}\n${END}\n\`\`\`\n`;
    expect(revisions(fenced, { pushed: true })[0]).toMatch(/no `<!-- pr-changes:revisions -->`/);
    const quoted = `${base}\n\nKeep \`${START}\` and \`${END}\` in it.\n`;
    expect(revisions(quoted, { pushed: true })[0]).toMatch(/no `<!-- pr-changes:revisions -->`/);
    // A fenced example beside the real pair is not a second pair.
    const both = `${withTable}\n\`\`\`\n${START}\n${END}\n\`\`\`\n`;
    expect(revisions(both, { pushed: true })).toEqual([]);
  });

  it('after a push, wants a current row too, which the tool writes', () => {
    expect(revisions(withPair, { pushed: true })[0]).toMatch(/no current row/);
    expect(revisions(withTable, { pushed: true })).toEqual([]);
    // Not after an edit: a table the tool hasn't written yet is not this check's to ask for.
    expect(revisions(withPair, {})).toEqual([]);
  });
});

describe('revisionsPair and maskFences, with backslashes in the description', () => {
  const START = '<!-- pr-changes:revisions -->';
  const END = '<!-- /pr-changes:revisions -->';

  it('finds the pair whatever backslashes the text around it holds', () => {
    const body = `C:\\dir\\file \\\\ \\n\n\\\\\n${START}\n${END}\n\\`;
    const { at } = revisionsPair(body);
    expect(at).not.toBeNull();
    expect(body.slice(at?.from, at?.to)).toBe(`${START}\n${END}`);
  });

  it('does not take a backslash for part of a marker, or as an escape inside one', () => {
    for (const body of [
      `\\${START}\n${END}\n`,
      `${START}\\\n${END}\n`,
      `${START}\n\\${END}\n`,
      `${START.replace('<!--', '<\\!--')}\n${END}\n`,
      `${START.replace('pr-changes', 'pr\\-changes')}\n${END}\n`,
    ]) {
      expect(revisionsPair(body).at).toBeNull();
    }
  });

  it('closes a fence by its own character and length, backslashes in the info string or not', () => {
    const body = ['```js \\`\\\\', START, '````', START, '```', END, ''].join('\n');
    // The four-backtick line closes the three-backtick fence, so the second start is outside;
    // the last ``` then opens a fence that never closes, which hides the end marker.
    expect(maskFences(body)).toHaveLength(body.length);
    const { starts, ends } = revisionsPair(body);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);
    const tilde = ['~~~ \\', START, '```', END, '~~~', START, ''].join('\n');
    expect(revisionsPair(tilde).starts).toHaveLength(1);
    expect(revisionsPair(tilde).ends).toHaveLength(0);
  });
});

describe('bodyProblems for changes the tool titles (no numbered heading)', () => {
  const pair = (/** @type {number} */ n, /** @type {string} */ inner = '') =>
    `<!-- pr-changes:change:${n} -->\n${inner}<!-- /pr-changes:change:${n} -->`;
  const title = (/** @type {number} */ n) =>
    `**${n}. Do a thing** [\`abc1234\`](https://github.com/o/r/commit/abc1234)\n`;
  /** @param {string} changes */
  const withChanges = (changes) =>
    GOOD.replace(/### 1\. The change[\s\S]*?\n\n## Checklist/, () => `${changes}\n\n## Checklist`);

  it('passes a change that is a filled pair with its why under it', () => {
    expect(bodyProblems(withChanges(`${pair(1, title(1))}\n\n- Why.\n`))).toEqual([]);
    expect(
      bodyProblems(withChanges(`${pair(1, title(1))}\n\n- One.\n\n${pair(2, title(2))}\n\n- Two.`)),
    ).toEqual([]);
  });

  it('says which change has its pair still empty', () => {
    expect(
      bodyProblems(withChanges(`${pair(1, title(1))}\n\n- One.\n\n${pair(2)}\n\n- Two.`)),
    ).toEqual([
      'under change 2, its `<!-- pr-changes:change:2 -->` pair is empty: the changes tool fills it with the commit and files on the next push, or link the commit yourself',
    ]);
  });

  it('asks for a change when there is none, and for the pair to be a pair', () => {
    expect(bodyProblems(withChanges('- Only a why.'))[0]).toMatch(/add a change: an empty/);
    expect(bodyProblems(withChanges('<!-- pr-changes:change:1 -->\n- torn'))[0]).toMatch(
      /add a change: an empty/,
    );
  });

  it('still passes a description with numbered headings, each with its pair filled the old way', () => {
    const old = withChanges(
      `### 1. A\n\nWhy.\n\n${pair(1, '[`abc1234`](https://github.com/o/r/commit/abc1234) Do a thing\n')}`,
    );
    expect(bodyProblems(old)).toEqual([]);
  });

  it("still wants a heading's commit, and takes the new title in its pair for it", () => {
    expect(bodyProblems(withChanges(`### 1. A\n\nWhy.\n\n${pair(1)}`))[0]).toMatch(
      /under change 1, its .* pair is empty/,
    );
    expect(bodyProblems(withChanges(`### 1. A\n\nWhy.\n\n${pair(1, title(1))}`))).toEqual([]);
  });

  it('holds a GIF to a place under a change: under its pair is fine, above the first is not', () => {
    const gif = '<!-- pr-gif:swipe -->\n<!-- /pr-gif:swipe -->';
    const ok = withChanges(`${pair(1, title(1))}\n\n- Why.\n\n${gif}`);
    expect(bodyProblems(ok)).toEqual([]);
    const above = withChanges(`${gif}\n\n${pair(1, title(1))}\n\n- Why.`);
    expect(bodyProblems(above)[0]).toMatch(/put the GIF block `pr-gif:swipe` under the change/);
  });

  it('asks for the why under a pair that has nothing under it', () => {
    expect(bodyProblems(withChanges(pair(1, title(1))))).toEqual([
      'under change 1, write why: bullets (or numbered steps) under its `<!-- pr-changes:change:1 -->` pair, since the changes tool writes only the title, the commit and the files',
    ]);
    expect(
      bodyProblems(withChanges(`${pair(1, title(1))}\n\n- One.\n\n${pair(2, title(2))}\n\n`)),
    ).toHaveLength(1);
    // A GIF or a screen under a pair is not a why.
    const gif = '<!-- pr-gif:swipe -->\n<!-- /pr-gif:swipe -->';
    expect(bodyProblems(withChanges(`${pair(1, title(1))}\n\n${gif}`))[0]).toMatch(/write why/);
  });

  it('catches the sample line indented, numbered or plain, and a heading-style change needs no why under its pair', () => {
    for (const sample of [
      'Why this change.',
      '  - Why this change.',
      '1. Why this change.',
      '* Why this change.',
    ]) {
      expect(bodyProblems(withChanges(`${pair(1, title(1))}\n\n${sample}\n`))[0]).toMatch(
        /replace the template's sample change/,
      );
    }
    expect(bodyProblems(withChanges(`### 1. A\n\n${pair(1, title(1))}`))).toEqual([]);
  });

  it('is not fooled by a numbered sub-heading in the why: the empty pair after it is still named', () => {
    const body = withChanges(
      `${pair(1, title(1))}\n\n- One.\n\n### 1. Steps\n\n- first\n\n${pair(2)}\n\n- Two.`,
    );
    expect(bodyProblems(body)).toEqual([
      'under change 2, its `<!-- pr-changes:change:2 -->` pair is empty: the changes tool fills it with the commit and files on the next push, or link the commit yourself',
    ]);
  });

  it('checks a pair that comes before the first heading too', () => {
    const body = withChanges(`${pair(1)}\n\n- One.\n\n### 2. B\n\n${pair(2, title(2))}`);
    expect(bodyProblems(body)).toHaveLength(1);
    expect(bodyProblems(body)[0]).toMatch(/under change 1, its .* pair is empty/);
  });

  it('wants the pairs numbered 1, 2, 3 in order when no heading carries the numbers', () => {
    const numbered = (/** @type {number[]} */ ns) =>
      withChanges(ns.map((n) => `${pair(n, title(n))}\n\n- Why.`).join('\n\n'));
    expect(bodyProblems(numbered([1, 2, 3]))).toEqual([]);
    for (const ns of [[2, 1], [1, 3], [1, 1], [2]]) {
      const found = bodyProblems(numbered(ns));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/number the change pairs 1, 2, 3… in the order they appear/);
    }
    // With headings carrying the numbers (a description from before), it is left alone.
    const old = withChanges(`### 2. B\n\n${pair(2, title(2))}\n\n### 1. A\n\n${pair(1, title(1))}`);
    expect(bodyProblems(old)).toEqual([]);
  });
  it('replaces the template sample: its Why line is a placeholder in a pair-only change too', () => {
    expect(bodyProblems(withChanges(`${pair(1, title(1))}\n\nWhy this change.\n`))[0]).toMatch(
      /replace the template's sample change/,
    );
  });
});

describe("bodyProblems: the current revision's rows (ci#140)", () => {
  const base = GOOD.slice(0, GOOD.indexOf('## Revisions')).trimEnd();
  const HEAD = 'abcdef0'.padEnd(40, '1');
  const OLD = '1111111'.padEnd(40, '0');
  const html = (/** @type {string} */ sha) =>
    `<a href="https://github.com/o/r/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>`;
  /** A revision as the tool writes it: the current one bold, its table's rows as given. */
  const block = (/** @type {string} */ sha, /** @type {string[]} */ rows, current = true) =>
    [
      current ? '<details open>' : '<details>',
      current
        ? `<summary><b>👉 ${html(sha)}</b> (current) · <a href="https://github.com/o/r/compare/${OLD}...${sha}">compare <code>1111111…${sha.slice(0, 7)}</code></a></summary>`
        : `<summary>${html(sha)} · Opened</summary>`,
      '',
      '| What changed | Why |',
      '| --- | --- |',
      ...rows,
      '',
      '</details>',
    ].join('\n');
  const wrap = (/** @type {string} */ inner) =>
    `${base}\n\n<!-- pr-changes:revisions -->\n## Revisions\n\n${inner}\n<!-- /pr-changes:revisions -->\n`;
  const revisions = (/** @type {string} */ body, head = HEAD) =>
    bodyProblems(body, head).filter((p) => /Revisions/.test(p));
  const NONE =
    "fill Revisions' current revision, `abcdef0`: its table has no row with both cells filled. In the description, write one row for each change this push made, both cells in plain words, such as `| The cap fails closed | It's the only paid API |` (each row opens with `|`; write a pipe in a cell as `\\|`). Do it once this push's `PR changes` run has ended: a run still going can write an older copy over your edit";
  const HALF = (/** @type {number} */ n) =>
    `fill both cells of every row in Revisions' current revision, \`abcdef0\`: ${n === 1 ? '1 row has' : `${n} rows have`} an empty What changed or Why`;
  const rowsOf = (/** @type {string[]} */ ...rows) =>
    revisions(wrap(`${block(HEAD, rows)}\n\n${block(OLD, ['|  |  |'], false)}`));

  it.each([
    ['the placeholder', ['|  |  |'], [NONE]],
    ['dashes', ['| — | — |'], [NONE]],
    ['a filled What and an empty Why', ['| The cap | |'], [NONE]],
    ['an empty What and a filled Why', ['| — | It is paid |'], [NONE]],
    ['a filled row', ['| The cap fails closed | It is the only paid API |'], []],
    ['a filled row beside the placeholder', ['| The cap | Paid |', '|  |  |'], []],
    ['a filled row beside a row of dashes', ['| The cap | Paid |', '| - | - |'], []],
    ['a filled row beside a half row', ['| The cap | Paid |', '| Docs | |'], [HALF(1)]],
    ['two half rows beside a filled one', ['| a | b |', '| c | |', '| | d |'], [HALF(2)]],
    ['a pipe written `\\|` in a cell', ['| `a \\| b` | c |'], []],
    ['a cell of only `\\|`', ['| \\| | Paid |'], [NONE]],
    ['a cell of tags and `&nbsp;` only', ['| <br>&nbsp;<b></b> | Paid |'], [NONE]],
    ['code in a cell', ['| <code>x</code> | `y` |'], []],
    ['a comment-only cell', ['| <!-- what --> | Paid |'], [NONE]],
    ['an emoji alone', ['| 🎉 | Paid |'], [NONE]],
    ['CJK text', ['| 修正 | 理由 |'], []],
    ['a digit alone', ['| 2 | 3 |'], []],
    ['a one-cell row', ['| The cap |'], [NONE]],
    ['a row with no closing pipe', ['| The cap | Paid'], []],
    ['a third cell, which GitHub does not show', ['| The cap | | Paid |'], [NONE]],
    [
      "a `</details>` in a row's code span",
      ['| Close it with `</details>` | GitHub needs it |'],
      [],
    ],
    ['the header in another case, which is the frame', ['| what changed | why |'], [NONE]],
    ['an entity for a letter, an autolink, an image', ['| &#65; | <https://x.example> |'], [NONE]],
    ['a tag or an entity in a code span, which shows as text', ['| `<summary>` | `&nbsp;` |'], []],
    ['a typed comment the tool made text', ['| &lt;!-- why --> | Paid |'], []],
  ])('%s', (_name, rows, expected) => {
    expect(rowsOf(...rows)).toEqual(expected);
  });

  it('reads only the current revision: an older one, filled or not, decides nothing', () => {
    const older = block(OLD, ['| Opened | For the goal |'], false);
    expect(revisions(wrap(`${block(HEAD, ['|  |  |'])}\n\n${older}`))).toEqual([NONE]);
    const filled = block(HEAD, ['| The cap | Paid |']);
    expect(revisions(wrap(`${filled}\n\n${block(OLD, ['|  |  |'], false)}`))).toEqual([]);
  });

  it('reads the current revision wherever it stands: after an older one, or after an author block', () => {
    const older = block(OLD, ['| Opened | For the goal, in a long row of words |'], false);
    expect(revisions(wrap(`${older}\n\n${block(HEAD, ['|  |  |'])}`))).toEqual([NONE]);
    expect(
      revisions(wrap(`${block(OLD, ['|  |  |'], false)}\n\n${block(HEAD, ['| a | b |'])}`)),
    ).toEqual([]);
    const mine = '<details>\n<summary>My notes</summary>\n\n| Notes | Here |\n\n</details>';
    expect(revisions(wrap(`${mine}\n\n${block(HEAD, ['|  |  |'])}`))).toEqual([NONE]);
  });

  it('reads rows to the end of the pair when the block has no closing line, and pipe rows after a blank line', () => {
    const open = block(HEAD, ['| The cap | Paid |']).replace(/\n<\/details>$/, '');
    expect(revisions(wrap(open))).toEqual([]);
    const empty = block(HEAD, ['|  |  |']).replace(/\n<\/details>$/, '');
    expect(revisions(wrap(empty))).toEqual([NONE]);
    // A row after the pair is not the revision's.
    expect(revisions(wrap(empty).replace(/\n$/, '\n\n| The cap | Paid |\n'))).toEqual([NONE]);
    expect(rowsOf('|  |  |', '', '| The cap | Paid |')).toEqual([]);
  });

  it("stops at the next revision's block when the current one isn't closed", () => {
    const open = block(HEAD, ['|  |  |']).replace(/\n<\/details>$/, '');
    expect(revisions(wrap(`${open}\n\n${block(OLD, ['| Opened | Goal |'], false)}`))).toEqual([
      NONE,
    ]);
  });

  it('does not read a row in an HTML comment block, which a reader does not see', () => {
    expect(rowsOf('<!--', '| a | b |', '-->')).toEqual([NONE]);
    expect(rowsOf('<!-- note', '| a | b |', 'more -->', '| The cap | Paid |')).toEqual([]);
    expect(rowsOf('<!-- one line --> | a | b |')).toEqual([NONE]);
    expect(rowsOf('<!-- -->', '| The cap | Paid |')).toEqual([]);
  });

  it('reads the rows after a summary that wraps onto a second line', () => {
    const wrapped = (/** @type {string} */ row) =>
      block(HEAD, [row]).replace(' · <a href=', '\n· <a href=');
    expect(wrapped('|  |  |')).toContain('(current)\n· <a');
    expect(revisions(wrap(wrapped('|  |  |')))).toEqual([NONE]);
    expect(revisions(wrap(wrapped('| The cap | Paid |')))).toEqual([]);
    // A summary that never closes before the block ends is no block: its rows are not judged.
    const unclosed = block(HEAD, ['|  |  |']).replace('</summary>', '');
    expect(revisions(wrap(unclosed))).toEqual([]);
  });

  it('reads the rows under a summary that ends with `</details>` on its own line, as the tool does', () => {
    const own = `<details open>\n<summary><b>👉 ${html(HEAD)}</b> (current)</summary></details>\n\n| What changed | Why |\n| --- | --- |\n`;
    expect(revisions(wrap(`${own}| A | B |`))).toEqual([]);
    expect(revisions(wrap(`${own}|  |  |`))).toEqual([NONE]);
  });

  it('reads nothing on a summary line that ends the block', () => {
    const one = `<details open><summary><b>👉 ${html(HEAD)}</b> (current)</summary></details>\n\n| The cap | Paid |`;
    expect(revisions(wrap(one))).toEqual([NONE]);
  });

  it('gives the same verdict for a CRLF description', () => {
    for (const rows of [['|  |  |'], ['| The cap | Paid |'], ['| a | b |', '| c | |']]) {
      const lf = wrap(block(HEAD, rows));
      expect(revisions(lf.replace(/\n/g, '\r\n'))).toEqual(revisions(lf));
    }
  });

  it('does not read a block in fenced code, nor take a fenced row as a row', () => {
    const fenced = `${base}\n\n\`\`\`\n${block(HEAD, ['|  |  |'])}\n\`\`\`\n`;
    expect(revisions(fenced)).toEqual([]);
    const row = block(HEAD, ['```', '| The cap | Paid |', '```']);
    expect(revisions(wrap(row))).toEqual([NONE]);
  });

  it("does not read an author's own details block, a stale head's rows, or a description with no block", () => {
    const mine = `<details>\n<summary>My notes</summary>\n\n|  |  |\n\n</details>`;
    expect(revisions(wrap(mine))).toEqual([]);
    // A stale head: only the existing problem, never the rows'.
    const stale = revisions(wrap(block(OLD, ['|  |  |'])));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/names another commit than this PR's head, `abcdef0`/);
    expect(revisions(base)).toEqual([]);
    // With no head given, nothing is read.
    expect(bodyProblems(wrap(block(HEAD, ['|  |  |']))).filter((p) => /Revisions/.test(p))).toEqual(
      [],
    );
  });

  it('does not judge the shapes from before the details blocks', () => {
    const link = `[\`abcdef0\`](https://github.com/o/r/commit/${HEAD})`;
    for (const table of [
      `| What changed | Why |\n| --- | --- |\n| **👉 ${link}** (current)<br> | |`,
      `| Rev | Head | What changed | Why |\n| --- | --- | --- | --- |\n| 2 (current) | ${link} | | |`,
      `<table>\n<tbody>\n<tr><td><b>👉 ${html(HEAD)}</b> (current)</td><td></td></tr>\n</tbody>\n</table>`,
    ]) {
      expect(revisions(wrap(table))).toEqual([]);
    }
  });

  it('says the sha, what to write and when, on a push as on an edit', () => {
    const body = wrap(block(HEAD, ['|  |  |']));
    expect(bodyProblems(body, HEAD, { pushed: true }).filter((p) => /Revisions/.test(p))).toEqual([
      NONE,
    ]);
  });
});

describe('holdsText and revisionRowProblems', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['—', false],
    ['-', false],
    ['<br>', false],
    ['&nbsp;', false],
    ['<!-- why -->', false],
    ['🎉', false],
    ['&#65;', false],
    ['<img src="x.png">', false],
    ['`x`', true],
    ['n/a', true],
    ['<code>x</code>', true],
    ['修正', true],
    ['<3 it', true],
    ['a <!-- never closed', true],
    ['<b never closed', true],
    ['`<br>`', true],
    ['`&nbsp;`', true],
    ['` `', false],
    ['`` ` ``', false],
    ['`unclosed <br>', true],
    ['<a title="`">x', true],
  ])('holdsText(%j) is %s', (cell, text) => {
    expect(holdsText(cell)).toBe(text);
  });

  it('reads a long hostile cell in linear time', () => {
    for (const cell of ['<!--'.repeat(20_000), '<a'.repeat(30_000), '&a'.repeat(30_000)]) {
      expect(holdsText(cell)).toBe(cell !== '<!--'.repeat(20_000));
    }
  });

  it('asks for a row with no rows at all', () => {
    expect(revisionRowProblems([], 'abcdef0123')).toHaveLength(1);
  });
});
