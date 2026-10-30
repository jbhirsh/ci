import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRANCH, addRun, indexPage, prune, publish, runsIn } from './publish.mjs';

const NOW = Date.parse('2026-10-29T12:00:00Z');
/** @type {string[]} */
const made = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'publish-test-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A folder of downloaded artifacts: each name's report.html.
 *
 * @param {Record<string, string | null>} artifacts null for one with no report
 */
function downloads(artifacts) {
  const dir = temp();
  for (const [name, html] of Object.entries(artifacts)) {
    mkdirSync(path.join(dir, name));
    if (html !== null) writeFileSync(path.join(dir, name, 'report.html'), html);
  }
  return dir;
}

/**
 * A run's facts.
 *
 * @param {number} id
 * @param {string} created
 */
const meta = (id, created) => ({
  id,
  number: id,
  workflow: 'CI',
  branch: 'main',
  sha: 'abcdef1234',
  created,
  url: `https://gh/run/${id}`,
});

describe('addRun and runsIn', () => {
  it("puts each job's report at runs/<run>/<job>/, with the run's facts, merging with what's there", () => {
    const site = temp();
    const dl = downloads({
      'job-summary-check': '<p>check</p>',
      'job-summary-e2e': '<p>e2e</p>',
      'job-summary-none': null,
      other: '<p>x</p>',
    });
    expect(addRun(site, dl, meta(7, '2026-10-29T10:00:00Z'))).toEqual(['check', 'e2e']);
    expect(readFileSync(path.join(site, 'runs/7/check/index.html'), 'utf8')).toBe('<p>check</p>');
    expect(
      addRun(site, downloads({ 'job-summary-audit': '<p>a</p>' }), meta(7, '2026-10-29T10:00:00Z')),
    ).toEqual(['audit']);
    expect(runsIn(site).map((r) => r.jobs)).toEqual([['audit', 'check', 'e2e']]);
    expect(addRun(site, downloads({}), meta(8, '2026-10-29T11:00:00Z'))).toEqual([]);
  });

  it('lists runs newest first, skipping one with unreadable facts, and none in an empty site', () => {
    const site = temp();
    expect(runsIn(site)).toEqual([]);
    addRun(site, downloads({ 'job-summary-a': 'x' }), meta(1, '2026-10-28T10:00:00Z'));
    addRun(site, downloads({ 'job-summary-a': 'x' }), meta(2, '2026-10-29T10:00:00Z'));
    mkdirSync(path.join(site, 'runs/3'));
    writeFileSync(path.join(site, 'runs/3/meta.json'), 'not json');
    expect(runsIn(site).map((r) => r.id)).toEqual([2, 1]);
  });
});

describe('prune', () => {
  it('deletes runs older than the days kept, or with no facts to date them by', () => {
    const site = temp();
    addRun(site, downloads({ 'job-summary-a': 'x' }), meta(1, '2026-09-01T10:00:00Z'));
    addRun(site, downloads({ 'job-summary-a': 'x' }), meta(2, '2026-10-28T10:00:00Z'));
    mkdirSync(path.join(site, 'runs/3'));
    expect(prune(site, 30, NOW).sort()).toEqual(['1', '3']);
    expect(readdirSync(path.join(site, 'runs'))).toEqual(['2']);
    expect(prune(temp(), 30, NOW)).toEqual([]);
  });
});

describe('indexPage', () => {
  it("links each run's job reports, newest first, escaping what came from outside", () => {
    const page = indexPage('jbhirsh/sift', [
      { ...meta(2, '2026-10-29T10:00:00Z'), branch: '<b>x</b>', jobs: ['check', 'e2e'] },
    ]);
    expect(page).toContain('<title>Job reports · jbhirsh/sift</title>');
    expect(page).toContain('<a href="runs/2/check/">check</a><a href="runs/2/e2e/">e2e</a>');
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt; · abcdef1 · 2026-10-29 10:00 UTC');
    expect(indexPage('a/b', [])).toContain('No reports yet.');
  });
});

describe('publish', () => {
  /**
   * A bare repository standing in for GitHub, and a run of commands that
   * answers gh from the given artifacts and passes git through.
   *
   * @param {Record<string, string | null>} artifacts
   * @param {{ failPushes?: number, noArtifacts?: boolean }} [opts]
   */
  function setup(artifacts, opts = {}) {
    const remote = temp();
    execFileSync('git', ['init', '-q', '--bare', remote]);
    let failures = opts.failPushes ?? 0;
    /** @type {string[][]} */
    const calls = [];
    /** @type {Record<string, string>[]} */
    const envs = [];
    /** @type {import('./publish.mjs').Run} */
    const run = (args, cwd, extra = {}) => {
      calls.push(args);
      envs.push(extra);
      if (args[0] === 'gh' && args[1] === 'run') {
        if (opts.noArtifacts) throw new Error('no artifacts');
        const dir = args[args.indexOf('--dir') + 1];
        for (const [name, html] of Object.entries(artifacts)) {
          mkdirSync(path.join(dir, name), { recursive: true });
          if (html !== null) writeFileSync(path.join(dir, name, 'report.html'), html);
        }
        return '';
      }
      if (args[0] === 'gh') {
        return JSON.stringify({
          run_number: 77,
          name: 'CI',
          head_branch: 'feat',
          head_sha: 'abcdef1234',
          created_at: '2026-10-29T11:00:00Z',
          html_url: 'https://gh/run/77',
        });
      }
      if (args.includes('push') && failures > 0) {
        failures--;
        throw new Error('stale info');
      }
      return execFileSync(args[0], args.slice(1), {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...extra, GIT_TERMINAL_PROMPT: '0' },
      });
    };
    const env = {
      GITHUB_REPOSITORY: 'jbhirsh/sift',
      RUN_ID: '77',
      GH_TOKEN: 'token',
      REMOTE: remote,
    };
    const tree = () =>
      execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', BRANCH], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    const parents = () =>
      execFileSync('git', ['-C', remote, 'rev-list', '--count', BRANCH], {
        encoding: 'utf8',
      }).trim();
    return { env, run, calls, envs, tree, parents };
  }

  it('starts the branch with the run, its index and no history', () => {
    const s = setup({ 'job-summary-check': '<p>check</p>' });
    expect(publish(s.env, s.run, NOW)).toBe('Published 1 report for run 77: check.');
    expect(s.tree()).toEqual([
      '.nojekyll',
      'index.html',
      'runs/77/check/index.html',
      'runs/77/meta.json',
    ]);
    expect(s.parents()).toBe('1');
    expect(s.calls.some((c) => c.some((arg) => arg.includes('AUTHORIZATION')))).toBe(false);
    expect(s.envs.some((e) => e.GIT_CONFIG_VALUE_0?.startsWith('AUTHORIZATION: basic '))).toBe(
      true,
    );
  });

  it('adds a later run beside the earlier ones, still as one commit', () => {
    const first = setup({ 'job-summary-check': '<p>1</p>' });
    publish(first.env, first.run, NOW);
    const second = setup({ 'job-summary-check': '<p>2</p>', 'job-summary-e2e': '<p>e</p>' });
    const env = { ...second.env, REMOTE: first.env.REMOTE, RUN_ID: '78' };
    expect(publish(env, second.run, NOW)).toBe('Published 2 reports for run 77: check, e2e.');
    expect(first.tree()).toContain('runs/77/check/index.html');
    expect(first.tree()).toContain('runs/78/e2e/index.html');
    expect(first.parents()).toBe('1');
  });

  it('tries again when another publish got there first, and gives up after its tries', () => {
    const retried = setup({ 'job-summary-check': 'x' }, { failPushes: 2 });
    expect(publish(retried.env, retried.run, NOW)).toContain('Published 1 report');
    expect(retried.calls.filter((c) => c.includes('push'))).toHaveLength(3);
    const stuck = setup({ 'job-summary-check': 'x' }, { failPushes: 9 });
    expect(() => publish(stuck.env, stuck.run, NOW)).toThrow('stale info');
  });

  it('publishes nothing for a run with no reports', () => {
    const none = setup({}, { noArtifacts: true });
    expect(publish(none.env, none.run, NOW)).toBe('Run 77 has no job reports.');
    const empty = setup({ 'job-summary-check': null });
    expect(publish(empty.env, empty.run, NOW)).toBe('Run 77 has no job reports.');
    expect(existsSync(path.join(empty.env.REMOTE, 'refs/heads', BRANCH))).toBe(false);
  });

  it('reads artifacts already downloaded inside the run, never asking gh for them', () => {
    const s = setup({});
    const artifacts = temp();
    mkdirSync(path.join(artifacts, 'job-summary-check'));
    writeFileSync(path.join(artifacts, 'job-summary-check', 'report.html'), '<p>in run</p>');
    expect(publish({ ...s.env, ARTIFACTS: artifacts }, s.run, NOW)).toBe(
      'Published 1 report for run 77: check.',
    );
    expect(s.calls.some((c) => c[0] === 'gh' && c[1] === 'run')).toBe(false);
    expect(s.tree()).toContain('runs/77/check/index.html');
    const empty = temp();
    expect(publish({ ...s.env, ARTIFACTS: empty }, s.run, NOW)).toBe('Run 77 has no job reports.');
    const missing = path.join(empty, 'nope');
    expect(publish({ ...s.env, ARTIFACTS: missing }, s.run, NOW)).toBe(
      'Run 77 has no job reports.',
    );
  });

  it('needs the repository and a run id', () => {
    expect(() => publish({ RUN_ID: 'x', GITHUB_REPOSITORY: 'a/b' })).toThrow(
      'GITHUB_REPOSITORY and RUN_ID are needed',
    );
  });
});
