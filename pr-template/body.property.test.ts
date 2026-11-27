import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyProblems, holdsText, maskFences, renderedLines, revisionsPair } from './body.ts';

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
   * @param filled whether each change's pair has its title in it
   * @param why the author's text under every pair
   */
  const changes = (filled: boolean[], why: string) =>
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
          const asked = (b: string) =>
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
function mainCurrent(text: string) {
  const bold = ORACLE_BOLD.exec(text);
  const plain = ORACLE_PLAIN.exec(text);
  const row = bold && (!plain || bold.index <= plain.index) ? bold : plain;
  const old = ORACLE_OLD.exec(text);
  if (row && (!old || row.index <= old.index)) return row[1];
  return old ? old[1] : null;
}

describe('the current revision of an old-shape description', () => {
  const hex7 = fc.stringMatching(/^[0-9a-f]{7}$/);
  const link = (s: string) => `[\`${s}\`](https://github.com/o/r/commit/${s.padEnd(40, '0')})`;
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
  const cell: fc.Arbitrary<{ text: string; filled: boolean }> = fc.oneof(
    fc.tuple(noise, words, noise).map(([a, w, b]) => ({ text: `${a} ${w} ${b}`, filled: true })),
    noise.map((text) => ({ text, filled: false })),
  );
  const row = fc.tuple(cell, cell);
  const rows = fc.array(fc.tuple(row, fc.boolean()), { maxLength: 6 });
  const render = (list: [[{ text: string }, { text: string }], boolean][]) =>
    list.flatMap(([[what, why], gap]) => [...(gap ? [''] : []), `| ${what.text} | ${why.text} |`]);
  const html = (sha: string) =>
    `<a href="https://github.com/o/r/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>`;
  const body = (lines: string[], crlf = false) => {
    const text = `${GOOD.slice(0, GOOD.indexOf('## Revisions'))}<!-- pr-changes:revisions -->\n## Revisions\n\n<details open>\n<summary><b>👉 ${html(HEAD)}</b> (current)</summary>\n\n| What changed | Why |\n| --- | --- |\n${lines.join('\n')}\n\n</details>\n\n<details>\n<summary>${html(OLD)} · Opened</summary>\n\n|  |  |\n\n</details>\n<!-- /pr-changes:revisions -->\n`;
    return crlf ? text.replace(/\n/g, '\r\n') : text;
  };
  const passes = (text: string) => !bodyProblems(text, HEAD).some((p) => /Revisions/.test(p));
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

describe('renderedLines against its old scans (property)', () => {
  // renderedLines as it was before ci#157, kept as the reference: each tool start marker scanned
  // every line after it for its end, and each unclosed inline `<!--` searched the rest of its
  // paragraph for a `-->`; both quadratic, so the bodies here stay short.
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const TOOL_START = /^ *<!-- ([a-z][a-z0-9-]*:[^\s<>]+) -->\s*$/;
  const findRun = (text: string, from: number, n: number) => {
    for (let at = text.indexOf('`', from); at !== -1; at = text.indexOf('`', at)) {
      let len = 0;
      while (text[at + len] === '`') len++;
      if (len === n) return at;
      at += len;
    }
    return -1;
  };
  const withoutSpans = (paragraph: string[]) => {
    const text = paragraph.join('\n');
    let out = '';
    for (let at = 0; at < text.length;) {
      if (text[at] === '`') {
        let n = 0;
        while (text[at + n] === '`') n++;
        const close = findRun(text, at + n, n);
        if (close === -1) {
          out += text.slice(at, at + n);
          at += n;
        } else {
          out += text.slice(at, close + n).replace(/[^\n]/g, '');
          at = close + n;
        }
      } else if (text.startsWith('<!--', at)) {
        const end = text.indexOf('-->', at + 4);
        if (end === -1) {
          out += '<';
          at += 1;
        } else {
          out += text.slice(at, end + 3).replace(/[^\n]/g, '');
          at = end + 3;
        }
      } else {
        out += text[at++];
      }
    }
    return out.split('\n');
  };
  const inline = (lines: string[]) => {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      const marker = i < lines.length && lines[i].startsWith('@@tool:');
      if (i < lines.length && lines[i].trim() !== '' && !marker) continue;
      const paragraph = lines.slice(start, i);
      out.push(...(paragraph.length ? withoutSpans(paragraph) : []));
      if (i < lines.length) out.push(marker ? lines[i] : '');
      start = i + 1;
    }
    return out;
  };
  const reference = (
    body: string,
    {
      keepTools = false,
      onBlock,
    }: { keepTools?: boolean; onBlock?: (key: string, inner: string[], at: number) => void } = {},
  ) => {
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        const [mark] = fence[1];
        const closing = new RegExp(`^ {0,3}\\${mark}{${fence[1].length},} *$`);
        i++;
        while (i < lines.length && !closing.test(lines[i])) i++;
        kept.push('');
        continue;
      }
      const tool = TOOL_START.exec(line);
      if (tool) {
        const end = `<!-- /${tool[1]} -->`;
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== end) j++;
        if (j < lines.length) {
          onBlock?.(tool[1], lines.slice(i + 1, j), kept.length);
          i = j;
          kept.push(keepTools ? `@@tool:${tool[1]}@@` : '');
          continue;
        }
      }
      if (/^ {0,3}<!--/.test(line)) {
        let j = i;
        while (
          j < lines.length &&
          !lines[j].includes('-->', j === i ? line.indexOf('<!--') + 4 : 0)
        )
          j++;
        const rest =
          j < lines.length
            ? lines[j].slice(lines[j].indexOf('-->', j === i ? line.indexOf('<!--') + 4 : 0) + 3)
            : '';
        i = j;
        kept.push(rest);
        continue;
      }
      kept.push(keepTools ? line.replaceAll('@@', '@ @') : line);
    }
    return inline(kept);
  };
  // Tool markers closed, unclosed, closed only inside a fence, repeated and spaced; fences,
  // comments and spans that open and close around them.
  const line = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.constantFrom(
        '<!-- a:b -->',
        '<!-- a:c -->',
        '  <!-- a:b -->  ',
        '<!-- pr-gif:x -->',
        '<!-- /a:b -->',
        '  <!-- /a:b -->\t',
        '<!-- /a:c -->',
        '<!-- /pr-gif:x -->',
        '<!-- / a:b -->',
        '<!-- /A:b -->',
      ),
    },
    {
      weight: 4,
      arbitrary: fc.constantFrom(
        '```',
        '~~~',
        '````',
        '   ```',
        '<!--',
        'a <!-- b',
        '-->',
        'a --> b',
        '<!-- c -->',
        '`',
        '``',
        'x ` y',
        '@@',
        '',
        ' ',
      ),
    },
    { weight: 2, arbitrary: fc.string({ maxLength: 8 }) },
  );
  const body = fc
    .tuple(fc.array(line, { maxLength: 30 }), fc.constantFrom('\n', '\r\n', '\r'))
    .map(([lines, eol]) => lines.join(eol));

  it('reads every body as the old scans did, its tool blocks heard the same, with keepTools or not', () => {
    fc.assert(
      fc.property(body, fc.boolean(), (text, keepTools) => {
        const heard: unknown[][] = [];
        const expected: unknown[][] = [];
        const got = renderedLines(text, { keepTools, onBlock: (...a) => heard.push(a) });
        const want = reference(text, { keepTools, onBlock: (...a) => expected.push(a) });
        expect(got).toEqual(want);
        expect(heard).toEqual(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
