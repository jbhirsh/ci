import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bullets, fill, placeholders } from './template.mjs';

describe('fill', () => {
  it('replaces every placeholder, as often as it appears', () => {
    expect(fill('{{a}} and {{b}}, {{a}}', { a: '1', b: '2' })).toBe('1 and 2, 1');
  });
  it('inserts values as they are, never filling placeholders inside them', () => {
    expect(fill('x {{a}}', { a: '{{b}} $& $1', b: 'no' })).toBe('x {{b}} $& $1');
  });
  it('throws on a name with no value, and on a stray brace pair', () => {
    expect(() => fill('{{a}} {{b}} {{b}}', { a: '' })).toThrow('No value for b');
    expect(() => fill('{{a}} {{ b }}', { a: '' })).toThrow(
      'A stray "{{" in the template near: {{ b }}',
    );
    expect(() => fill('{{toString}}', {})).toThrow('No value for toString');
  });
  it('never leaves a placeholder in the output for any values', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.stringMatching(/^\w{1,5}$/), fc.string()), (values) => {
        const template = Object.keys(values)
          .map((k) => `<{{${k}}}>`)
          .join(' ');
        const out = fill(template, values);
        expect(out).toBe(
          Object.entries(values)
            .map(([, v]) => `<${v}>`)
            .join(' '),
        );
      }),
    );
  });
});

describe('placeholders', () => {
  it('lists the names, each once, in order of first use', () => {
    expect(placeholders('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });
});

describe('bullets', () => {
  it('makes one item a line, indented as asked', () => {
    expect(bullets(['a', 'b'])).toBe('- a\n- b');
    expect(bullets(['a'], '  ')).toBe('  - a');
    expect(bullets([])).toBe('');
  });
});
