import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, main, plan, prBody } from './publish.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

describe('changedFiles', () => {
  it('reads the space-separated names', () => {
    expect(changedFiles(' map.png  explore.png ')).toEqual(['map.png', 'explore.png']);
    expect(changedFiles(undefined)).toEqual([]);
  });

  it('refuses anything but a PNG name', () => {
    expect(() => changedFiles('map.png ../../etc/passwd')).toThrow(
      'not a screenshot name: ../../etc/passwd',
    );
  });
});

describe('plan', () => {
  it('publishes changed shots, whatever is open', () => {
    expect(plan({ capture: true, files: ['a.png'], open: '' })).toBe('publish');
    expect(plan({ capture: true, files: ['a.png'], open: '4' })).toBe('publish');
  });

  it('closes an open PR when a capture found nothing, and updates it when none ran', () => {
    expect(plan({ capture: true, files: [], open: '4' })).toBe('close');
    expect(plan({ capture: false, files: [], open: '4' })).toBe('update');
  });

  it('does nothing with no open PR and nothing new', () => {
    expect(plan({ capture: true, files: [], open: '' })).toBe('none');
    expect(plan({ capture: false, files: [], open: '' })).toBe('none');
  });
});

describe('prBody', () => {
  const body = prBody({
    repo: 'o/r',
    dir: 'docs/screenshots',
    base: BASE,
    head: HEAD,
    files: ['map.png', 'explore.png'],
    source: 'a local production build',
    runUrl: 'https://run/7',
  });

  it('shows each replaced screenshot before and after, linked by commit', () => {
    expect(body).toContain(
      `| \`map.png\` | <img src="https://raw.githubusercontent.com/o/r/${BASE}/docs/screenshots/map.png" width="300"> | <img src="https://raw.githubusercontent.com/o/r/${HEAD}/docs/screenshots/map.png" width="300"> |`,
    );
    expect(body).toContain('`explore.png`');
  });

  it('says where they came from and follows the PR template', () => {
    expect(body).toMatch(
      /^The README's screenshots no longer matched the app at aaaaaaa, so they were taken again from a local production build \(\[run\]\(https:\/\/run\/7\)\)\. Only screenshots where over 0\.5% of the pixels changed are replaced\./,
    );
    expect(body).toContain('## Visual changes');
    expect(body).toContain('- [ ] No visible UI change');
    expect(body).toContain('## Validation');
  });

  it('names the PR they came from, and leaves out a run there is none of', () => {
    const local = prBody({
      repo: 'o/r',
      dir: 'd',
      base: BASE,
      head: HEAD,
      files: ['x.png'],
      source: 'the E2E shots',
      sourcePr: '190',
    });
    expect(local).toContain('taken again from the E2E shots, for #190. Only');
    expect(local).not.toContain('[run]');
  });
});

/**
 * A fake git and gh: answers `pr list` with `open` (then, after a create,
 * with 12), `rev-parse` with BASE then HEAD; records every call.
 *
 * @param {{ open?: string, fail?: { when: RegExp, message: string } }} [options]
 */
function fake({ open = '', fail } = {}) {
  const calls = /** @type {{ command: string, args: string[], input?: string }[]} */ ([]);
  let revs = 0;
  let created = false;
  /** @type {import('./publish.mjs').Run} */
  const run = (command, args, input) => {
    calls.push({ command, args, input });
    const line = `${command} ${args.join(' ')}`;
    if (fail && fail.when.test(line)) throw new Error(`Command failed: ${line}\n${fail.message}`);
    if (args[0] === 'pr' && args[1] === 'list') return created ? '12\n' : `${open}\n`;
    if (args[0] === 'pr' && args[1] === 'create') created = true;
    if (args[0] === 'rev-parse') return `${revs++ === 0 ? BASE : HEAD}\n`;
    return '';
  };
  return { run, calls };
}

function app() {
  const root = mkdtempSync(path.join(tmpdir(), 'publish-'));
  mkdirSync(path.join(root, 'docs', 'screenshots'), { recursive: true });
  const shots = mkdtempSync(path.join(tmpdir(), 'shots-'));
  writeFileSync(path.join(shots, 'map.png'), 'new map');
  return { root, shots };
}

const env = { GITHUB_REPOSITORY: 'o/r', CAPTURE: 'true', RUN_URL: 'https://run/1' };

describe('main', () => {
  it('commits the changed shots on a fresh branch, opens the PR and turns on auto-merge', () => {
    const { root, shots } = app();
    const { run, calls } = fake();
    expect(main({ ...env, CHANGED: 'map.png', SHOTS: shots }, run, root)).toBe(
      'Opened #12 with map.png.',
    );
    expect(readFileSync(path.join(root, 'docs/screenshots/map.png'), 'utf8')).toBe('new map');
    const lines = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(lines).toContain('git switch -C bot/readme-screenshots');
    expect(lines).toContain('git add -- docs/screenshots/map.png');
    expect(lines).toContain('git push --force origin bot/readme-screenshots');
    expect(lines.find((l) => l.startsWith('git -c user.name=github-actions[bot]'))).toContain(
      'commit -q -m Refresh the README screenshots -m The app',
    );
    const create = calls.find((c) => c.args[1] === 'create');
    expect(create?.args).toEqual(
      expect.arrayContaining(['--base', 'main', '--head', 'bot/readme-screenshots']),
    );
    expect(create?.input).toContain(`/o/r/${HEAD}/docs/screenshots/map.png`);
    expect(create?.input).toContain(`/o/r/${BASE}/docs/screenshots/map.png`);
    expect(lines.at(-1)).toBe('gh pr merge 12 --repo o/r --auto --squash');
  });

  it('rewrites the open PR rather than opening another', () => {
    const { root, shots } = app();
    const { run, calls } = fake({ open: '4' });
    expect(main({ ...env, CHANGED: 'map.png', SHOTS: shots, SOURCE_PR: '9' }, run, root)).toBe(
      'Updated #4 with map.png.',
    );
    const edit = calls.find((c) => c.args[1] === 'edit');
    expect(edit?.args).toEqual(['pr', 'edit', '4', '--repo', 'o/r', '--body-file', '-']);
    expect(edit?.input).toContain(', for #9');
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false);
  });

  it('needs the folder of shots to publish', () => {
    expect(() => main({ ...env, CHANGED: 'map.png' }, fake().run, app().root)).toThrow('SHOTS');
  });

  it('closes a stale PR, deleting its branch', () => {
    const { run, calls } = fake({ open: '4' });
    expect(main(env, run, app().root)).toBe('Closed #4: its screenshots are out of date.');
    expect(calls.at(-1)?.args.slice(0, 5)).toEqual(['pr', 'close', '4', '--repo', 'o/r']);
    expect(calls.at(-1)?.args).toContain('--delete-branch');
  });

  it('brings an open PR up to date when nothing was taken, already being so is fine', () => {
    const { run, calls } = fake({ open: '4' });
    expect(main({ ...env, CAPTURE: 'false' }, run, app().root)).toBe(
      'Brought #4 up to date with main.',
    );
    expect(calls.at(-1)?.args).toEqual(['pr', 'update-branch', '4', '--repo', 'o/r', '--rebase']);
    expect(
      main(
        { ...env, CAPTURE: 'false' },
        fake({ open: '4', fail: { when: /update-branch/, message: 'Already up-to-date' } }).run,
        app().root,
      ),
    ).toBe('Brought #4 up to date with main.');
  });

  it('fails when bringing it up to date fails otherwise', () => {
    expect(() =>
      main(
        { ...env, CAPTURE: 'false' },
        fake({ open: '4', fail: { when: /update-branch/, message: 'no permission' } }).run,
        app().root,
      ),
    ).toThrow('no permission');
  });

  it('does nothing with no open PR and nothing new', () => {
    const { run, calls } = fake();
    expect(main(env, run, app().root)).toBe('No open bot PR and nothing to replace.');
    expect(calls).toHaveLength(1);
  });
});
