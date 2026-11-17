import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DIP, GLYPHS, RISE, SPACE, UNITS } from './glyphs.mjs';

describe('the glyph table', () => {
  it('holds exactly the twelve characters of a count', () => {
    expect(Object.keys(GLYPHS).sort().join('')).toBe('+0123456789−');
  });

  it('is the table that was taken from Mona Sans, unchanged (a checksum, so an edit is deliberate)', () => {
    const hash = createHash('sha256')
      .update(JSON.stringify({ GLYPHS, SPACE, RISE, DIP, UNITS }))
      .digest('hex');
    expect(hash).toBe('a581c4db08ff43d83625ff3f5bc18742051ec3a6b5acf84556577bb86f77045b');
  });

  it('gives every character an outline and a width', () => {
    for (const glyph of Object.values(GLYPHS)) {
      expect(glyph.advance).toBeGreaterThan(300);
      expect(glyph.d).toMatch(/^M-?\d+ ?-?\d+/);
      expect(glyph.d).not.toMatch(/[^MLQCZ0-9 .-]/);
    }
  });
});
