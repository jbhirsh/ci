// Fails when a version is pinned with no reason written beside it.
//
//   node pins/check.mjs        from the app's checkout (or APP_ROOT)
//
// A pin holds something below its major: it keeps fixes out quietly, and
// often for a reason nobody remembers or that stopped being true. The
// lockfile already fixes what gets installed, and CI fails a bump that
// breaks the build; so a pin is only worth keeping when a bump would break
// something and CI can't see it, or when it blocks every other bump (each
// app groups all of Dependabot's into one PR). Either way, the reason is
// written beside the pin, where whoever bumps it reads it.
//
// What counts as a pin, and where its reason goes:
//   - package.json: a dependency whose range stops short of the next major
//     (an exact version, a tilde, a partial version naming the minor, an
//     upper bound). Its reason goes in a top-level `"//pins"` note: a string
//     or a list of strings, each naming the package, then why. A caret is
//     never a pin, including on a 0.x package. Packages Expo's SDK chooses
//     (node_modules/expo/bundledNativeModules.json, so run this after the
//     install, less the app's `expo.install.exclude`) and `expo` itself need
//     none: the SDK is the reason, and they move together in an SDK upgrade.
//   - package.json `overrides`: every entry, its reason in `"//overrides"`
//     (or `"//pins"`), naming the overridden package.
//   - .github/dependabot.yml: every `ignore` entry, its reason in a comment
//     above it, inside the `ignore` list or just above `ignore:`. One
//     comment explains the entries below it, up to the next comment, so a
//     group that moves together (an SDK's packages) shares one; a comment
//     that gives no reason starts a group that has none.
//   - workflows and action.yml files: an action used at a commit or a
//     version below its major (`@<sha>`, `@v1.2`), a Docker image at a
//     version tag or digest, and a `...version:` or input `default:` holding
//     a version below the major (a `default:` only under an input named for a
//     version). Its reason goes in a comment on its line,
//     just above it, or just above its step.
//   - .nvmrc and .node-version: a version below the major, which has no
//     place for a reason.
// A reason is a few words saying why: a comment that only labels the
// version (`# v2.9.0`, as Dependabot writes beside a commit) isn't one.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../lib/app.mjs';

/** @typedef {{ file: string, line: number, message: string }} Finding */

/** How many words a reason needs, a version label not counting. */
export const REASON_WORDS = 3;

/** Folders never read for workflows or actions. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'ios', 'android']);

/**
 * Whether a comment gives a reason: a few words, not just a version label.
 *
 * @param {string} text
 */
export function isReason(text) {
  const words = text
    .replace(/\b[0-9a-f]{40}\b/gi, ' ')
    .replace(/\bv?\d+(?:\.[\w-]+)*/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 1);
  return words.length >= REASON_WORDS;
}

/**
 * The version range in a dependency's spec, after any `npm:name@` alias;
 * null for a spec that names no registry version (a file, link, git or URL).
 *
 * @param {string} spec
 * @returns {string | null}
 */
export function rangeOf(spec) {
  const alias = /^npm:(?:@[^/@]+\/)?[^/@]+@(.*)$/.exec(spec);
  const range = (alias ? alias[1] : spec).trim();
  if (/^[\w+]+:/.test(range) || range.includes('/')) return null;
  return range;
}

/**
 * Whether one version (`1.2.3`, `=v1.2`, `1.x`) names a minor, so that
 * matching it holds the package below its major.
 *
 * @param {string} version
 */
function namesMinor(version) {
  const [, minor] = version.replace(/^[=v\s]+/, '').split('.');
  return minor !== undefined && /^\d/.test(minor);
}

/**
 * Whether a range holds a package below its next major. A caret, a bare
 * major (`1`, `1.x`), `*`, a dist-tag or a lower bound alone doesn't.
 *
 * @param {string} range
 */
export function isPinnedRange(range) {
  return range.split('||').some((part) => {
    let p = part.trim();
    if (/<=|\s-\s/.test(p)) return true;
    // An upper bound at a major (`<2`, `<2.0.0`) is where a caret stops anyway.
    const below = /<\s*v?(\d+(?:\.\d+)*)/.exec(p);
    if (below) {
      if (!/^\d+(?:\.0)*$/.test(below[1] ?? '')) return true;
      p = p.replace(below[0], '').trim();
    }
    if (p === '' || p.startsWith('^') || !/\d/.test(p)) return false;
    if (p.startsWith('>')) return false;
    if (p.startsWith('~')) return namesMinor(p.replace(/^~>?/, ''));
    return namesMinor(p);
  });
}

/**
 * The caret range to offer in place of a pinned one, when the pin names a
 * single version.
 *
 * @param {string} range
 */
export function caretFor(range) {
  const version = /^[~=v\s>]*(\d+(?:\.\d+){0,2})(?:\.x)?$/.exec(range.trim());
  return version ? `^${version[1]}` : null;
}

/**
 * The notes under a `//…` key: a string or a list of strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function notes(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether one of the notes names `name` and says why.
 *
 * @param {string[]} entries
 * @param {string} name
 */
export function explains(entries, name) {
  const named = new RegExp(`(?:^|[\\s,('"\`])${escape(name)}(?![\\w/-]|\\.\\w)`);
  return entries.some((entry) => named.test(entry) && isReason(entry.replace(named, ' ')));
}

/**
 * The 1-based line of the first `"key"` after `from` in the text, or 1.
 *
 * @param {string} text
 * @param {string} key
 * @param {number} [from]
 */
function lineOfKey(text, key, from = 0) {
  const at = text.indexOf(`${JSON.stringify(key)}`, from);
  return at === -1 ? 1 : text.slice(0, at).split('\n').length;
}

/**
 * The packages whose versions Expo's SDK chooses, or an empty set when the
 * app doesn't use Expo.
 *
 * @param {string} root
 * @param {Record<string, unknown>} pkg
 * @returns {Set<string>}
 */
export function expoManaged(root, pkg) {
  const deps = { ...record(pkg.dependencies), ...record(pkg.devDependencies) };
  if (!('expo' in deps)) return new Set();
  const file = path.join(root, 'node_modules', 'expo', 'bundledNativeModules.json');
  if (!existsSync(file)) {
    throw new Error(`expo is a dependency but ${file} is missing: run this after the install`);
  }
  // `expo install` also sets @types/react, from Expo's versions API rather
  // than this file.
  const listed = Object.keys(record(JSON.parse(readFileSync(file, 'utf8'))));
  const managed = new Set(['expo', '@types/react', ...listed]);
  const exclude = record(record(record(pkg.expo).install)).exclude;
  for (const name of Array.isArray(exclude) ? exclude : []) managed.delete(String(name));
  return managed;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * The pins in package.json that have no reason beside them.
 *
 * @param {string} text the file
 * @param {Set<string>} [exempt] packages whose versions something else chooses
 * @returns {Finding[]}
 */
export function packageFindings(text, exempt = new Set()) {
  const pkg = record(JSON.parse(text));
  const pins = notes(pkg['//pins']);
  /** @type {Finding[]} */
  const findings = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const from = text.indexOf(JSON.stringify(field));
    for (const [name, spec] of Object.entries(record(pkg[field]))) {
      const range = typeof spec === 'string' ? rangeOf(spec) : null;
      if (range === null || !isPinnedRange(range) || exempt.has(name) || explains(pins, name)) {
        continue;
      }
      const caret = caretFor(range);
      findings.push({
        file: 'package.json',
        line: lineOfKey(text, name, from),
        message: `${name} ${spec} holds it below its next major: ${caret ? `use ${caret}, ` : ''}or say why in "//pins".`,
      });
    }
  }
  const because = [...notes(pkg['//overrides']), ...pins];
  const from = text.indexOf('"overrides"');
  for (const key of Object.keys(record(pkg.overrides))) {
    // A key may carry a version selector: `foo@^1`, `@scope/foo@2`.
    const name = key.replace(/(?<=.)@.*$/, '');
    if (explains(because, name) || explains(because, key)) continue;
    findings.push({
      file: 'package.json',
      line: lineOfKey(text, name, from),
      message: `the override of ${name} has no reason: say why, and when to delete it, in "//overrides".`,
    });
  }
  return findings;
}

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;
/** @param {string} line */
const isComment = (line) => line.trimStart().startsWith('#');

/**
 * The comment block that ends just above line `index` (0-based), as text.
 *
 * @param {string[]} lines
 * @param {number} index
 */
function commentAbove(lines, index) {
  const block = [];
  for (let i = index - 1; i >= 0 && isComment(lines[i] ?? ''); i -= 1) {
    block.unshift((lines[i] ?? '').trim().replace(/^#+/, ''));
  }
  return block.join(' ');
}

/**
 * The Dependabot `ignore` entries with no reason above them.
 *
 * @param {string} text
 * @param {string} file
 * @returns {Finding[]}
 */
export function dependabotFindings(text, file) {
  const lines = text.split('\n');
  /** @type {Finding[]} */
  const findings = [];
  lines.forEach((line, start) => {
    if (!/^\s*(?:-\s+)?ignore:\s*(#.*)?$/.test(line)) return;
    const indent = indentOf(line);
    const above = commentAbove(lines, start);
    let reason = isReason(above) ? above : '';
    for (let i = start + 1; i < lines.length; i += 1) {
      const current = lines[i] ?? '';
      if (current.trim() === '') continue;
      // The list may sit at its key's own indent, each entry a `- `.
      const sameLevel = indentOf(current) === indent && current.trimStart().startsWith('- ');
      if (indentOf(current) < indent || (indentOf(current) === indent && !sameLevel)) break;
      if (isComment(current)) {
        const block = commentAbove(lines, i + 1);
        reason = isReason(block) ? block : '';
        continue;
      }
      const entry = /^\s*-\s+dependency-name:\s*["']?([^"'\s#]+)/.exec(current);
      if (entry && !reason) {
        findings.push({
          file,
          line: i + 1,
          message: `the ignore rule for ${entry[1]} has no reason: say why in a comment above it.`,
        });
      }
    }
  });
  return findings;
}

/**
 * Whether a Docker image reference names a version tag or a digest.
 *
 * @param {string} image
 */
export function isPinnedImage(image) {
  if (/@sha256:/.test(image)) return true;
  const tag = /:([^/:]+)$/.exec(image)?.[1];
  return tag !== undefined && /^v?\d+\.\d+/.test(tag);
}

/**
 * The pin on one line of a workflow or action, if any, as a message.
 *
 * @param {string} code the line, its comment cut off
 * @returns {string | null}
 */
export function pinOnLine(code) {
  const uses = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s]+)/.exec(code)?.[1];
  if (uses?.startsWith('docker://')) {
    const image = uses.slice('docker://'.length);
    return isPinnedImage(image) ? `the image ${image} is pinned to a version` : null;
  }
  if (uses && !uses.startsWith('./')) {
    const at = uses.lastIndexOf('@');
    const ref = at === -1 ? '' : uses.slice(at + 1);
    if (/^[0-9a-f]{40}$/i.test(ref) || /^v?\d+\.\d+/.test(ref)) {
      return `${uses.slice(0, at)} is used at ${ref}, below its major`;
    }
    return null;
  }
  const image = /^\s*(?:-\s+)?(?:image|container):\s*["']?([^"'\s]+)/.exec(code)?.[1];
  if (image && isPinnedImage(image)) return `the image ${image} is pinned to a version`;
  if (/\bdocker\s+(?:run|pull)\b/.test(code)) {
    const pinned = code
      .split(/\s+/)
      .find(
        (token) => /^[a-z0-9][\w./-]*(?::[\w.-]+|@sha256:\w+)$/.test(token) && isPinnedImage(token),
      );
    if (pinned) return `the image ${pinned} is pinned to a version`;
  }
  const version =
    /^\s*(?:-\s+)?([\w-]*version|default)\s*:\s*["']?(v?\d+\.\d+[\w.+-]*)["']?\s*$/i.exec(code);
  if (version) return `${version[1]} holds ${version[2]}, below its major`;
  return null;
}

/**
 * The line (0-based) where the step or list item holding line `index` starts.
 *
 * @param {string[]} lines
 * @param {number} index
 */
function itemStart(lines, index) {
  let indent = indentOf(lines[index] ?? '');
  if ((lines[index] ?? '').trimStart().startsWith('- ')) return index;
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || isComment(line) || indentOf(line) >= indent) continue;
    if (line.trimStart().startsWith('- ')) return i;
    indent = indentOf(line);
  }
  return index;
}

/**
 * The key that line `index` (0-based) sits under: an input's name, for its
 * `default:`.
 *
 * @param {string[]} lines
 * @param {number} index
 */
function parentKey(lines, index) {
  const indent = indentOf(lines[index] ?? '');
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || isComment(line) || indentOf(line) >= indent) continue;
    return line.trim().replace(/^-\s+/, '').split(':')[0] ?? '';
  }
  return '';
}

/**
 * The pins in a workflow or action.yml that have no reason beside them.
 *
 * @param {string} text
 * @param {string} file
 * @returns {Finding[]}
 */
export function yamlFindings(text, file) {
  const lines = text.split('\n');
  /** @type {Finding[]} */
  const findings = [];
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const cut = /\s#\s?(.*)$/.exec(line);
    const pin = pinOnLine(cut ? line.slice(0, cut.index) : line);
    if (!pin) return;
    // An input's default is a version only when the input says it is one.
    if (pin.startsWith('default ') && !/version/i.test(parentKey(lines, index))) return;
    const reasons = [
      cut?.[1] ?? '',
      commentAbove(lines, index),
      commentAbove(lines, itemStart(lines, index)),
    ];
    if (reasons.some(isReason)) return;
    findings.push({
      file,
      line: index + 1,
      message: `${pin}: follow the major, or say why in a comment beside it.`,
    });
  });
  return findings;
}

/**
 * The workflow and action files in the checkout, relative to its root.
 *
 * @param {string} root
 * @param {string} [dir]
 * @returns {string[]}
 */
export function yamlFiles(root, dir = '') {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github'))
        continue;
      found.push(...yamlFiles(root, rel));
    } else if (
      /^action\.ya?ml$/.test(entry.name) ||
      (dir === '.github/workflows' && /\.ya?ml$/.test(entry.name))
    ) {
      found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Every pin in the checkout with no reason beside it.
 *
 * @param {string} root
 * @returns {Finding[]}
 */
export function findings(root) {
  /** @param {string} rel */
  const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
  /** @type {Finding[]} */
  const found = [];
  if (existsSync(path.join(root, 'package.json'))) {
    const text = read('package.json');
    found.push(...packageFindings(text, expoManaged(root, record(JSON.parse(text)))));
  }
  for (const rel of ['.github/dependabot.yml', '.github/dependabot.yaml']) {
    if (existsSync(path.join(root, rel))) found.push(...dependabotFindings(read(rel), rel));
  }
  for (const rel of yamlFiles(root)) found.push(...yamlFindings(read(rel), rel));
  for (const rel of ['.nvmrc', '.node-version']) {
    if (!existsSync(path.join(root, rel))) continue;
    const version = read(rel).trim();
    if (namesMinor(version)) {
      found.push({
        file: rel,
        line: 1,
        message: `Node ${version} is below its major: write the major alone.`,
      });
    }
  }
  return found;
}

/**
 * Prints each pin with no reason (as a GitHub annotation in Actions) and
 * returns the exit code.
 *
 * @param {string} root
 * @param {{ log?: (line: string) => void, actions?: boolean }} [options]
 * @returns {number}
 */
export function main(
  root,
  { log = console.log, actions = Boolean(process.env.GITHUB_ACTIONS) } = {},
) {
  const found = findings(root);
  for (const { file, line, message } of found) {
    log(actions ? `::error file=${file},line=${line}::${message}` : `${file}:${line}: ${message}`);
  }
  log(
    found.length === 0
      ? 'pins: nothing is pinned without a reason.'
      : `pins: ${found.length} pinned without a reason (pins/check.mjs says what counts).`,
  );
  return found.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(appRoot());
}
