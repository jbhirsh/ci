import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { describeWorkflow } from '../autofix/check-triggers.ts';
import { lintGifCallers } from '../lint/gif-callers.ts';
import { APPS, CI_ROOT, loadManifest } from './manifest.ts';
import type { Entry } from './manifest.ts';

/** @param file a path in this repo */
const read = (file: string) => readFileSync(path.join(CI_ROOT, file), 'utf8');

const yml = (dir: string): string[] =>
  existsSync(path.join(CI_ROOT, dir))
    ? readdirSync(path.join(CI_ROOT, dir)).filter((f) => f.endsWith('.yml'))
    : [];

/**
 * Whether a workflow runs on `workflow_call`, in any form `on:` takes (a
 * name, a list or a mapping): the reusable ones an app calls at `@main`.
 *
 * @param text the workflow
 */
const isReusable = (text: string) =>
  describeWorkflow('x.yml', parse(text)).events.includes('workflow_call');

/**
 * The files an app could copy or call: every `<tool>/callers/*.yml`, and
 * every reusable workflow.
 */
function candidates(): string[] {
  const callers = readdirSync(CI_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules')
    .flatMap((d) => yml(`${d.name}/callers`).map((f) => `${d.name}/callers/${f}`));
  const reusable = yml('.github/workflows')
    .map((f) => `.github/workflows/${f}`)
    .filter((f) => isReusable(read(f)));
  return [...callers, ...reusable].sort();
}

describe('isReusable', () => {
  it('reads workflow_call in every form on: takes', () => {
    expect(isReusable('on: workflow_call')).toBe(true);
    expect(isReusable('on: [push, workflow_call]')).toBe(true);
    expect(isReusable('on:\n  workflow_call:\n    inputs: {}')).toBe(true);
    expect(isReusable('on:\n  push:\n  workflow_call:')).toBe(true);
    expect(isReusable('on: push')).toBe(false);
    expect(isReusable('on: [push, pull_request]')).toBe(false);
    expect(isReusable('on:\n  workflow_dispatch:')).toBe(false);
    expect(isReusable('name: no triggers')).toBe(false);
  });
});

describe('the manifest covers every canonical caller and reusable workflow', () => {
  const manifest = loadManifest();
  const synced = new Set(
    manifest.files.flatMap((f) => [f.source, ...Object.values(f.variants).map((v) => v.source)]),
  );
  const unsynced = new Set(manifest.unsynced.map((u) => u.source));

  it('lists each as synced or unsynced with a reason', () => {
    const missing = candidates().filter((f) => !synced.has(f) && !unsynced.has(f));
    expect(
      missing,
      `add each to sync/manifest.json: as a file the apps hold, or under "unsynced" with why none does:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('lists no unsynced file that does not need it', () => {
    const needed = new Set(candidates());
    const stale = [...unsynced].filter((f) => !needed.has(f));
    expect(stale, 'unsynced, but no caller or reusable workflow:').toEqual([]);
  });

  it('finds the callers and reusable workflows it is meant to', () => {
    expect(candidates()).toEqual(
      expect.arrayContaining([
        'gif/callers/pr-gif.yml',
        'sync/callers/pr-description.yml',
        '.github/workflows/job-reports.yml',
      ]),
    );
  });
});

/**
 * What a synced workflow that runs on a pull request is missing: an
 * `autofix.exempt` companion naming it, or autofix/check-triggers.ts fails
 * the app's CI for it (it is neither in claude-autofix.yml's list nor exempt).
 * A variant is read too: it may be named differently.
 *
 * @param files
 * @param text a source's content
 */
function exemptionProblems(files: Entry[], text: (source: string) => string): string[] {
  return files
    .filter((entry) => entry.path.startsWith('.github/workflows/'))
    .flatMap((entry) =>
      [entry.source, ...Object.values(entry.variants).map((v) => v.source)].flatMap((source) => {
        const workflow = describeWorkflow(path.basename(entry.path), parse(text(source)));
        if (!['pull_request', 'pull_request_target'].some((e) => workflow.events.includes(e))) {
          return [];
        }
        const key = JSON.stringify(['autofix', 'exempt', workflow.name]);
        return entry.companions.some((c) => JSON.stringify(c.key) === key)
          ? []
          : [`${entry.path} (${source}) runs on a pull request but has no companion ${key}`];
      }),
    );
}

describe('a synced workflow that runs on a pull request carries its autofix exemption', () => {
  it('holds for the manifest', () => {
    expect(exemptionProblems(loadManifest().files, read)).toEqual([]);
  });

  it('fails a workflow with no companion, or a companion for another name', () => {
    const texts = {
      'a.yml': 'name: A\non: pull_request',
      'b.yml': 'on:\n  pull_request_target:',
      'c.yml': 'name: C\non: [push, pull_request]',
      'd.yml': 'name: D\non: push',
      'v.yml': 'name: Renamed\non: pull_request',
    };
    const entry = (
      file: string,
      source: string,
      exempt?: string[],
      variants: Record<string, { source: string; why: string }> = {},
    ) => ({
      path: `.github/workflows/${file}`,
      source,
      apps: ['sift'],
      variants,
      companions: exempt ? [{ key: ['autofix', 'exempt', ...exempt], value: 'why' }] : [],
    });
    const text = (source: string) => texts[source as keyof typeof texts];
    expect(
      exemptionProblems(
        [
          entry('a.yml', 'a.yml', ['A']),
          entry('b.yml', 'b.yml'),
          entry('c.yml', 'c.yml', ['Other']),
          entry('d.yml', 'd.yml'),
          entry('a.yml', 'a.yml', ['A'], { sift: { source: 'v.yml', why: 'w' } }),
        ],
        text,
      ),
    ).toEqual([
      '.github/workflows/b.yml (b.yml) runs on a pull request but has no companion ["autofix","exempt",".github/workflows/b.yml"]',
      '.github/workflows/c.yml (c.yml) runs on a pull request but has no companion ["autofix","exempt","C"]',
      '.github/workflows/a.yml (v.yml) runs on a pull request but has no companion ["autofix","exempt","Renamed"]',
    ]);
  });

  it('ignores a file that is not a workflow', () => {
    const files = loadManifest().files.filter((f) => !f.path.startsWith('.github/workflows/'));
    expect(files).toHaveLength(1);
    expect(exemptionProblems(files, () => 'not yaml: [')).toEqual([]);
  });
});

describe('every synced workflow meets the rules the apps are held to for the PR GIF callers', () => {
  const workflows = loadManifest().files.filter((f) => f.path.startsWith('.github/workflows/'));
  const sources = workflows.flatMap((f) => [
    f.source,
    ...Object.values(f.variants).map((v) => v.source),
  ]);

  it('holds for each canonical caller and each variant', () => {
    expect(sources).toEqual(expect.arrayContaining(['gif/callers/pr-gif.yml']));
    for (const source of sources) {
      expect(lintGifCallers(source, parse(read(source))), source).toEqual([]);
    }
  });

  it('would fail a caller that gives the PR run the attach token', () => {
    const token = "${{ github.event_name == 'workflow_dispatch' && secrets.BOT_PR_TOKEN || '' }}";
    const text = read('gif/callers/pr-gif.yml');
    expect(text).toContain(token);
    const bad = text.replace(token, '${{ secrets.BOT_PR_TOKEN }}');
    expect(lintGifCallers('x.yml', parse(bad)).length).toBeGreaterThan(0);
  });
});

describe('APPS', () => {
  it("is the apps in ci.yml's Against matrix", () => {
    const ci = parse(read('.github/workflows/ci.yml'));
    expect([...ci.jobs.apps.strategy.matrix.app].sort()).toEqual([...APPS].sort());
  });
});
