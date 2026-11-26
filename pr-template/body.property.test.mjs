import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyProblems, holdsText, maskFences, revisionsPair } from './body.mjs';

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
].join('\n');

/** Text that adds no heading and can't open or close a comment, fence or span. */
const harmless = fc.string().map((s) => s.replace(/[#<>|]/g, ' '));
/** Anything a person or a tool might write, headings and fences included. */
const anything = fc.oneof(
  fc.string(),
  fc.constantFrom('## Goal', '```', '<!--', '-->', '### 1. x', '| a | b |', '\r\n', '~~~'),
);

describe('bodyProblems and changes the tool titles', () => {
  /**
   * @param {boolean[]} filled whether each change's pair has its title in it
   * @param {string} why the author's text under every pair
   */
  const changes = (filled, why) =>
    GOOD.replace(
      /### 1\. The change[\s\S]*?\n\n## Checklist/,
      // A function, so a `$&` in the author's text is text, not a pattern.
      () =>
        `${filled
          .map(
            (on, i) =>
              `<!-- pr-changes:change:${i + 1} -->\n${on ? `**${i + 1}. Do it** [\`abc1234\`](https://github.com/o/r/commit/abc1234)\n` : ''}<!-- /pr-changes:change:${i + 1} -->\n\n${why}`,
          )
          .join('\n\n')}\n\n## Checklist`,
    );

  /** Something written under a pair: never blank, and sometimes a replacement pattern. */
  const whyArb = fc.oneof(
    harmless.map((text) => `- ${text.trim() || 'because'}`),
    fc.constantFrom('- $&', '- $1', '- $`', "- $'", '- $$'),
  );

  it('names exactly the changes whose pair is still empty, whatever the author writes under them', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), whyArb, (filled, why) => {
        const found = bodyProblems(changes(filled, why));
        const empty = filled.flatMap((on, i) => (on ? [] : [i + 1]));
        expect(found).toHaveLength(empty.length);
        found.forEach((problem, i) => expect(problem).toContain(`under change ${empty[i]},`));
      }),
    );
  });
});

describe('bodyProblems', () => {
  it('never throws, and gives sentences, for any description', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.array(anything).map((a) => a.join('\n')),
          { nil: undefined },
        ),
        (body) => {
          for (const p of bodyProblems(body, 'abcdef0123')) expect(p.length).toBeGreaterThan(5);
        },
      ),
    );
  });

  it('never throws for any description and PR event, and a clean pair is never asked for twice', () => {
    const event = fc.record({ pushed: fc.boolean() }, { requiredKeys: [] });
    fc.assert(
      fc.property(
        fc.array(anything).map((a) => a.join('\n')),
        event,
        (body, ev) => {
          for (const p of bodyProblems(body, 'abcdef0123', ev)) expect(p.length).toBeGreaterThan(5);
          const pair = '<!-- pr-changes:revisions -->\n<!-- /pr-changes:revisions -->';
          const asked = (/** @type {string} */ b) =>
            bodyProblems(b, undefined, ev).filter((x) => /pr-changes:revisions/.test(x));
          // A description that shows the pair once, outside code, never gets a pair problem.
          if (!/pr-changes:revisions|```|~~~/.test(body)) {
            expect(asked(`${body}\n\n${pair}\n`).filter((x) => /exactly one|no `/.test(x))).toEqual(
              [],
            );
          }
        },
      ),
    );
  });

  it('keeps a good description good after more text at the end and inside the goal', () => {
    fc.assert(
      fc.property(harmless, harmless, (inGoal, after) => {
        const body = GOOD.replace('Make it work.', () => `Make it work. ${inGoal}`) + after;
        expect(bodyProblems(body)).toEqual([]);
      }),
    );
  });

  it('gives the same verdict with LF or CRLF', () => {
    fc.assert(
      fc.property(
        fc.array(anything).map((a) => a.join('\n')),
        (body) => {
          expect(bodyProblems(body.replace(/\n/g, '\r\n'))).toEqual(
            bodyProblems(body.replace(/\r/g, '')),
          );
        },
      ),
    );
  });

  it('never lets a fenced or commented heading change the verdict', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('## Checklist', '## Goal', '## Revisions', '### 1. x'),
        (heading) => {
          expect(bodyProblems(`${GOOD}\n\`\`\`\n${heading}\n\`\`\`\n`)).toEqual([]);
          expect(bodyProblems(`${GOOD}\n<!--\n${heading}\n-->\n`)).toEqual([]);
        },
      ),
    );
  });

  it('keeps a good description good when a valid GIF block is put under its change', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), harmless, (name, text) => {
        const block = `<!-- pr-gif:${name} -->\n${text.replace(/\]\(\./g, ' ')}\n<!-- /pr-gif:${name} -->`;
        const body = GOOD.replace('Why.', `Why.\n\n${block}`);
        // What the tool wrote may say anything but a stale phrase or a local path.
        fc.pre(!/^\*\*Not updated for/.test(text.trim()));
        expect(bodyProblems(body)).toEqual([]);
      }),
    );
  });

  it('always flags a GIF block put at the very end, whatever it says', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), harmless, (name, text) => {
        const body = `${GOOD}\n<!-- pr-gif:${name} -->\n${text}\n<!-- /pr-gif:${name} -->\n`;
        expect(bodyProblems(body).join('\n')).toContain(`put the GIF block \`pr-gif:${name}\``);
      }),
    );
  });
});

describe('revisionsPair and maskFences', () => {
  const text = fc
    .array(
      fc.oneof(
        fc.string(),
        fc.constantFrom(
          '\\',
          '\\\\',
          '`',
          '```',
          '~~~',
          '\n',
          '\r\n',
          ' ',
          '<!-- pr-changes:revisions -->',
          '<!-- /pr-changes:revisions -->',
        ),
      ),
      { maxLength: 30 },
    )
    .map((parts) => parts.join(''));

  it('never throws, keeps every offset, and finds a pair exactly where its markers are', () => {
    fc.assert(
      fc.property(text, (body) => {
        expect(maskFences(body)).toHaveLength(body.length);
        const { starts, ends, at } = revisionsPair(body);
        for (const i of starts)
          expect(body.startsWith('<!-- pr-changes:revisions -->', i)).toBe(true);
        for (const i of ends)
          expect(body.startsWith('<!-- /pr-changes:revisions -->', i)).toBe(true);
        if (at) {
          expect(starts).toHaveLength(1);
          expect(ends).toHaveLength(1);
          expect(body.slice(at.from, at.to).startsWith('<!-- pr-changes:revisions -->')).toBe(true);
          expect(body.slice(at.from, at.to).endsWith('<!-- /pr-changes:revisions -->')).toBe(true);
        }
      }),
    );
  });
});

// The check's reading of the shapes earlier PRs hold must not change: `mainCurrent` is the matcher
// main's pr-template/body.mjs had before the details blocks (copied, as the oracle), and the check
// must name the same head for every old-shape description, wherever an author's own tags and text sit.
const ORACLE_LINK =
  '\\[`([0-9a-f]{7})`\\]\\(https://github\\.com/[\\w.-]+/[\\w.-]+/commit/\\1[0-9a-f]{33}\\)';
const ORACLE_BOLD = new RegExp(`^\\|[ \\t]*\\*\\*(?:👉 )?${ORACLE_LINK}\\*\\* \\(current\\)`, 'm');
const ORACLE_PLAIN = new RegExp(`^\\|[ \\t]*${ORACLE_LINK} \\(current\\)`, 'm');
const ORACLE_OLD = /^\|[^|\n[]*\(current\)[^|\n[]*\|([^|\n]*)\|/m;
/** @param {string} text */
function mainCurrent(text) {
  const bold = ORACLE_BOLD.exec(text);
  const plain = ORACLE_PLAIN.exec(text);
  const row = bold && (!plain || bold.index <= plain.index) ? bold : plain;
  const old = ORACLE_OLD.exec(text);
  if (row && (!old || row.index <= old.index)) return row[1];
  return old ? old[1] : null;
}

describe('the current revision of an old-shape description', () => {
  const hex7 = fc.stringMatching(/^[0-9a-f]{7}$/);
  /** @param {string} s */
  const link = (s) => `[\`${s}\`](https://github.com/o/r/commit/${s.padEnd(40, '0')})`;
  const head = hex7.chain((s) =>
    fc.constantFrom(
      link(s),
      `[${s}](https://github.com/o/r/commit/${s.padEnd(40, '0')})`,
      `**${link(s)}**`,
      `**👉 ${link(s)}**`,
      `👉 ${link(s)}`,
      `\`${s.padEnd(40, '0')}\``,
      s,
      'not a link',
      '',
    ),
  );
  const rev = fc.constantFrom(
    '1',
    '2',
    '2 (current)',
    '3 (current)',
    '(current)',
    'fix (current) it',
  );
  const row = fc.oneof(
    fc.tuple(rev, head).map(([r, h]) => `| ${r} | ${h} | w | y |`),
    fc.tuple(rev, head).map(([r, h]) => `| ${r} | ${h} |`),
    head.chain((h) =>
      fc.constantFrom(
        `| ${h} (current)<br>w | y |`,
        `| **👉 ${h}** (current)<br>w | y |`,
        `| ${h} | y |`,
      ),
    ),
    fc.constantFrom('| a | b |', '| --- | --- |', '| What changed | Why |', 'text', ''),
  );
  // An author's own tags, which the check must not read through.
  const noise = fc.constantFrom(
    '<details>',
    '<details open>',
    '<details>\n<summary>notes</summary>',
    '</details>',
    '<summary>x</summary>',
    '<tr>',
    '<td>',
  );
  const line = fc.oneof({ weight: 4, arbitrary: row }, { weight: 1, arbitrary: noise });

  it('names the same head as main did for every old-shape table, whatever tags the author typed around it', () => {
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), hex7, (lines, h) => {
        const table = lines.join('\n');
        const body = `${GOOD.slice(0, GOOD.indexOf('## Revisions'))}<!-- pr-changes:revisions -->\n## Revisions\n\n${table}\n<!-- /pr-changes:revisions -->\n`;
        const named = mainCurrent(table);
        const stale = named !== null && !named.toLowerCase().includes(h.toLowerCase());
        const flagged = bodyProblems(body, h.padEnd(40, '0')).some((p) =>
          /names another commit/.test(p),
        );
        expect(flagged).toBe(stale);
      }),
      { numRuns: Number(process.env.REVISIONS_FUZZ_RUNS ?? 1000) },
    );
  });
});

// The current revision's rows (ci#140). Each generated cell carries its label, filled or empty, and
// the labels are the oracle: filled cells are built with a letter or a digit in what a reader sees,
// empty ones only from blanks, dashes, tags, entities, comments, `\|`, an emoji and U+2028. The
// test never repeats the check's own predicate. fast-check prints the seed and the smallest
// counterexample of a failure.
describe("the current revision's rows", () => {
  const HEAD = 'abcdef0'.padEnd(40, '1');
  const OLD = '1111111'.padEnd(40, '0');
  const empties = fc.constantFrom(
    '',
    ' ',
    '—',
    '-',
    '<br>',
    '<b></b>',
    '&nbsp;',
    '&#65;',
    '<!-- why -->',
    '\\|',
    '🎉',
    ' ',
    '<img src="x.png">',
    '<https://x.example>',
  );
  const words = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
    fc.constantFrom('修正', 'é', '`x`', '<code>x</code>', 'n/a', 'a \\| b', '7', 'Ωmega'),
  );
  const noise = fc.array(empties, { maxLength: 3 }).map((parts) => parts.join(' '));
  /** @type {fc.Arbitrary<{ text: string, filled: boolean }>} */
  const cell = fc.oneof(
    fc.tuple(noise, words, noise).map(([a, w, b]) => ({ text: `${a} ${w} ${b}`, filled: true })),
    noise.map((text) => ({ text, filled: false })),
  );
  const row = fc.tuple(cell, cell);
  const rows = fc.array(fc.tuple(row, fc.boolean()), { maxLength: 6 });
  const render = (/** @type {[[{ text: string }, { text: string }], boolean][]} */ list) =>
    list.flatMap(([[what, why], gap]) => [...(gap ? [''] : []), `| ${what.text} | ${why.text} |`]);
  const html = (/** @type {string} */ sha) =>
    `<a href="https://github.com/o/r/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>`;
  const body = (/** @type {string[]} */ lines, crlf = false) => {
    const text = `${GOOD.slice(0, GOOD.indexOf('## Revisions'))}<!-- pr-changes:revisions -->\n## Revisions\n\n<details open>\n<summary><b>👉 ${html(HEAD)}</b> (current)</summary>\n\n| What changed | Why |\n| --- | --- |\n${lines.join('\n')}\n\n</details>\n\n<details>\n<summary>${html(OLD)} · Opened</summary>\n\n|  |  |\n\n</details>\n<!-- /pr-changes:revisions -->\n`;
    return crlf ? text.replace(/\n/g, '\r\n') : text;
  };
  const passes = (/** @type {string} */ text) =>
    !bodyProblems(text, HEAD).some((p) => /Revisions/.test(p));
  const RUN = { numRuns: Number(process.env.REVISIONS_FUZZ_RUNS ?? 1000) };

  it('reads a cell as holding text exactly when it was built with some', () => {
    fc.assert(
      fc.property(cell, ({ text, filled }) => {
        expect(holdsText(text)).toBe(filled);
      }),
      RUN,
    );
  });

  it('passes exactly when some row is filled in both cells and none in only one, for LF and CRLF alike', () => {
    fc.assert(
      fc.property(rows, (list) => {
        const labels = list.map(([[what, why]]) => [what.filled, why.filled]);
        const wanted =
          labels.some(([what, why]) => what && why) && !labels.some(([what, why]) => what !== why);
        const lines = render(list);
        expect(passes(body(lines))).toBe(wanted);
        expect(bodyProblems(body(lines, true), HEAD)).toEqual(bodyProblems(body(lines), HEAD));
      }),
      RUN,
    );
  });

  it('keeps a passing table passing when a filled row is added, and fails the placeholder alone', () => {
    fc.assert(
      fc.property(rows, fc.tuple(words, words), fc.nat(6), (list, [what, why], at) => {
        const lines = render(list);
        expect(passes(body(['|  |  |']))).toBe(false);
        if (!passes(body(lines))) return;
        const more = [...lines];
        more.splice(Math.min(at, more.length), 0, `| ${what} | ${why} |`);
        expect(passes(body(more))).toBe(true);
      }),
      RUN,
    );
  });

  it('never throws, whatever is typed in the rows', () => {
    fc.assert(
      fc.property(fc.array(anything, { maxLength: 8 }), (lines) => {
        const text = body(lines.map((l) => `|${l}|`));
        expect(() => bodyProblems(text, HEAD, { pushed: true })).not.toThrow();
      }),
      RUN,
    );
  });
});
