import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUDGET, escape, fill, renderChange } from './changes.ts';

const WHERE = { repo: 'jbhirsh/app', number: 1, n: 1 };

describe('escape', () => {
  it('never leaves a tag, a mention or a line break for any text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const out = escape(text);
        expect(out).not.toMatch(/[<>\r\n]/);
        expect(out).not.toMatch(/@(?!\u200b)/);
      }),
    );
  });
});

describe('renderChange and fill', () => {
  // What a commit's first line can be: any text, and the awkward ones (trailing
  // space, a CR from a CRLF message, nothing, replacement patterns).
  const subjectArb = fc.oneof(
    fc.string(),
    fc.string().map((s) => `${s} `),
    fc.string().map((s) => `${s}\r`),
    fc.constantFrom('', ' ', '\r', '\t', 'Fix x ', '$&', '$1', '$`', "$'", '$$', 'a \u200b'),
  );
  const commitArb = fc.record({
    sha: fc.stringMatching(/^[0-9a-f]{40}$/),
    subject: subjectArb,
    files: fc.array(
      fc.record({ path: fc.string({ minLength: 1 }), added: fc.nat(), removed: fc.nat() }),
      { maxLength: 5 },
    ),
  });

  /**
   * A stand-in for a pair's picture, so what is where can be told apart.
   */
  const pair = (added: number, removed: number) => `<pair ${added} ${removed}>`;

  it('never throws, totals what the files add up to, and puts the pair in the title and on every file line', () => {
    fc.assert(
      fc.property(commitArb, (commit) => {
        const out = renderChange(commit, { ...WHERE, pair });
        if (commit.files.length === 0) return;
        const added = commit.files.reduce((n, f) => n + f.added, 0);
        const removed = commit.files.reduce((n, f) => n + f.removed, 0);
        expect(out).toContain(`changed ${pair(added, removed)}</summary>`);
        const lines = out.split('\n').filter((line) => line.startsWith('- ['));
        expect(lines).toHaveLength(commit.files.length);
        lines.forEach((line, i) => {
          const f = commit.files[i];
          expect(line.endsWith(`) ${pair(f.added, f.removed)}`)).toBe(true);
        });
      }),
    );
  });

  it('steps down: plain counts on the file lines, then plain totals and no file lists', () => {
    fc.assert(
      fc.property(commitArb, (commit) => {
        if (commit.files.length === 0) return;
        const added = commit.files.reduce((n, f) => n + f.added, 0);
        const removed = commit.files.reduce((n, f) => n + f.removed, 0);
        const titles = renderChange(commit, { ...WHERE, pair, level: 'titles' });
        expect(titles).toContain(`changed ${pair(added, removed)}</summary>`);
        expect(titles.slice(titles.indexOf('</summary>'))).not.toContain('<pair');
        const totals = renderChange(commit, { ...WHERE, pair, level: 'totals' });
        expect(totals).not.toContain('<pair');
        expect(totals).not.toContain('<details>');
        expect(totals.endsWith(` changed +${added} −${removed}`)).toBe(true);
      }),
    );
  });

  // A subject's `$` is escaped, so it can't start math that swallows the
  // rest of the description.
  it('leaves the commit line no unescaped `$`', () => {
    fc.assert(
      fc.property(commitArb, (commit) => {
        const [line] = renderChange(commit, WHERE).split('\n');
        expect(line).not.toMatch(/(?<!\\)\$/);
      }),
    );
  });

  // The title is `**N. <subject>** [sha](link)`: the number is the marker's, the
  // subject can't break out of the bold (no space or nothing inside the stars),
  // and the commit link is the last thing on the line.
  it('writes each title as its own number, a bold subject and the commit link last', () => {
    fc.assert(
      fc.property(fc.array(commitArb, { minLength: 1, maxLength: 4 }), (commits) => {
        const slots = commits
          .map(
            (_, i) => `<!-- pr-changes:change:${i + 1} -->\n<!-- /pr-changes:change:${i + 1} -->`,
          )
          .join('\n\n');
        const out = fill(`## Changes\n\n${slots}\n`, commits, WHERE).body;
        const titles = out.split('\n').filter((line) => /^\*\*\d+\. /.test(line));
        expect(titles).toHaveLength(commits.length);
        titles.forEach((line, i) => {
          expect(line.startsWith(`**${i + 1}. `)).toBe(true);
          expect(line.endsWith(`](https://github.com/jbhirsh/app/commit/${commits[i].sha})`)).toBe(
            true,
          );
          expect(line).toMatch(/^\*\*\d+\. \S(.*\S)?\*\* \[`[0-9a-f]{7}`\]/);
        });
      }),
    );
  });

  it('is idempotent for any commits', () => {
    fc.assert(
      fc.property(fc.array(commitArb, { minLength: 1, maxLength: 4 }), (commits) => {
        const slots = commits
          .map(
            (_, i) => `<!-- pr-changes:change:${i + 1} -->\n<!-- /pr-changes:change:${i + 1} -->`,
          )
          .join('\n\n');
        const once = fill(`## Changes\n\n${slots}\n`, commits, WHERE).body;
        expect(fill(once, commits, WHERE).body).toBe(once);
      }),
    );
  });
});

describe('fill and the budget', () => {
  it('never writes a description over BUDGET, whatever the commits and what is already there', () => {
    const file = fc.record({
      path: fc.string({ minLength: 1, maxLength: 80 }),
      added: fc.nat(1_000_000),
      removed: fc.nat(1_000_000),
    });
    const commitOf = fc.record({
      sha: fc.stringMatching(/^[0-9a-f]{40}$/),
      subject: fc.string({ maxLength: 200 }),
      files: fc.array(file, { maxLength: 120 }),
    });
    const link = 'https://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555';
    const stand = (a: number, r: number) =>
      `<picture><source media="(min-width: 768px)" srcset="${link}"><img src="${link}" alt="+${a} −${r}"></picture>`;
    fc.assert(
      fc.property(
        fc.array(commitOf, { minLength: 1, maxLength: 3 }),
        fc.nat(BUDGET),
        (commits, pad) => {
          const slots = commits
            .map(
              (_, i) => `<!-- pr-changes:change:${i + 1} -->\n<!-- /pr-changes:change:${i + 1} -->`,
            )
            .join('\n');
          const out = fill(`${slots}\n${'x'.repeat(pad)}`, commits, WHERE, {
            pair: stand,
            reserve: 3000,
          });
          if (out.problem === null) expect(out.body.length).toBeLessThanOrEqual(BUDGET);
        },
      ),
      { numRuns: 60 },
    );
  });
});
