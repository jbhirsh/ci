import { describe, expect, it } from 'vitest';
import { MAX_CHARS } from '../lib/comment.mjs';
import { bodyProblems } from '../pr-template/body.mjs';
import { gitHubIo, headingBefore, main, revisions } from './revisions-run.mjs';
import { parseTable } from './revisions.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PAIR = '<!-- pr-changes:revisions -->\n<!-- /pr-changes:revisions -->';
const BODY = `## Goal\n\nMake it work. More.\n\n## Changes\n\n### 1. c\n\nwhy\n\n## Checklist\n\nNothing to do.\n\n${PAIR}\n`;
/** The check's Revisions problems for a description at `head`. */
const revisionsProblems = (/** @type {string} */ text, /** @type {string} */ head) =>
  bodyProblems(text, head).filter((p) => /Revisions/.test(p));
/** The description with the current revision's placeholder row filled, as its author would (ci#140). */
const filled = (/** @type {string} */ text) => text.replace('|  |  |', '| A change | Its reason |');
/** The check's one problem with a fresh write: the current revision's row, for `head`, is to fill. */
const toFill = (/** @type {string} */ head) => [
  expect.stringMatching(new RegExp(`^fill Revisions' current revision, \`${head.slice(0, 7)}\`: `)),
];

/**
 * A fake io: a description that writes replace, and a PR at a head.
 *
 * @param {Partial<Omit<import('./revisions-run.mjs').Io, 'body' | 'pull'>> & { body?: string, pull?: Partial<import('./revisions-run.mjs').Pull>, heads?: string[] }} [over]
 */
function fake({ body: first, pull, heads: queued, ...over } = {}) {
  let body = first ?? BODY;
  const heads = [...(queued ?? [])];
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const writes = [];
  /** @type {import('./revisions-run.mjs').Io} */
  const io = {
    pull: () => ({
      state: 'open',
      author: 'person',
      headRef: 'feature',
      headSha: heads.length > 0 ? /** @type {string} */ (heads.shift()) : B,
      headRepo: REPO,
      ...pull,
    }),
    body: () => body,
    commits: () => [
      { sha: '1', subject: 'First', skipped: false },
      { sha: '2', subject: 'Second', skipped: false },
      { sha: 'm', subject: 'Merge main', skipped: true },
    ],
    compare: () => ({ status: 'ahead', behindBy: 0, base: A, shas: ['2', 'm', 'other'] }),
    timeline: () => [],
    write: (b) => {
      writes.push(b);
      body = b;
    },
    canWrite: true,
    log: (l) => logs.push(l),
    ...over,
  };
  return { io, logs, writes, body: () => body };
}

const run = (/** @type {ReturnType<typeof fake>} */ f, /** @type {string | null} */ before = A) =>
  revisions(f.io, { repo: REPO, before });

describe('revisions', () => {
  it('writes nothing for a PR with one head and no table (no push says otherwise)', () => {
    const f = fake();
    expect(run(f, null)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('on the first push writes the heading, revision 1 for the opening head and the current revision', () => {
    const f = fake();
    expect(run(f)).toBe(true);
    const out = f.body();
    expect(out).toContain('## Revisions');
    expect(out).toContain(`<details>\n<summary><a href="https://github.com/${REPO}/commit/${A}">`);
    expect(out).toContain('· Opened</summary>');
    // The goal's first sentence is what the first revision was for; the tool derives nothing from commits.
    expect(out).toContain('| — | Make it work. |');
    expect(out).toContain(
      '<details open>\n<summary><b>👉 <a href="https://github.com/o/r/commit/bbbb',
    );
    expect(out).toContain(
      `· <a href="https://github.com/${REPO}/compare/${A}...${B}">compare <code>aaaaaaa…bbbbbbb</code></a></summary>`,
    );
    expect(out).toContain('|  |  |');
    expect(out).not.toContain('First');
    expect(out).not.toContain('Second');
    // Only the block changed.
    expect(
      out.replace(/<!-- pr-changes:revisions -->[\s\S]*<!-- \/pr-changes:revisions -->/, PAIR),
    ).toBe(BODY);
    // The check names the head and asks for the row the author writes (ci#140), then passes.
    expect(revisionsProblems(out, B)).toEqual(toFill(B));
    expect(revisionsProblems(filled(out), B)).toEqual([]);
  });

  describe('a description without the revisions pair', () => {
    const INDEX = '<!-- pr-changes:index -->\n<!-- /pr-changes:index -->';
    const bare = BODY.replace(PAIR, '').replace(/\n+$/, '\n');

    it('gets the pair when a push moved the head, then the table', () => {
      const f = fake({ body: `${bare}\n${INDEX}\n` });
      expect(run(f)).toBe(true);
      const out = f.body();
      expect(out.indexOf('## Revisions')).toBeLessThan(out.indexOf('pr-changes:index'));
      expect(out).toContain('<b>👉 <a href="https://github.com/o/r/commit/bbbb');
      expect(out.match(/pr-changes:revisions -->/g)).toHaveLength(2);
      expect(revisionsProblems(out, B)).toEqual(toFill(B));
      expect(revisionsProblems(filled(out), B)).toEqual([]);
    });

    it('is written at the end, or ahead of a footer, when there is no index block', () => {
      const g = fake({ body: bare });
      run(g);
      expect(g.body().trimEnd().endsWith('<!-- /pr-changes:revisions -->')).toBe(true);
      const h = fake({ body: `${bare}\n---\n_Generated by a tool_\n` });
      run(h);
      expect(h.body()).toMatch(/<!-- \/pr-changes:revisions -->\n\n---\n_Generated by a tool_\n$/);
    });

    it('is left alone with no BEFORE (an edit), at one head, or when a marker is torn', () => {
      for (const [body, before] of /** @type {[string, string | null][]} */ ([
        [bare, null],
        [bare, B],
        [`${bare}\n<!-- pr-changes:revisions -->\n`, A],
      ])) {
        const f = fake({ body });
        expect(run(f, before)).toBe(false);
        expect(f.writes).toEqual([]);
      }
    });

    it('still needs a person’s token, and a fork gets nothing', () => {
      expect(() => run(fake({ body: bare, canWrite: false }))).toThrow(/BOT_PR_TOKEN/);
      const f = fake({ body: bare, pull: { headRepo: 'x/y' } });
      expect(run(f)).toBe(false);
      expect(f.writes).toEqual([]);
    });
  });

  describe('the first write, from the PR’s timeline', () => {
    const sha = (/** @type {number} */ n) => n.toString(16).padStart(2, '0').repeat(20);
    const short = (/** @type {number} */ n) => sha(n).slice(0, 7);
    const forced = (/** @type {string} */ id) => ({
      event: 'head_ref_force_pushed',
      commit_id: id,
    });
    // A row has no number written: it is counted from the oldest, which is what this reads.
    const revs = (/** @type {string} */ out) =>
      parseTable(
        /<!-- pr-changes:revisions -->([\s\S]*)<!-- \/pr-changes:revisions -->/.exec(out)?.[1] ??
          '',
        REPO,
      ).rows.map((r) => [r.rev, r.sha.slice(0, 7)]);

    it('writes one row per head a force-push made, in order, the newest current', () => {
      const [h1, h2, h3] = [sha(1), sha(2), sha(3)];
      const f = fake({
        pull: { headSha: h3 },
        timeline: () => [{ event: 'committed' }, forced(h1), forced(h2), forced(h3)],
        compare: (prev) =>
          prev === h1 ? null : { status: 'diverged', behindBy: 2, base: sha(9), shas: ['2'] },
      });
      expect(run(f, h2)).toBe(true);
      const out = f.body();
      expect(revs(out)).toEqual([
        [3, short(3)],
        [2, short(2)],
        [1, short(1)],
      ]);
      expect(out).toContain('<b>👉 <a href="https://github.com/o/r/commit/');
      expect(out).toContain("the first head GitHub's record of the PR names");
      expect(out).toContain('Make it work.');
      // h1 -> h2 can't be compared: its commits are gone, and there is no compare link to write.
      const summaries = out.split('\n').filter((l) => l.startsWith('<summary>'));
      expect(summaries.map((l) => l.includes('compare/'))).toEqual([true, false, false]);
      expect(out).toContain('(commits replaced by a force-push)</summary>');
      // h2 -> h3 was rewritten, 2 commits no longer on the branch.
      expect(out).toMatch(
        new RegExp(`rewritten from <code>${short(2)}</code> \\(2 commits dropped\\)`),
      );
      // Only the current revision is judged: the rebuilt older ones keep their empty rows.
      expect(revisionsProblems(out, h3)).toEqual(toFill(h3));
      expect(revisionsProblems(filled(out), h3)).toEqual([]);
      expect(filled(out)).toContain('|  |  |');
    });

    it('writes no commit of the PR: a compare link on every revision after the first, an empty row to fill', () => {
      const [h1, h2, h3] = [sha(1), sha(2), sha(3)];
      const many = Array.from({ length: 11 }, (_, i) => `${i + 1}`);
      const f = fake({
        pull: { headSha: h3 },
        timeline: () => [forced(h1), forced(h2), forced(h3)],
        commits: () => many.map((n) => ({ sha: n, subject: `Subject ${n}`, skipped: false })),
        compare: () => ({ status: 'ahead', behindBy: 0, base: h1, shas: many }),
      });
      run(f, h2);
      const out = f.body();
      expect(out).not.toContain('Subject');
      const read = parseTable(out.slice(out.indexOf('<!-- pr-changes:revisions -->')), REPO);
      expect(read.rows.map((r) => [r.rev, r.prev])).toEqual([
        [3, h2],
        [2, h1],
        [1, null],
      ]);
      // The first revision holds the goal's sentence; the others have no row yet.
      expect(read.rows.map((r) => r.rows.length)).toEqual([0, 0, 1]);
      expect(out.match(/\| {2}\| {2}\|/g)).toHaveLength(2);
    });

    it('adds the head of a plain push after the last force-push, and the head before this push', () => {
      const [h1, h2, h3] = [sha(1), sha(2), sha(3)];
      const f = fake({
        pull: { headSha: h3 },
        timeline: () => [forced(h1), forced(h2)],
        compare: () => ({ status: 'ahead', behindBy: 0, base: h2, shas: ['2'] }),
      });
      run(f, h2);
      expect(revs(f.body())).toEqual([
        [3, short(3)],
        [2, short(2)],
        [1, short(1)],
      ]);
      expect(f.body()).toContain(`compare/${h2}...${h3}`);
      const g = fake({
        pull: { headSha: h3 },
        timeline: () => [forced(h1), forced(h2)],
        compare: () => ({ status: 'ahead', behindBy: 0, base: h2, shas: ['2'] }),
      });
      run(g, sha(7));
      expect(revs(g.body()).map(([n]) => n)).toEqual([4, 3, 2, 1]);
    });

    it('starts from the head before the push when the timeline has no force-push', () => {
      const f = fake({
        timeline: () => [{ event: 'committed', sha: sha(5) }, { event: 'labeled' }],
      });
      expect(run(f)).toBe(true);
      expect(revs(f.body())).toEqual([
        [2, 'bbbbbbb'],
        [1, 'aaaaaaa'],
      ]);
      expect(f.body()).toContain('Opened');
      expect(f.logs).toEqual([]);
    });

    it('does the same, with a warning, when the timeline can’t be read', () => {
      const f = fake({
        timeline: () => {
          throw new Error('HTTP 500');
        },
      });
      expect(run(f)).toBe(true);
      expect(revs(f.body())).toEqual([
        [2, 'bbbbbbb'],
        [1, 'aaaaaaa'],
      ]);
      expect(f.logs[0]).toMatch(/timeline couldn't be read \(HTTP 500\)/);
    });

    it('lists at most the first head and the latest ones, with the true numbers, and says so', () => {
      const heads = Array.from({ length: 30 }, (_, i) => sha(i + 1));
      const f = fake({
        pull: { headSha: heads[29] },
        timeline: () => heads.map(forced),
        compare: () => ({ status: 'ahead', behindBy: 0, base: A, shas: [] }),
      });
      run(f, heads[28]);
      const numbers = revs(f.body()).map(([n]) => n);
      expect(numbers).toHaveLength(20);
      expect(numbers[0]).toBe(30);
      expect(numbers[19]).toBe(1);
      expect(numbers[18]).toBe(12);
      expect(f.body()).toContain('10 earlier heads are not listed');
      expect(f.body().match(/\(current\)/g)).toHaveLength(1);
    });

    it('says Opened for row 1 when the only force-push is the one being recorded', () => {
      const f = fake({ pull: { headSha: B }, timeline: () => [forced(B)] });
      run(f, A);
      expect(revs(f.body())).toEqual([
        [2, 'bbbbbbb'],
        [1, 'aaaaaaa'],
      ]);
      expect(f.body()).toContain('· Opened</summary>');
      expect(f.body()).not.toContain("the first head GitHub's record");
      // With an earlier force-push, row 1 is that one, and says its earlier heads were replaced.
      const g = fake({ pull: { headSha: B }, timeline: () => [forced(sha(1)), forced(B)] });
      run(g, sha(1));
      expect(g.body()).toContain("the first head GitHub's record of the PR names");
    });

    it('keeps what the author typed in the block, below the table', () => {
      const typed = 'My own note about these revisions.';
      const f = fake({
        body: BODY.replace(
          PAIR,
          `<!-- pr-changes:revisions -->\n${typed}\n<!-- /pr-changes:revisions -->`,
        ),
        pull: { headSha: sha(3) },
        timeline: () => [forced(sha(1)), forced(sha(2)), forced(sha(3))],
      });
      run(f, sha(2));
      const out = f.body();
      expect(out).toContain(typed);
      expect(out.indexOf(typed)).toBeGreaterThan(out.indexOf('</table>'));
      expect(f.logs.some((l) => /no row/.test(l))).toBe(true);
    });

    it('does not fail the table when GitHub fails on a range or the commits, saying so', () => {
      const [h1, h2, h3] = [sha(1), sha(2), sha(3)];
      const f = fake({
        pull: { headSha: h3 },
        timeline: () => [forced(h1), forced(h2), forced(h3)],
        commits: () => {
          throw new Error('HTTP 500');
        },
        compare: (prev) => {
          if (prev === h1) throw new Error('gh: API rate limit exceeded (HTTP 403)');
          return null;
        },
      });
      expect(run(f, h2)).toBe(true);
      const out = f.body();
      expect(out).toContain('(its commits could not be read just now)');
      expect(out).toContain('(commits replaced by a force-push)');
      expect(f.logs.filter((l) => /^::warning::/.test(l))).toHaveLength(2);
      expect(f.logs.join('\n')).toMatch(/commits couldn't be read \(HTTP 500\)/);
      expect(f.logs.join('\n')).toMatch(/revision 2 couldn't be compared/);
    });

    it('marks a row none of whose commits is on the PR any more', () => {
      const [h1, h2] = [sha(1), sha(2)];
      const f = fake({
        pull: { headSha: h2 },
        timeline: () => [forced(h1), forced(h2)],
        compare: () => ({ status: 'ahead', behindBy: 0, base: h1, shas: ['gone1', 'gone2'] }),
      });
      run(f, h1);
      expect(f.body()).toContain(`compare/${h1}...${h2}`);
      expect(f.body()).toContain('(none of its commits is on the PR now)');
    });

    it('keeps the “not listed” note on a later push, once, without calling it a stray line', () => {
      const heads = Array.from({ length: 30 }, (_, i) => sha(i + 1));
      const f = fake({
        pull: { headSha: heads[29] },
        timeline: () => heads.map(forced),
        compare: () => ({ status: 'ahead', behindBy: 0, base: A, shas: [] }),
      });
      run(f, heads[28]);
      f.writes.length = 0;
      const g = fake({
        body: f.body(),
        pull: { headSha: C },
        compare: () => ({ status: 'ahead', behindBy: 0, base: A, shas: ['1'] }),
      });
      expect(run(g, heads[29])).toBe(true);
      const out = g.body();
      expect(out.match(/earlier heads are not listed/g)).toHaveLength(1);
      expect(out).toContain('10 earlier heads are not listed');
      expect(revs(out)[0][0]).toBe(31);
      expect(g.logs.filter((l) => /no row/.test(l))).toEqual([]);
    });

    it('does not rebuild once the table has a row, and only reads GitHub, never waits', () => {
      const f = fake({ timeline: () => [forced(sha(1)), forced(sha(2))] });
      run(f);
      f.writes.length = 0;
      const g = fake({
        body: f.body(),
        pull: { headSha: C },
        timeline: () => {
          throw new Error('must not be read');
        },
      });
      expect(run(g, B)).toBe(true);
      expect(revs(g.body())[0][0]).toBe(5);
    });
  });

  it('is idempotent: the same head again changes nothing, whatever the event', () => {
    const f = fake();
    run(f);
    const after = f.body();
    expect(run(f, null)).toBe(false);
    expect(run(f, C)).toBe(false);
    expect(f.body()).toBe(after);
    expect(f.writes).toHaveLength(1);
  });

  it('adds a revision for a later head, keeping every row the author wrote', () => {
    const f = fake();
    run(f);
    f.writes.length = 0;
    const mine = '| I changed `x` \\| in plain words | Because **y** |';
    const edited = f
      .body()
      .replace('|  |  |\n\n</details>\n\n<details>', `${mine}\n\n</details>\n\n<details>`);
    expect(edited).toContain(mine);
    const g = fake({
      body: edited,
      pull: { headSha: C },
      compare: () => ({ status: 'ahead', behindBy: 0, base: B, shas: ['1'] }),
    });
    expect(run(g, B)).toBe(true);
    const out = g.body();
    expect(out).toContain(
      '<details open>\n<summary><b>👉 <a href="https://github.com/o/r/commit/cccc',
    );
    expect(out).toContain(`<details>\n<summary><a href="https://github.com/${REPO}/commit/${B}">`);
    expect(out.match(/<details open>/g)).toHaveLength(1);
    expect(out.match(/\(current\)/g)).toHaveLength(1);
    expect(out).toContain(`\n${mine}\n`);
    // The older revision keeps its row; the new one has the empty row to fill.
    const read = parseTable(out.slice(out.indexOf('<!-- pr-changes:revisions -->')), REPO);
    expect(read.rows.map((r) => r.rows)).toEqual([
      [],
      [mine],
      [expect.stringContaining('Make it work.')],
    ]);
  });

  it('does not repeat the heading an app’s template has before the markers', () => {
    const f = fake({ body: BODY.replace(PAIR, `## Revisions\n\n${PAIR}`) });
    run(f);
    expect(f.body().match(/## Revisions/g)).toHaveLength(1);
    expect(headingBefore('x\n\n## Revisions\n\n', 100)).toBe(true);
    expect(headingBefore('x\n\ny\n', 100)).toBe(false);
    // the apps' templates keep a comment between the heading and the pair
    expect(headingBefore('x\n\n## Revisions\n\n<!-- note\nmore -->\n\n', 100)).toBe(true);
  });

  it('shows a force-push as rewritten, with the commits that left', () => {
    const f = fake({ compare: () => ({ status: 'diverged', behindBy: 2, base: C, shas: ['1'] }) });
    run(f);
    expect(f.body()).toContain('(current) · ');
    expect(f.body()).toContain('rewritten from <code>aaaaaaa</code> (2 commits dropped)</summary>');
    expect(f.body()).toContain(`compare/${A}...${B}`);
  });

  it('shows a head GitHub can no longer compare to as gone, and an identical compare as nothing', () => {
    const f = fake({ compare: () => null });
    run(f);
    expect(f.body()).toContain('rewritten, the old head <code>aaaaaaa</code> is gone</summary>');
    // With the old head gone there is nothing to compare.
    expect(f.body()).not.toContain('compare/');
    const g = fake({ compare: () => ({ status: 'identical', behindBy: 0, base: A, shas: [] }) });
    expect(run(g)).toBe(false);
  });

  it.each([
    ['closed', { state: 'closed' }],
    ['Dependabot’s', { author: 'dependabot[bot]' }],
    ['a bot/ branch', { headRef: 'bot/refresh' }],
  ])('leaves a %s PR alone', (_name, pull) => {
    const f = fake({ pull });
    expect(run(f)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('leaves a description with no pair alone when no push moved the head, and warns about a torn one', () => {
    const none = fake({ body: BODY.replace(PAIR, '') });
    expect(run(none, null)).toBe(false);
    expect(none.logs).toEqual([]);
    const torn = fake({ body: BODY.replace('<!-- /pr-changes:revisions -->', '') });
    expect(run(torn)).toBe(false);
    expect(torn.logs[0]).toMatch(/torn or repeated/);
    const doubled = fake({ body: `${BODY}\n${PAIR}\n` });
    expect(run(doubled)).toBe(false);
  });

  it('does not count a pair inside a code fence: with no push it is left alone, with one the real pair is added', () => {
    const body = `${BODY.replace(PAIR, '')}\n\`\`\`\n${PAIR}\n\`\`\`\n`;
    expect(run(fake({ body }), null)).toBe(false);
    const f = fake({ body });
    expect(run(f)).toBe(true);
    // The example in the fence is as it was; the table is in a pair of its own.
    expect(f.body().split(PAIR)).toHaveLength(2);
    expect(f.body()).toContain('<b>👉 <a href="https://github.com/o/r/commit/bbbb');
  });

  it('warns about a line that is no row and keeps it below the table', () => {
    const f = fake({
      body: BODY.replace(
        PAIR,
        `<!-- pr-changes:revisions -->\nnotes (current)\n<!-- /pr-changes:revisions -->`,
      ),
    });
    run(f);
    expect(f.logs.some((l) => /no row/.test(l))).toBe(true);
    expect(f.body()).toContain('notes (current​)');
  });

  it('a fork’s PR gets a notice, not a failure', () => {
    const f = fake({ pull: { headRepo: 'fork/r' }, canWrite: false });
    expect(run(f)).toBe(false);
    expect(f.logs[0]).toMatch(/fork/);
  });

  it('a same-repo PR that needs a row without a token fails, naming BOT_PR_TOKEN', () => {
    const f = fake({ canWrite: false });
    expect(() => run(f)).toThrow(/BOT_PR_TOKEN/);
    expect(f.writes).toEqual([]);
  });

  it('but with nothing to write it needs no token', () => {
    const f = fake({ canWrite: false });
    expect(run(f, null)).toBe(false);
  });

  it('skips the write when the head moved on while it worked', () => {
    const f = fake({ heads: [B, C] });
    expect(run(f)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.logs.at(-1)).toMatch(/head moved on/);
  });

  it('works the row out again when the description changed, and gives up after 3 reads', () => {
    let reads = 0;
    const f = fake();
    const real = f.io.body;
    f.io.body = () => (reads++ >= 1 ? `${real()}\nedited meanwhile` : real());
    expect(run(f)).toBe(true);
    expect(f.writes[0]).toContain('edited meanwhile');

    let n = 0;
    const g = fake();
    const base = g.io.body;
    g.io.body = () => `${base()}${' '.repeat(n++)}`;
    expect(() => run(g)).toThrow(/gave up after 3 reads/);
  });

  it('writes nothing when the description would pass GitHub’s limit', () => {
    const f = fake({ body: `${BODY}${'x'.repeat(MAX_CHARS)}` });
    expect(run(f)).toBe(false);
    expect(f.logs.at(-1)).toMatch(/not written/);
  });

  it('survives hostile subjects and a hostile old table', () => {
    const f = fake({
      commits: () => [
        { sha: '2', subject: '| <!-- --> @x [a](b) `c` \n(current)', skipped: false },
      ],
      body: BODY.replace(
        PAIR,
        `<!-- pr-changes:revisions -->\n| 1 (current) | ${'x'.repeat(5000)} | | |\n<!-- /pr-changes:revisions -->`,
      ),
    });
    expect(run(f)).toBe(true);
    const block = f.body().slice(f.body().indexOf('<!-- pr-changes:revisions -->'));
    expect(block.match(/<!-- \/pr-changes:revisions -->/g)).toHaveLength(1);
    expect(block.match(/^<summary>.*\(current\)/gm)).toHaveLength(1);
    // The old table's line is no revision: it stays below the blocks, defused.
    expect(block).toContain(`1 (current${String.fromCharCode(0x200b)})`);
  });
});

describe('gitHubIo', () => {
  /** @param {Record<string, unknown>} answers */
  const api = (answers, calls = /** @type {unknown[][]} */ ([])) =>
    /** @type {import('../lib/comment.mjs').Api} */ (
      (method, route, body, options) => {
        calls.push([method, route, body, options]);
        const key = Object.keys(answers).find((k) => route.startsWith(k));
        if (key === undefined) throw new Error(`unexpected ${route}`);
        const answer = answers[key];
        if (answer instanceof Error) throw answer;
        return answer;
      }
    );

  it('reads the PR, the description and the commits; the token reaches the write alone', () => {
    /** @type {unknown[][]} */
    const calls = [];
    const io = gitHubIo({
      api: api(
        {
          [`repos/${REPO}/pulls/5/commits`]: [
            {
              sha: '1',
              commit: { message: 'One\n\nbody' },
              parents: [{}],
              author: { login: 'me' },
              committer: null,
            },
            {
              sha: '2',
              commit: { message: 'Merge' },
              parents: [{}, {}],
              author: null,
              committer: { login: 'me' },
            },
            {
              sha: '3',
              commit: { message: 'Bot' },
              parents: [{}],
              author: { login: 'x[bot]' },
              committer: null,
            },
          ],
          [`repos/${REPO}/pulls/5`]: {
            state: 'open',
            user: { login: 'me' },
            head: { ref: 'f', sha: A, repo: { full_name: REPO } },
          },
          [`repos/${REPO}/issues/5`]: { body: null },
        },
        calls,
      ),
      repo: REPO,
      number: 5,
      token: 'secret',
      log: () => {},
    });
    expect(io.pull()).toEqual({
      state: 'open',
      author: 'me',
      headRef: 'f',
      headSha: A,
      headRepo: REPO,
    });
    expect(io.body()).toBe('');
    expect(io.commits()).toEqual([
      { sha: '1', subject: 'One', skipped: false },
      { sha: '2', subject: 'Merge', skipped: true },
      { sha: '3', subject: 'Bot', skipped: true },
    ]);
    io.write('new');
    expect(io.canWrite).toBe(true);
    const withToken = calls.filter(
      (c) => /** @type {{ token?: string } | undefined} */ (c[3])?.token !== undefined,
    );
    expect(withToken).toEqual([
      ['PATCH', `repos/${REPO}/issues/5`, { body: 'new' }, { token: 'secret' }],
    ]);
  });

  it('reads a PR whose head repo was deleted, and has no write without a token', () => {
    const io = gitHubIo({
      api: api({
        [`repos/${REPO}/pulls/5`]: {
          state: 'open',
          user: null,
          head: { ref: 'f', sha: A, repo: null },
        },
      }),
      repo: REPO,
      number: 5,
      token: '',
      log: () => {},
    });
    expect(io.pull()).toMatchObject({ author: '', headRepo: '' });
    expect(io.canWrite).toBe(false);
  });

  it('compares: the status, the merge base and the commits; null for a 404 or 422; other errors throw', () => {
    const ok = gitHubIo({
      api: api({
        [`repos/${REPO}/compare/`]: {
          status: 'diverged',
          behind_by: 2,
          merge_base_commit: { sha: C },
          commits: [{ sha: '9' }],
        },
      }),
      repo: REPO,
      number: 5,
      token: 't',
      log: () => {},
    });
    expect(ok.compare(A, B)).toEqual({ status: 'diverged', behindBy: 2, base: C, shas: ['9'] });
    for (const status of [404, 422]) {
      const gone = gitHubIo({
        api: api({ [`repos/${REPO}/compare/`]: new Error(`gh: Not Found (HTTP ${status})`) }),
        repo: REPO,
        number: 5,
        token: 't',
        log: () => {},
      });
      expect(gone.compare(A, B)).toBeNull();
    }
    const broken = gitHubIo({
      api: api({ [`repos/${REPO}/compare/`]: new Error('HTTP 500') }),
      repo: REPO,
      number: 5,
      token: 't',
      log: () => {},
    });
    expect(() => broken.compare(A, B)).toThrow(/500/);
    const noBase = gitHubIo({
      api: api({ [`repos/${REPO}/compare/`]: { status: 'ahead', behind_by: 0, commits: [] } }),
      repo: REPO,
      number: 5,
      token: 't',
      log: () => {},
    });
    expect(noBase.compare(A, B)?.base).toBeNull();
  });

  it('compares with one request, which answers the status and the commits', () => {
    /** @type {unknown[][]} */
    const calls = [];
    const io = gitHubIo({
      api: api(
        {
          [`repos/${REPO}/compare/`]: {
            status: 'ahead',
            behind_by: 0,
            merge_base_commit: { sha: C },
            commits: [{ sha: '1' }, { sha: '2' }],
          },
        },
        calls,
      ),
      repo: REPO,
      number: 5,
      token: 't',
      log: () => {},
    });
    expect(io.compare(A, B)).toEqual({ status: 'ahead', behindBy: 0, base: C, shas: ['1', '2'] });
    expect(calls).toHaveLength(1);
  });

  it('says when a long timeline is cut short', () => {
    /** @type {string[]} */
    const logs = [];
    const full = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    const io = gitHubIo({
      api: api({ [`repos/${REPO}/issues/5/timeline`]: full }),
      repo: REPO,
      number: 5,
      token: 't',
      log: (l) => logs.push(l),
    });
    expect(io.timeline()).toHaveLength(3000);
    expect(logs[0]).toMatch(/timeline is longer than 3000 events/);
    const short = gitHubIo({
      api: api({ [`repos/${REPO}/issues/5/timeline`]: [{ event: 'labeled' }] }),
      repo: REPO,
      number: 5,
      token: 't',
      log: (l) => logs.push(l),
    });
    expect(short.timeline()).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it('reads more than 250 compared commits without trouble', () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ sha: `${i}` }));
    const io = gitHubIo({
      api: api({ [`repos/${REPO}/compare/`]: { status: 'ahead', behind_by: 0, commits: page } }),
      repo: REPO,
      number: 5,
      token: 't',
      log: () => {},
    });
    expect(io.compare(A, B)?.shas.length).toBeGreaterThanOrEqual(100);
  });
});

describe('main', () => {
  it('needs the repo and the number', () => {
    expect(() => main({ GITHUB_REPOSITORY: 'nope', NUMBER: '1' })).toThrow(
      /needs GITHUB_REPOSITORY/,
    );
    expect(() => main({ GITHUB_REPOSITORY: REPO, NUMBER: '0' })).toThrow(/needs GITHUB_REPOSITORY/);
  });

  it('takes the person’s token out of the environment before anything is called', () => {
    /** @type {Record<string, string | undefined>} */
    const env = { GITHUB_REPOSITORY: REPO, NUMBER: '5', UPLOAD_TOKEN: 'secret', BEFORE: A };
    // No gh here: the first call fails, after the token has gone.
    try {
      main(env);
    } catch {
      // gh is not installed or not logged in: the environment is what matters.
    }
    expect(env.UPLOAD_TOKEN).toBeUndefined();
  });
});
