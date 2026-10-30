import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CHARS, clean, composeComment, mergeSections, parseSections } from './comment.mjs';

const by = { workflow: 'CI', number: 1, url: 'https://gh/run/1' };
const head = 'a'.repeat(40);

/**
 * A section, its text up to the given length.
 *
 * @param {number} maxLength
 */
const sectionOf = (maxLength) =>
  fc.record({
    workflow: fc.string({ unit: 'binary', maxLength: 30 }),
    job: fc.string({ unit: 'binary', maxLength: 30 }),
    sha: fc.oneof(fc.constant(head), fc.string({ unit: 'binary', maxLength: 40 })),
    text: fc.string({ unit: 'binary', maxLength }),
  });
const section = sectionOf(300);

/**
 * A string as a marker carries it: lone surrogates replaced.
 *
 * @param {string} text
 */
const wellFormed = (text) => Buffer.from(text, 'utf8').toString('utf8');

/**
 * Sections as they go in: each workflow and job once, with some text.
 *
 * @param {import('./comment.mjs').Section[]} list
 */
const distinct = (list) => {
  const seen = new Set();
  return list.filter((s) => {
    const key = JSON.stringify([wellFormed(s.workflow), wellFormed(s.job)]);
    if (seen.has(key) || !clean(s.text)) return false;
    seen.add(key);
    return true;
  });
};

describe('parseSections, for any comment', () => {
  it('never throws, and reads back no more sections than markers', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (body) => {
        const sections = parseSections(body);
        expect(sections.length).toBeLessThanOrEqual(body.split('job-reports:section').length - 1);
      }),
    );
  });

  it("reads back what composeComment wrote: each section's names, commit and text", () => {
    fc.assert(
      fc.property(fc.array(section, { maxLength: 6 }), (list) => {
        const sections = distinct(list);
        const back = parseSections(composeComment('o/r', head, sections, by));
        expect(back).toEqual(
          sections.map((s) => ({
            workflow: wellFormed(s.workflow),
            job: wellFormed(s.job),
            sha: wellFormed(s.sha),
            text: clean(s.text),
          })),
        );
      }),
    );
  });

  it('stays under the limit and keeps its marker, however long the sections', () => {
    fc.assert(
      fc.property(fc.array(sectionOf(30_000), { maxLength: 5 }), (list) => {
        const body = composeComment('o/r', head, distinct(list), by);
        expect(body.length).toBeLessThanOrEqual(MAX_CHARS);
        expect(body.startsWith('<!-- job-reports -->')).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});

describe('mergeSections, for any sections', () => {
  it("keeps every other workflow's, holds all the run's, and groups by workflow", () => {
    fc.assert(
      fc.property(fc.array(section), fc.array(section), fc.string(), (existing, own, wf) => {
        const mine = own.map((s) => ({ ...s, workflow: wf }));
        const merged = mergeSections(existing, mine, wf);
        expect(merged.filter((s) => s.workflow === wf)).toEqual(mine);
        expect(merged.filter((s) => s.workflow !== wf)).toEqual(
          [...existing.filter((s) => s.workflow !== wf)].sort((a, b) =>
            a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0,
          ),
        );
        const names = merged.map((s) => s.workflow);
        expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }),
    );
  });
});
