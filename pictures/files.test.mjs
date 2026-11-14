import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACH_MAX_BYTES } from '../lib/attach.mjs';
import { checkFiles } from './files.mjs';

// Each type's first bytes, as a real file of it starts.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF87 = Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1');
const GIF89 = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

/**
 * A folder holding these files.
 *
 * @param {Record<string, Buffer | string>} files
 */
function folder(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pictures-files-'));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

/** @param {string} p */
const named = (p) => ({ path: p, caption: p });

describe('checkFiles', () => {
  it('passes a PNG, a JPEG and each GIF, whatever the case of their extension', () => {
    const dir = folder({
      'a/shot.png': PNG,
      'b.JPG': JPEG,
      'c.jpeg': JPEG,
      'd.gif': GIF87,
      'e.gif': GIF89,
    });
    expect(() =>
      checkFiles(dir, ['a/shot.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.gif'].map(named)),
    ).not.toThrow();
  });

  it('refuses a missing file', () => {
    expect(() => checkFiles(folder({}), [named('gone.png')])).toThrow(
      'pictures: the artifact has no gone.png',
    );
  });

  it('refuses a folder', () => {
    const dir = folder({ 'd/x.png': PNG });
    expect(() => checkFiles(dir, [named('d')])).toThrow("pictures: d isn't a file");
  });

  it('refuses a link out of the artifact', () => {
    const outside = folder({ 'secret.png': PNG });
    const dir = folder({});
    symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link.png'));
    expect(() => checkFiles(dir, [named('link.png')])).toThrow(
      'pictures: link.png leads out of the artifact',
    );
  });

  it('passes a link that stays inside it', () => {
    const dir = folder({ 'real.png': PNG });
    symlinkSync(path.join(dir, 'real.png'), path.join(dir, 'link.png'));
    expect(() => checkFiles(dir, [named('link.png')])).not.toThrow();
  });

  it('refuses a file over the 10 MB GitHub attaches', () => {
    const dir = folder({ 'big.png': PNG, 'edge.png': PNG });
    truncateSync(path.join(dir, 'big.png'), ATTACH_MAX_BYTES + 1);
    truncateSync(path.join(dir, 'edge.png'), ATTACH_MAX_BYTES);
    expect(() => checkFiles(dir, [named('edge.png')])).not.toThrow();
    expect(() => checkFiles(dir, [named('big.png')])).toThrow(
      'pictures: big.png is 10.0 MB, over the 10 MB GitHub attaches',
    );
  });

  it('refuses an extension that is no picture', () => {
    const dir = folder({ 'x.svg': '<svg/>', y: PNG });
    expect(() => checkFiles(dir, [named('x.svg')])).toThrow(
      "pictures: x.svg isn't a .png, .jpg, .jpeg or .gif",
    );
    expect(() => checkFiles(dir, [named('y')])).toThrow("isn't a .png, .jpg, .jpeg or .gif");
  });

  it('refuses bytes that are not what the extension says', () => {
    const dir = folder({
      'gif.png': GIF89,
      'png.jpg': PNG,
      'text.gif': 'GIF90a hello',
      'empty.png': '',
      'short.png': PNG.subarray(0, 4),
    });
    expect(() => checkFiles(dir, [named('gif.png')])).toThrow(
      "pictures: gif.png isn't a PNG, whatever its name says",
    );
    expect(() => checkFiles(dir, [named('png.jpg')])).toThrow("png.jpg isn't a JPEG");
    expect(() => checkFiles(dir, [named('text.gif')])).toThrow("text.gif isn't a GIF");
    expect(() => checkFiles(dir, [named('empty.png')])).toThrow("empty.png isn't a PNG");
    expect(() => checkFiles(dir, [named('short.png')])).toThrow("short.png isn't a PNG");
  });
});
