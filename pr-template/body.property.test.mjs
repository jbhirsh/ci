import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyProblems, maskFences, revisionsPair } from './body.mjs';

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
