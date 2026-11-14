import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_REPOS, main, parseArgs } from './cli.mjs';
import { emptyRepo, fakeGitHub, issue, pictureRepo } from './test-fakes.mjs';

describe('parseArgs', () => {
  it('reads every flag, and adds the app to the repos read', () => {
    expect(
      parseArgs([
        'upload',
        '--repo',
        'o/app',
        '--state',
        's',
        '--repos',
        'o/a, o/b',
        '--host',
        '12',
        '--include-others',
        '--minutes',
        '5',
        '--branch',
        'pics',
        '--legacy',
        'old',
      ]),
    ).toEqual({
      step: 'upload',
      repo: 'o/app',
      state: 's',
      repos: ['o/app', 'o/a', 'o/b'],
      branch: 'pics',
      legacy: 'old',
      host: 12,
      includeOthers: true,
      minutes: 5,
    });
    const defaults = parseArgs(['plan', '--repo', 'jbhirsh/sift', '--state', 's']);
    expect(defaults).toMatchObject({
      repos: ALL_REPOS,
      branch: 'screenshots',
      legacy: 'pr-screenshots',
      host: null,
      minutes: 300,
    });
  });

  it.each([
    [['delete'], /usage/],
    [['plan', 'x'], /unexpected "x"/],
    [['plan', '--repo'], /needs a value/],
    [['plan', '--nope', '1'], /unknown --nope/],
    [['plan', '--repo', 'app'], /owner\/name/],
    [['plan', '--repo', 'o/a'], /--state/],
    [['plan', '--repo', 'o/a', '--state', 's', '--repos', 'bad'], /"bad" in --repos/],
    [['plan', '--repo', 'o/a', '--state', 's', '--branch', 'a b'], /isn't a branch name/],
    [['plan', '--repo', 'o/a', '--state', 's', '--host', '#3'], /PR number/],
    [['upload', '--repo', 'o/a', '--state', 's'], /upload needs --host/],
    [['plan', '--repo', 'o/a', '--state', 's', '--minutes', 'x'], /minutes/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('main', () => {
  it('runs inventory then plan in one state, writing the plan to the step summary', async () => {
    const origin = pictureRepo();
    const app = emptyRepo();
    app.issues.push(
      issue(
        'o/app',
        1,
        `![](https://raw.githubusercontent.com/o/app/${origin.tip}/carousel/a.png)`,
      ),
    );
    const { fetch } = fakeGitHub({ 'o/app': app });
    const state = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-cli-'));
    const summary = path.join(state, '..', `${path.basename(state)}.summary.md`);
    writeFileSync(summary, '');
    const env = { GITHUB_RUN_ID: '42', GITHUB_STEP_SUMMARY: summary, GH_TOKEN: '' };
    const common = ['--repo', 'o/app', '--state', state, '--repos', 'o/app'];
    const context = { env, fetch, log: () => {}, remote: origin.dir };
    expect(await main(['inventory', ...common], context)).toBe(0);
    await expect(main(['inventory', ...common], context)).rejects.toThrow(
      /already has an inventory/,
    );
    expect(await main(['plan', ...common, '--host', '9'], context)).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('| Distinct pictures to upload | 1 ');
    const meta = JSON.parse(readFileSync(path.join(state, 'meta.json'), 'utf8'));
    expect(
      meta.runs.map((/** @type {{ step: string; run: string }} */ r) => [r.step, r.run]),
    ).toEqual([
      ['inventory', '42'],
      ['plan', '42'],
    ]);
    await expect(main(['plan', '--repo', 'o/other', '--state', state], context)).rejects.toThrow(
      /this state is o\/app's/,
    );
  });

  it("reads a relative state from the working folder, and keeps the run's writes", async () => {
    const origin = pictureRepo();
    const { fetch } = fakeGitHub({ 'o/app': emptyRepo() });
    const dir = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-cwd-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const context = { env: {}, fetch, log: () => {}, remote: origin.dir };
      expect(
        await main(
          ['inventory', '--repo', 'o/app', '--state', 'state', '--repos', 'o/app'],
          context,
        ),
      ).toBe(0);
      expect(readFileSync(path.join(dir, 'state/writes.json'), 'utf8')).toBe(
        '{"times":[],"next":0}\n',
      );
      expect(readFileSync(path.join(dir, 'state/pictures.bundle')).length).toBeGreaterThan(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('says to pass the run before, for a step with no state', async () => {
    const state = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-cli-'));
    await expect(
      main(['verify', '--repo', 'o/app', '--state', state], { env: {} }),
    ).rejects.toThrow(/pass the run before it as from-run/);
  });
});
