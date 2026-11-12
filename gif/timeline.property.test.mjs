import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jpegSize } from './timeline.mjs';

// A frame is whatever the browser's screencast sends: any bytes at all.
describe('jpegSize, for any bytes', () => {
  it('never throws, and finds a size only in what starts as a JPEG', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const size = jpegSize(bytes);
        if (size !== null) expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      }),
    );
  });

  it('never throws on what starts as a JPEG and goes on as anything, marker bytes thick in it', () => {
    const byte = fc.oneof(
      fc.constant(0xff),
      fc.constantFrom(0xc0, 0xc4, 0xd0, 0xd9, 0xda),
      fc.integer({ min: 0, max: 255 }),
    );
    fc.assert(
      fc.property(fc.array(byte, { maxLength: 64 }), (rest) => {
        const size = jpegSize(Uint8Array.from([0xff, 0xd8, ...rest]));
        if (size !== null) {
          expect(Number.isInteger(size.width) && size.width >= 0).toBe(true);
          expect(Number.isInteger(size.height) && size.height >= 0).toBe(true);
        }
      }),
    );
  });

  it('reads back the size a frame header gives, after any segments before it', () => {
    const segment = fc
      .uint8Array({ maxLength: 20 })
      .map((body) => [0xff, 0xe1, 0, body.length + 2, ...body]);
    const dimension = fc.integer({ min: 1, max: 0xffff });
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), dimension, dimension, (segments, w, h) => {
        const jpeg = Uint8Array.from([
          0xff,
          0xd8,
          ...segments.flat(),
          0xff,
          0xc0,
          0,
          17,
          8,
          h >> 8,
          h & 0xff,
          w >> 8,
          w & 0xff,
          3,
        ]);
        expect(jpegSize(jpeg)).toEqual({ width: w, height: h });
      }),
    );
  });
});
