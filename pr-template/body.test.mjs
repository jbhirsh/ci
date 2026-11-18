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
  '## Changes',
  '',
  '### 1. The change',
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
      'add the heading `## Checklist`',
      'add the heading `## Revisions`',
    ]);
    expect(bodyProblems(undefined)).toHaveLength(4);
    expect(
      bodyProblems(
        GOOD.replace('## Goal', '## Problem').replace(
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
    for (const row of [html, markdown]) {
      expect(
        bodyProblems(GOOD.replace('## Changes', `## Plan\n\n${row}\n\n## Changes`))[0],
      ).toMatch(/plan table's template row/);
    }
    const filled = html.replace('<b></b>', '<b>The thing</b>');
    expect(bodyProblems(GOOD.replace('## Changes', `## Plan\n\n${filled}\n\n## Changes`))).toEqual(
      [],
    );
  });

  it('flags a heading twice and headings out of order', () => {
    expect(bodyProblems(GOOD.replace('## Checklist', '## Checklist\n\n## Checklist'))).toEqual([
      'keep one `## Checklist` heading, not 2',
    ]);
    const swapped = GOOD.replace('## Checklist', '## Zzz')
      .replace('## Revisions', '## Checklist')
      .replace('## Zzz', '## Revisions');
    expect(bodyProblems(swapped)[0]).toMatch(/template's order/);
  });

  it('wants words under the goal and a numbered change under Changes', () => {
    expect(bodyProblems(GOOD.replace('Make it work.', '<!-- later -->'))[0]).toMatch(
      /write the goal/,
    );
    expect(bodyProblems(GOOD.replace('### 1. The change', '### The change'))[0]).toMatch(
      /numbered change heading/,
    );
  });

  it('flags the "No visible UI change" box', () => {
    expect(bodyProblems(`${GOOD}\n\n- [x] No visible UI change`).join()).toMatch(
      /No visible UI change/,
    );
  });

  it("reads what a reader sees, not code, comments or tools' blocks", () => {
    const noChecklist = GOOD.replace('## Checklist', '```\n## Checklist\n```');
    expect(bodyProblems(noChecklist)).toEqual(['add the heading `## Checklist`']);
    expect(bodyProblems(GOOD.replace('## Checklist', '<!-- ## Checklist -->'))).toHaveLength(1);
    const block = '<!-- pr-changes:revisions -->\n## Checklist\n<!-- /pr-changes:revisions -->';
    expect(bodyProblems(GOOD.replace('## Checklist', block))).toEqual([
      'add the heading `## Checklist`',
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
      'add the heading `## Checklist`',
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
    expect(bodyProblems(`## a${' '.repeat(400000)}b`)).toHaveLength(4);
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
