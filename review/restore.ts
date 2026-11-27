// Puts the base branch's Claude instructions back in the PR's checkout
// before the review (sdk.ts), which loads them
// (`settingSources: ["project"]`). A PR can't then rewrite what its own
// reviewer is told, or what it may do: every CLAUDE.md and CLAUDE.local.md,
// at any depth, and everything under a `.claude/` folder, is made as the
// base holds it, and one the PR adds is removed. What the PR changes in
// them is still in its diff, which the review reads.
//
// A PR could make one of these paths, or a folder above one, a symlink, so
// that writing the base's copy overwrote a file elsewhere (this action's own
// scripts, say). Every path is written through real folders only: a symlink
// on the way is removed first, and the file itself is replaced, never
// written through. A base CLAUDE.md's `@` imports are restored only where
// they name such a file (this repo's `@claude-rules/CLAUDE.md` does); no
// app imports anything else today.
//
// CLI: `node restore.ts`, run from the app's checkout, with BASE_REF.

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../lib/app.ts';

/**
 * Whether a repo path is Claude's: instructions or settings.
 */
export function isClaudeFile(file: string): boolean {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  return (
    name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || parts.slice(0, -1).includes('.claude')
  );
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Whether a path exists as a symlink (not followed).
 */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The real folder holding a repo path, made through real folders only: a
 * symlink on the way is removed and a folder made in its place.
 *
 * @returns the file's absolute path
 */
function realPathFor(root: string, file: string): string {
  const parts = file.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    if (isLink(dir)) rmSync(dir);
    mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, parts[parts.length - 1]);
}

/**
 * Makes the checkout's Claude files the base's. Returns what it changed.
 */
export function restoreFromBase({ root, base }: { root: string; base: string }): {
  restored: string[];
  removed: string[];
} {
  const ref = `origin/${base}`;
  const list = (args: string[]) => git(root, args).split('\0').filter(Boolean).filter(isClaudeFile);
  const inBase = new Set(list(['ls-tree', '-r', '-z', '--name-only', ref]));
  const inHead = list(['ls-files', '-z']);
  const restored = [];
  const removed = [];
  for (const file of inBase) {
    const target = realPathFor(root, file);
    rmSync(target, { force: true, recursive: true });
    writeFileSync(target, execFileSync('git', ['-C', root, 'show', `${ref}:${file}`]));
    restored.push(file);
  }
  for (const file of inHead) {
    if (inBase.has(file)) continue;
    rmSync(realPathFor(root, file), { force: true, recursive: true });
    removed.push(file);
  }
  return { restored, removed };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { restored, removed } = restoreFromBase({
    root: appRoot(),
    base: process.env.BASE_REF || 'main',
  });
  console.log(
    `Claude's files from the base: ${restored.length} restored, ${removed.length} the PR added removed.`,
  );
}
/* c8 ignore stop */
