import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MESSAGE_LENGTH, parseJunit, unescapeXml } from './junit.mjs';

/**
 * An attribute value as XML would carry it.
 *
 * @param {string} text
 */
const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('parseJunit, for any input', () => {
  it('never throws, and every case has a name, a time of zero or more, a result and a short message', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (xml) => {
        for (const c of parseJunit(xml)) {
          expect(c.name).not.toBe('');
          expect(c.seconds).toBeGreaterThanOrEqual(0);
          expect(['passed', 'failed', 'skipped', 'passed on re-run']).toContain(c.result);
          expect(c.message.length).toBeLessThanOrEqual(MESSAGE_LENGTH);
        }
      }),
    );
  });

  it('reads back the cases it was given', () => {
    const testCase = fc.record({
      name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== ''),
      seconds: fc.double({ min: 0, max: 1e5, noNaN: true }),
      result: fc.constantFrom(
        /** @type {const} */ ('passed'),
        'failed',
        'skipped',
        'passed on re-run',
      ),
    });
    fc.assert(
      fc.property(fc.array(testCase, { maxLength: 8 }), (cases) => {
        const xml = cases
          .map((c) => {
            const open = `<testcase name="${escape(c.name)}" time="${c.seconds}"`;
            if (c.result === 'passed') return `${open}/>`;
            const inner = {
              failed: '<failure>x</failure>',
              skipped: '<skipped/>',
              'passed on re-run':
                '<flakyFailure message="x"><stackTrace>x</stackTrace></flakyFailure>',
            }[c.result];
            return `${open}>${inner}</testcase>`;
          })
          .join('\n');
        expect(parseJunit(`<testsuite>${xml}</testsuite>`, 'r.xml')).toEqual(
          cases.map((c) => ({
            ...c,
            name: c.name.trim(),
            file: 'r.xml',
            message: c.result === 'failed' || c.result === 'passed on re-run' ? 'x' : '',
            detail: c.result === 'failed' || c.result === 'passed on re-run' ? 'x' : '',
            suite: '',
            source: '',
          })),
        );
      }),
    );
  });
});

describe('unescapeXml, for any text', () => {
  it('undoes escaping', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(unescapeXml(escape(text))).toBe(text);
      }),
    );
  });
});
