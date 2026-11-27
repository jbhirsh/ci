import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  blocks,
  isScreenState,
  parseUpload,
  partMarker,
  SECTION,
  uploadMarker,
  withSections,
} from './describe.ts';

const BOT = 'jbhirsh';
const A = 'a'.repeat(40);

describe('parseUpload, for any comment', () => {
  it('never throws, and takes only links to attachments', () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (section, login) => {
        const comment = {
          id: 1,
          node_id: 'N',
          user: { login: login ?? undefined },
          body: `${uploadMarker('visual-review', A)}\n${SECTION}\n${section}`,
        };
        const upload = parseUpload(comment, BOT);
        if (upload) {
          expect(login).toBe(BOT);
          for (const m of upload.section.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
            expect(m[0]).toMatch(/^https:\/\/github\.com\/user-attachments\/assets\//);
          }
        }
      }),
    );
  });
});

describe('withSections, for any description', () => {
  it('keeps everything outside its own blocks, and writing twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, section) => {
        const marked = /<!-- \/?describe:/.test(body);
        fc.pre(!marked);
        const sections = new Map([
          ['visual-review', { id: 1, nodeId: 'N', bot: 'visual-review', sha: A, section }],
        ]);
        const out = withSections(body, sections);
        expect(out.startsWith(body.trimEnd())).toBe(true);
        expect(withSections(out, sections)).toBe(out);
        expect(blocks.find(out, 'visual-review')).not.toBeNull();
      }),
    );
  });
});

describe('withSections, for a section in parts and any description of slots', () => {
  const upload = (section: string) =>
    new Map([['visual-review', { id: 1, nodeId: 'N', bot: 'visual-review', sha: A, section }]]);

  it('never throws, shows each screen once, and writing twice changes nothing', () => {
    // Markers of every kind in any order: whole, torn, nested, overlapping, doubled.
    const marker = (state: string, start: boolean) =>
      start
        ? `<!-- describe:visual-review:${state} -->`
        : `<!-- /describe:visual-review:${state} -->`;
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 6 }), { maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(8), fc.boolean(), fc.boolean()), { maxLength: 14 }),
        (states, picks) => {
          // A state with no slot to hold it, as table.ts sends it, goes to the rest part.
          const usable = [...new Set(states.filter(isScreenState))];
          const unusable = states.filter((s) => !isScreenState(s));
          const lines = [partMarker('head'), 'HEAD0X'];
          usable.forEach((s, i) => lines.push('', partMarker(`screen:${s}`), `SCREEN${i}X`));
          lines.push(
            '',
            partMarker('rest'),
            unusable.map((_, i) => `REST${i}X`).join('\n') || 'REST',
          );
          const section = lines.join('\n');
          const body = picks
            .map(([n, start, own]) =>
              own
                ? start
                  ? '<!-- describe:visual-review -->'
                  : '<!-- /describe:visual-review -->'
                : marker(usable[n % Math.max(usable.length, 1)] ?? 'x', start),
            )
            .join('\nauthor text\n');
          const out = withSections(body, upload(section));
          for (let i = 0; i < usable.length; i++) expect(out.split(`SCREEN${i}X`)).toHaveLength(2);
          for (let i = 0; i < unusable.length; i++) expect(out.split(`REST${i}X`)).toHaveLength(2);
          expect(out.split('HEAD0X')).toHaveLength(2);
          expect(out).not.toContain('describe-part');
          expect(withSections(out, upload(section))).toBe(out);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('puts a screen in the slot an author placed, and any other under the heading', () => {
    // Clean layouts only: each state has at most one pair, never nested or torn.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9._-]{1,5}$/).filter(isScreenState), {
          maxLength: 6,
        }),
        fc.array(fc.boolean(), { maxLength: 6 }),
        (states, slotted) => {
          const lines = [partMarker('head'), 'HEAD0X'];
          states.forEach((s, i) => lines.push('', partMarker(`screen:${s}`), `SCREEN${i}X`));
          const body = states
            .filter((_, i) => slotted[i])
            .map(
              (s) => `<!-- describe:visual-review:${s} -->\n<!-- /describe:visual-review:${s} -->`,
            )
            .join('\n\nauthor text\n\n');
          const out = withSections(body, upload(lines.join('\n')));
          const heading = out.indexOf('HEAD0X');
          states.forEach((s, i) => {
            const at = out.indexOf(`SCREEN${i}X`);
            const { from, to } = (blocks.find(out, `visual-review:${s}`) ?? {
              from: -1,
              to: -1,
            }) as { from: number; to: number };
            if (slotted[i]) {
              expect(at).toBeGreaterThan(from);
              expect(at).toBeLessThan(to);
            } else {
              expect(at).toBeGreaterThan(heading);
            }
          });
        },
      ),
    );
  });

  it('never throws for a slot named by any text, nor for a part it cannot hold', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), (slotName, state) => {
        const body = `<!-- describe:visual-review:${slotName} -->\nx\n<!-- /describe:visual-review:${slotName} -->`;
        const section = `${partMarker('head')}\nH\n${partMarker(`screen:${state}`)}\nS`;
        const out = withSections(body, upload(section));
        expect(withSections(out, upload(section))).toBe(out);
      }),
      { numRuns: 500 },
    );
  });
});

describe('withSections, for tables in parts and any slots', () => {
  const upload = (section: string) =>
    new Map([['visual-review', { id: 1, nodeId: 'N', bot: 'visual-review', sha: A, section }]]);
  const HB = '| BIG | b |\n|---|---|';
  const HM = '| MINOR | m |\n|---|---|';

  it('writes every row once under one header a table, counts the fold, and is stable', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9._-]{1,5}$/).filter(isScreenState), {
          maxLength: 6,
        }),
        fc.array(fc.constantFrom('big', 'minor', 'both'), { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.boolean(),
        (states, kinds, slotted, withRows) => {
          const lines = [partMarker('head'), 'HEAD0X'];
          lines.push('', partMarker('header:big'), HB, '', partMarker('header:minor'), HM);
          states.forEach((st, i) => {
            if (kinds[i] !== 'minor') lines.push('', partMarker(`big:${st}`), `| BROW${i}X | 1 |`);
            if (kinds[i] !== 'big') {
              lines.push('', partMarker(`minor:${st}`), `| MROW${i}X | 1 |`);
            }
          });
          if (withRows) lines.push('', partMarker('minor'), '| MROWSX | 1 |');
          lines.push('', partMarker('fold:closed'), 'Minor edge differences (under 0.1%)');
          const body = states
            .filter((_, i) => slotted[i])
            .map(
              (st) =>
                `<!-- describe:visual-review:${st} -->\n<!-- /describe:visual-review:${st} -->`,
            )
            .join('\n\ntext\n\n');
          const out = withSections(body, upload(lines.join('\n')));
          states.forEach((_, i) => {
            if (kinds[i] !== 'minor') expect(out.split(`BROW${i}X`)).toHaveLength(2);
            if (kinds[i] !== 'big') expect(out.split(`MROW${i}X`)).toHaveLength(2);
          });
          expect(out.split('MROWSX')).toHaveLength(withRows ? 2 : 1);
          // A table's header is followed by its rows with no blank line between.
          for (const [header, rowTag] of [
            ['| BIG |', 'BROW'],
            ['| MINOR |', 'MROW'],
          ]) {
            const blocksOfTable = out.split('\n\n').filter((b) => b.includes(header));
            for (const b of blocksOfTable) {
              expect(b.split('\n').filter((l) => l.startsWith(header))).toHaveLength(1);
              expect(
                b
                  .split('\n')
                  .filter((l) => l !== '' && !l.startsWith('<'))
                  .every((l) => l.startsWith('|')),
              ).toBe(true);
              expect(b.includes(rowTag) || b.includes('MROWSX')).toBe(true);
            }
          }
          const unplaced = states.filter((_, i) => !slotted[i] && kinds[i] !== 'big').length;
          const count = unplaced + (withRows ? 1 : 0);
          const fold = /Minor edge differences \(under 0\.1%\): (\d+) screen/.exec(out);
          if (count > 0) expect(Number(fold?.[1])).toBe(count);
          else expect(fold).toBeNull();
          expect(out).not.toContain('describe-part');
          expect(withSections(out, upload(lines.join('\n')))).toBe(out);
        },
      ),
      { numRuns: 300 },
    );
  });
});
