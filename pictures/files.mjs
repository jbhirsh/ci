// The pictures FILES names, checked in the artifact's folder before any is
// uploaded. The artifact is what a CI run made, maybe from a patch nobody
// reviewed (sift's mockup runs), so its files are read as bytes and nothing
// more: each must be a regular file inside the folder (a link out of it is
// refused), at most the 10 MB GitHub attaches, and a PNG, JPEG or GIF by its
// first bytes, matching its extension, so nothing else goes up as a picture.

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ATTACH_MAX_BYTES } from '../lib/attach.mjs';

/** @typedef {import('./inputs.mjs').Picture} Picture */

/** Each type's extensions and the bytes its files start with. */
const TYPES = [
  { name: 'PNG', extensions: ['.png'], magic: [Buffer.from('89504e470d0a1a0a', 'hex')] },
  { name: 'JPEG', extensions: ['.jpg', '.jpeg'], magic: [Buffer.from('ffd8ff', 'hex')] },
  { name: 'GIF', extensions: ['.gif'], magic: [Buffer.from('GIF87a'), Buffer.from('GIF89a')] },
];

/**
 * The file's first `n` bytes (fewer for a shorter file).
 *
 * @param {string} file
 * @param {number} n
 */
function head(file, n) {
  const bytes = Buffer.alloc(n);
  const fd = openSync(file, 'r');
  try {
    return bytes.subarray(0, readSync(fd, bytes, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws unless every picture is a PNG, JPEG or GIF file inside `dir`, of at
 * most ATTACH_MAX_BYTES.
 *
 * @param {string} dir the artifact's folder
 * @param {readonly Picture[]} files
 */
export function checkFiles(dir, files) {
  const root = realpathSync(dir);
  for (const { path: file } of files) {
    const local = path.join(root, file);
    /** @type {string} */
    let real;
    try {
      real = realpathSync(local);
    } catch {
      throw new Error(`pictures: the artifact has no ${file}`);
    }
    if (!real.startsWith(root + path.sep)) {
      throw new Error(`pictures: ${file} leads out of the artifact`);
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error(`pictures: ${file} isn't a file`);
    if (stat.size > ATTACH_MAX_BYTES) {
      throw new Error(
        `pictures: ${file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 10 MB GitHub attaches`,
      );
    }
    const type = TYPES.find((t) => t.extensions.includes(path.extname(file).toLowerCase()));
    if (!type) throw new Error(`pictures: ${file} isn't a .png, .jpg, .jpeg or .gif`);
    const start = head(real, 8);
    if (!type.magic.some((m) => start.subarray(0, m.length).equals(m))) {
      throw new Error(`pictures: ${file} isn't a ${type.name}, whatever its name says`);
    }
  }
}
