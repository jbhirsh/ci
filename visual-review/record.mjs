// What visual review keeps in the description it writes (ci#144), in place
// of the upload comment it used to post: a hidden record line at the start
// of its block, and the rule for which edits of the description are its own.
// Pure, and light enough for the find job, which installs nothing.
//
// The record line says which result the block shows and where its pictures
// are:
//
//   <!-- visual-review:upload sha=<head> fingerprint=<8 hex> format=<n> layout=<8 hex> run=<id> assets=<id>,<id> -->
//
//   - sha, the head the result was found on; run, the screenshot run;
//   - fingerprint, format and layout decide whether a new result needs a new
//     upload (review.mjs): all three the same, the review re-renders the
//     table from `assets` instead, so a slot added later fills with no
//     upload;
//   - assets, the attachment ids, in the order the review picks its
//     pictures (table.mjs's pick).
// It is read from the description, which the PR's author can edit, so it
// only ever decides whether to upload again and which links to re-render
// with: editing it can make the PR's own table stale, never change what
// `Visual changes` says, which reads only the Actions token's statuses.
//
// An edit of the description that changes only visual review's block (its
// first upload adds it, at the end) and the contents of its slots (their
// markers kept) is the upload's own, and starts no review (find.mjs): judged
// by the text, never by who edited, as BOT_PR_TOKEN is the owner's account.
// A slot added or removed is an author's edit, and is reviewed.

import { blocks } from '../describe/describe.mjs';

/** The bot's name in its description block and slots. */
export const BOT = 'visual-review';

/** An attachment's id, as GitHub gives it in a `user-attachments/assets/<id>` link. */
const ASSET = /^[0-9a-f][0-9a-f-]{7,63}$/;

const LINE =
  /^<!-- visual-review:upload sha=([0-9a-f]{40}) fingerprint=([0-9a-f]{8}) format=(\d{1,4}) layout=([0-9a-f]{8}) run=(\d{1,20}) assets=([0-9a-f,-]*) -->$/m;

/**
 * What the record line says.
 *
 * @typedef {{ sha: string, fingerprint: string, format: number, layout: string,
 *   run: number, assets: string[] }} Record
 */

/**
 * The record line for a result.
 *
 * @param {Record} record
 */
export function recordLine({ sha, fingerprint, format, layout, run, assets }) {
  return `<!-- visual-review:upload sha=${sha} fingerprint=${fingerprint} format=${format} layout=${layout} run=${run} assets=${assets.join(',')} -->`;
}

/**
 * The record in a description's visual-review block, or null when it has
 * none (or none that reads as one).
 *
 * @param {string} body
 * @returns {Record | null}
 */
export function parseRecord(body) {
  const at = blocks.find(body, BOT);
  if (!at) return null;
  const m = LINE.exec(body.slice(at.from, at.to));
  if (!m) return null;
  const assets = m[6] === '' ? [] : m[6].split(',');
  if (!assets.every((a) => ASSET.test(a))) return null;
  return {
    sha: m[1],
    fingerprint: m[2],
    format: Number(m[3]),
    layout: m[4],
    run: Number(m[5]),
    assets,
  };
}

/** The link to an attachment by its id. */
export const assetLink = (/** @type {string} */ id) =>
  `https://github.com/user-attachments/assets/${id}`;

/**
 * A description without visual review's block, its slots emptied (their
 * marker lines kept) and its end trimmed: what an edit must change for it
 * to be more than the upload's own.
 *
 * @param {string} body
 */
export function outsideOwnBlocks(body) {
  return body
    .replace(/<!-- describe:visual-review -->[\s\S]*?<!-- \/describe:visual-review -->/g, '')
    .replace(
      /(<!-- describe:visual-review:([^\s<>]+) -->)[\s\S]*?(<!-- \/describe:visual-review:\2 -->)/g,
      '$1$3',
    )
    .trimEnd();
}
