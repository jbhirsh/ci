import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT } from './baselines.mjs';
import { CASES, SCRIPT, checkIgnore } from './vercel-ignore.mjs';

/**
 * An app holding this ignore script.
 *
 * @param {string} body
 */
function app(body) {
  const root = mkdtempSync(path.join(tmpdir(), 'ignore-'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, SCRIPT), body);
  return root;
}

// The rule as #51 states it, as an app would write it.
const RIGHT = `import { execFileSync } from 'node:child_process';
const [author, committer] = execFileSync('git', ['log', '-1', '--format=%an|%cn'], { encoding: 'utf8' }).trim().split('|');
const amend = committer === '${BOT.name}' && author !== '${BOT.name}';
process.exit(process.env.VERCEL_ENV === 'preview' && amend ? 0 : 1);
`;

describe('checkIgnore', () => {
  it('passes a script that answers every case', () => {
    expect(checkIgnore(app(RIGHT))).toBe(
      `visual-baselines: ${SCRIPT} answers all ${CASES.length} cases.`,
    );
  });

  it('says nothing for an app without the script', () => {
    expect(checkIgnore(mkdtempSync(path.join(tmpdir(), 'none-')))).toBe(null);
  });

  it('names each case a script answers wrongly', () => {
    const always = app('process.exit(0);\n');
    expect(() => checkIgnore(always)).toThrow(
      `${SCRIPT} answers wrongly: a commit the bot made from scratch: skips, should build; a person's commit: skips, should build; GitHub's merge or Update branch: skips, should build; the bot's amend, in production: skips, should build`,
    );
    expect(() => checkIgnore(app('process.exit(2);\n'))).toThrow(
      "the baselines bot's amend, on a preview: exits 2, should skip",
    );
    // Production too: a script that ignores VERCEL_ENV skips a deploy of main.
    const noEnv = app(RIGHT.replace("process.env.VERCEL_ENV === 'preview' && ", ''));
    expect(() => checkIgnore(noEnv)).toThrow(/in production: skips, should build$/);
  });

  it('commits each case with its author and committer, outside any repository the run is in', () => {
    const echo = app(`import { execFileSync } from 'node:child_process';
const seen = execFileSync('git', ['log', '-1', '--format=%an|%cn|%s'], { encoding: 'utf8' }).trim();
process.exit(seen === 'A Person|${BOT.name}|' + process.env.EXPECT ? 0 : 1);
`);
    const one = [{ ...CASES[0] }];
    process.env.GIT_DIR = '/nowhere';
    process.env.EXPECT = one[0].name;
    try {
      expect(checkIgnore(echo, one)).toMatch(/all 1 cases/);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.EXPECT;
    }
  });
});
