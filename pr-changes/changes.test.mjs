import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  anchor,
  BUDGET,
  chooseLevel,
  escape,
  fill,
  placed,
  putBlock,
  renderChange,
} from './changes.mjs';

const WHERE = { repo: 'jbhirsh/app', number: 7, n: 1 };
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

/**
 * @param {string} subject
 * @param {[string, number, number][]} [files]
 */
const commit = (subject, files = [['src/a.ts', 3, 1]]) => ({
  sha: SHA,
  subject,
  files: files.map(([path, added, removed]) => ({ path, added, removed })),
});

const slot = (/** @type {number} */ n) =>
  `<!-- pr-changes:change:${n} -->\n<!-- /pr-changes:change:${n} -->`;

describe('anchor', () => {
  it("is GitHub's diff anchor: the sha256 of the path", () => {
    expect(anchor('a/b.ts')).toBe(`#diff-${createHash('sha256').update('a/b.ts').digest('hex')}`);
  });
});

describe('escape', () => {
  it('stops text making a tag, a link, emphasis, a cell or a mention', () => {
    expect(escape('<b>[x](y) *z* a|b @me')).toBe('&lt;b&gt;\\[x\\](y) \\*z\\* a\\|b @​me');
  });
  it('stops math, an issue reference and a link', () => {
    const out = escape('Costs $5 and $6, fixes #12, see https://x.y');
    expect(out).toContain('\\$5');
    expect(out).toContain('#\u200b12');
    expect(out).toContain(':\u200b//');
  });
  it('keeps one line', () => {
    expect(escape('a\r\nb')).toBe('a b');
  });
});

describe('renderChange', () => {
  it('says the commit, the totals in colour, and each file linked to its diff with its own', () => {
    const out = renderChange(
      commit('Add a', [
        ['src/a.ts', 3, 1],
        ['b.md', 5, 0],
      ]),
      WHERE,
    );
    expect(out.split('\n')[0]).toBe(
      `**1. Add a** [\`abcdef0\`](https://github.com/jbhirsh/app/commit/${SHA})`,
    );
    expect(out).toContain('<details><summary>2 files changed +8 −1</summary>');
    expect(out).toContain(
      `- [\`src/a.ts\`](https://github.com/jbhirsh/app/pull/7/files${anchor('src/a.ts')}) +3 −1`,
    );
    expect(out).not.toContain('```');
    expect(out.endsWith('</details>')).toBe(true);
  });
  it('says "1 file" for one', () => {
    expect(renderChange(commit('x'), WHERE)).toContain('1 file changed');
  });
  it('leaves the file lists out at the totals level, keeping the totals as a plain line', () => {
    const out = renderChange(commit('x'), { ...WHERE, level: 'totals' });
    expect(out.endsWith('\n\n1 file changed +3 −1')).toBe(true);
    expect(out).not.toContain('<details>');
    expect(out).not.toContain('src/a.ts');
  });
  it('numbers the title from the change, bolds the subject and puts the commit link last', () => {
    const [line] = renderChange(commit('Fix *this*'), { ...WHERE, n: 12 }).split('\n');
    expect(line).toBe(
      `**12. Fix \\*this\\*** [\`abcdef0\`](https://github.com/jbhirsh/app/commit/${SHA})`,
    );
  });
  it('keeps the bold closed round a subject with trailing space, a CR or nothing', () => {
    const first = (/** @type {string} */ subject) =>
      renderChange(commit(subject), WHERE).split('\n')[0];
    const link = `[\`abcdef0\`](https://github.com/jbhirsh/app/commit/${SHA})`;
    expect(first('Fix x ')).toBe(`**1. Fix x** ${link}`);
    expect(first('Fix x\r')).toBe(`**1. Fix x** ${link}`);
    expect(first('  Fix x \t')).toBe(`**1. Fix x** ${link}`);
    expect(first('')).toBe(`**1. (no subject)** ${link}`);
    expect(first(' \r\n ')).toBe(`**1. (no subject)** ${link}`);
    expect(first('\u200b')).toBe(`**1. (no subject)** ${link}`);
    expect(first('Fix x \u200b')).toBe(`**1. Fix x** ${link}`);
  });
  it("writes a subject's replacement patterns as they are, escaped, never as a pattern", () => {
    const subject = "Fix $& and $1 and $` and $' and $$";
    const slot1 = '<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->';
    const body = `## Changes\n\n$& $1 $\` $' $$\n\n${slot1}\n\n- why $& $1\n`;
    const out = fill(body, [commit(subject)], WHERE).body;
    expect(out).toContain("**1. Fix \\$&amp; and \\$1 and \\$\\` and \\$' and \\$\\$** [");
    expect(out.startsWith("## Changes\n\n$& $1 $` $' $$\n\n<!-- pr-changes:change:1 -->\n")).toBe(
      true,
    );
    expect(out.endsWith('\n\n- why $& $1\n')).toBe(true);
  });
  it('leaves a bidirectional override out of a subject, and stops a `www.` link', () => {
    expect(escape('a\u202eb\u2066c')).toBe('abc');
    expect(escape('see www.example.com')).toBe('see www\u200b.example.com');
    expect(escape('WWW.example.com')).toBe('WWW\u200b.example.com');
  });
  it('is only the commit line for a commit with no files', () => {
    expect(renderChange(commit('empty', []), WHERE)).not.toContain('<details>');
  });
  it("can't write a marker through a path, so a filled slot stays clean", () => {
    const out = renderChange(commit('x', [['<!-- describe:x -->', 1, 0]]), WHERE);
    const body = `<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->`;
    const filled = fill(body, [commit('x', [['<!-- describe:x -->', 1, 0]])], WHERE).body;
    expect(out).not.toContain('<!--');
    expect(placed(filled)).toEqual([1]);
  });
  it('fences a path holding backticks', () => {
    expect(renderChange(commit('x', [['a`b', 1, 0]]), WHERE)).toContain('[``a`b``]');
  });
});

describe('placed', () => {
  it('lists the clean slots in order', () => {
    expect(placed(`${slot(2)}\n${slot(1)}`)).toEqual([1, 2]);
  });
  it('ignores a slot with a marker inside, a doubled one and a torn one', () => {
    const inside =
      '<!-- pr-changes:change:1 -->\n<!-- describe:x -->\n<!-- /pr-changes:change:1 -->';
    expect(placed(inside)).toEqual([]);
    expect(placed(`${slot(1)}\n${slot(1)}`)).toEqual([]);
    expect(placed('<!-- pr-changes:change:1 -->\nno end')).toEqual([]);
  });
  it('ignores other keys', () => {
    expect(placed('<!-- pr-changes:revisions -->\n<!-- /pr-changes:revisions -->')).toEqual([]);
  });
});

describe('fill', () => {
  const body = `## Changes\n\n### 1. A\n\n${slot(1)}\n\n### 2. B\n\n${slot(2)}\n\nTail`;
  const commits = [commit('One'), commit('Two')];

  it('fills slot n with commit n and leaves the rest', () => {
    const { body: out, problem } = fill(body, commits, WHERE);
    expect(problem).toBeNull();
    expect(out.indexOf('One')).toBeLessThan(out.indexOf('### 2. B'));
    expect(out.indexOf('Two')).toBeGreaterThan(out.indexOf('### 2. B'));
    expect(out.startsWith('## Changes\n\n### 1. A\n\n<!-- pr-changes:change:1 -->\n')).toBe(true);
    expect(out.endsWith('\n\nTail')).toBe(true);
  });
  it('gives the same description on a rerun', () => {
    const once = fill(body, commits, WHERE).body;
    expect(fill(once, commits, WHERE).body).toBe(once);
  });
  it('numbers each title from its own marker, with no heading needed', () => {
    const bare = `## Changes\n\n${slot(1)}\n\n- why one\n\n${slot(2)}\n\n- why two\n`;
    const out = fill(bare, commits, WHERE).body;
    expect(out).toContain('**1. One** [');
    expect(out).toContain('**2. Two** [');
    expect(out).toContain('\n\n- why one\n\n');
    expect(out.endsWith('\n\n- why two\n')).toBe(true);
    expect(out).not.toContain('###');
  });
  it('rewrites a block filled the old way, keeping its heading and what is outside the markers', () => {
    const old = `## Changes\n\n### 1. A\n\nWhy.\n\n<!-- pr-changes:change:1 -->\n[\`abcdef0\`](https://github.com/jbhirsh/app/commit/${SHA}) One\n\n<details><summary>1 file changed +1 −0</summary>\n\n- [\`x\`](https://github.com/jbhirsh/app/pull/7/files#diff-x) +1 −0\n\n</details>\n<!-- /pr-changes:change:1 -->\n\nTail`;
    const out = fill(old, [commit('One')], WHERE).body;
    expect(out).toContain('**1. One** [`abcdef0`]');
    expect(out).not.toContain(`[\`abcdef0\`](https://github.com/jbhirsh/app/commit/${SHA}) One`);
    expect(out.startsWith('## Changes\n\n### 1. A\n\nWhy.\n\n<!-- pr-changes:change:1 -->\n')).toBe(
      true,
    );
    expect(out.endsWith('\n\nTail')).toBe(true);
  });
  it('says so in every slot, and leaves no stale commit, when slots and commits differ', () => {
    const filled = fill(body, commits, WHERE).body;
    const out = fill(filled, [commit('One')], WHERE);
    expect(out.problem).toMatch(/slots 1, 2 for 1 commit/);
    expect(out.body.match(/⚠️ \*\*pr-changes:\*\*/g)).toHaveLength(2);
    expect(out.body).not.toContain('One');
    expect(fill(out.body, [commit('One')], WHERE).body).toBe(out.body);
  });
  it('says so when the slots are not numbered from 1', () => {
    expect(fill(`${slot(2)}\n${slot(3)}`, commits, WHERE).problem).not.toBeNull();
  });
  it('does nothing for a description with no slot, and never appends one', () => {
    expect(fill('No slots.', commits, WHERE)).toEqual({ body: 'No slots.', problem: null });
  });
  it("ignores a slot in a code fence or inside another tool's block", () => {
    expect(placed(`\`\`\`\n${slot(1)}\n\`\`\``)).toEqual([]);
    expect(placed(`~~~\n${slot(1)}\n`)).toEqual([]);
    expect(placed(`<!-- describe:x -->\n${slot(1)}\n<!-- /describe:x -->`)).toEqual([]);
    expect(placed(`\`\`\`\nx\n\`\`\`\n${slot(1)}`)).toEqual([1]);
  });
  it('drops the file lists, keeping the totals, over the budget', () => {
    const big = commit(
      'Big',
      Array.from({ length: 800 }, (_, i) => [`dir/${'p'.repeat(60)}${i}.ts`, 1, 1]),
    );
    const out = fill(`${slot(1)}\n${'x'.repeat(BUDGET - 3000)}`, [big], WHERE).body;
    expect(out).toContain('800 files changed');
    expect(out).not.toContain('dir/ppp');
  });
  it('writes nothing, and says so, when even the totals do not fit', () => {
    const many = Array.from({ length: 40 }, (_, i) => commit(`Change ${i}`));
    const text = Array.from({ length: 40 }, (_, i) => slot(i + 1)).join('\n');
    const input = `${text}\n${'x'.repeat(BUDGET - 4000)}`;
    const out = fill(input, many, WHERE);
    expect(out.body).toBe(input);
    expect(out.problem).toMatch(/too long to write/);
  });
});

describe('chooseLevel', () => {
  const stand = (/** @type {number} */ a, /** @type {number} */ r) =>
    `<pair ${a} ${r} ${'x'.repeat(240)}>`;
  const many = (/** @type {number} */ n) =>
    commit(
      'Big',
      Array.from({ length: n }, (_, i) => [`dir/file${i}.ts`, i + 1, 1]),
    );
  const body = (/** @type {number} */ extra) => `${slot(1)}\n${'x'.repeat(extra)}`;

  it('is full when everything fits', () => {
    expect(chooseLevel(body(100), [many(3)], WHERE, { pair: stand })).toBe('full');
  });

  /**
   * How much text to put in the description so that `level` just fits.
   *
   * @param {import('./changes.mjs').Level} level
   */
  const padFor = (level) =>
    BUDGET - renderChange(many(150), { ...WHERE, level, pair: stand }).length - slot(1).length - 2;

  it('steps down to titles, then totals, then null, as the description grows', () => {
    const big = [many(150)];
    expect(chooseLevel(body(padFor('full')), big, WHERE, { pair: stand })).toBe('full');
    expect(chooseLevel(body(padFor('titles')), big, WHERE, { pair: stand })).toBe('titles');
    expect(chooseLevel(body(padFor('totals')), big, WHERE, { pair: stand })).toBe('totals');
    expect(chooseLevel(body(padFor('totals') + 200), big, WHERE, { pair: stand })).toBeNull();
  });

  it('counts what the run adds besides (the index) against every level but totals', () => {
    const big = [many(150)];
    const pad = body(padFor('full'));
    expect(chooseLevel(pad, big, WHERE, { pair: stand })).toBe('full');
    expect(chooseLevel(pad, big, WHERE, { pair: stand, reserve: 500 })).toBe('titles');
    expect(chooseLevel(body(padFor('totals')), big, WHERE, { pair: stand, reserve: 50_000 })).toBe(
      'totals',
    );
  });

  it('is null when the slots do not match the commits', () => {
    expect(chooseLevel(body(10), [many(1), many(1)], WHERE, { pair: stand })).toBeNull();
  });
});

describe('fill at a level', () => {
  it('writes at the level it is told, with the pair it is given', () => {
    const pair = (/** @type {number} */ a, /** @type {number} */ r) => `<p ${a} ${r}>`;
    const out = fill(slot(1), [commit('x')], WHERE, { level: 'titles', pair });
    expect(out.problem).toBeNull();
    expect(out.body).toContain('changed <p 3 1></summary>');
    expect(out.body).toContain(') +3 −1');
  });

  it('says it is too long, and writes nothing, when no level fits', () => {
    const out = fill(`${slot(1)}\n${'x'.repeat(BUDGET)}`, [commit('x')], WHERE);
    expect(out.problem).toMatch(/too long to write/);
    expect(out.body).toBe(`${slot(1)}\n${'x'.repeat(BUDGET)}`);
  });
});

describe('a block written into a description', () => {
  // Text from outside goes in by slicing, never as a replacement string.
  it('holds `$&`, `$1`, `$$` and the like as they are, in the block and round it', () => {
    const text = "$& $1 $` $' $$";
    const body = `before ${text}\n\n<!-- pr-changes:x -->\nold\n<!-- /pr-changes:x -->\n\nafter ${text}\n`;
    const out = putBlock(body, 'x', text);
    expect(out).toBe(
      `before ${text}\n\n<!-- pr-changes:x -->\n${text}\n<!-- /pr-changes:x -->\n\nafter ${text}\n`,
    );
    expect(putBlock(`plain ${text}`, 'y', text)).toContain(`<!-- pr-changes:y -->\n${text}\n`);
  });
});
