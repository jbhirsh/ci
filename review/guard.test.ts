import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGuard, normalUrl, resolved } from './guard.ts';

let repo: string;
let ci: string;

beforeAll(() => {
  const top = mkdtempSync(path.join(tmpdir(), 'review-guard-'));
  repo = path.join(top, 'app');
  ci = path.join(top, 'ci');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(ci);
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'a');
  writeFileSync(path.join(top, 'secret'), 's');
  symlinkSync(path.join(top, 'secret'), path.join(repo, 'link'));
});

const guard = () => createGuard({ roots: [repo, ci], cwd: repo, maxSearches: 2 });

describe('createGuard', () => {
  it('allows its own tools and ToolSearch, and nothing unknown', () => {
    const g = guard();
    expect(g.before('mcp__review__diff', {})).toEqual({ allow: true });
    expect(g.before('mcp__github_inline_comment__create_inline_comment', {})).toEqual({
      allow: true,
    });
    expect(g.before('ToolSearch', {})).toEqual({ allow: true });
    for (const tool of ['Bash', 'Edit', 'Write', 'Agent', 'mcp__other__x', 'NotebookEdit']) {
      expect(g.before(tool, { command: 'ls' }).allow).toBe(false);
    }
  });
  it('reads only inside the roots, through symlinks too', () => {
    const g = guard();
    expect(g.before('Read', { file_path: path.join(repo, 'src', 'a.ts') }).allow).toBe(true);
    expect(g.before('Read', { file_path: 'src/a.ts' }).allow).toBe(true);
    expect(g.before('Read', { file_path: path.join(ci, 'x.md') }).allow).toBe(true);
    for (const file_path of [
      '/proc/self/environ',
      path.join(repo, '..', 'secret'),
      path.join(repo, 'link'),
      `${repo}-other/x`,
      '',
    ]) {
      expect(g.before('Read', { file_path }).allow).toBe(false);
    }
    expect(g.before('Read', {}).allow).toBe(false);
  });
  it('greps and globs only inside the roots', () => {
    const g = guard();
    expect(g.before('Grep', { pattern: 'x' }).allow).toBe(true);
    expect(g.before('Grep', { pattern: 'x', path: '/etc' }).allow).toBe(false);
    expect(g.before('Glob', { pattern: 'src/**/*.ts' }).allow).toBe(true);
    expect(g.before('Glob', { pattern: '/etc/*' }).allow).toBe(false);
    expect(g.before('Glob', { pattern: '../*' }).allow).toBe(false);
    expect(g.before('Glob', { pattern: '{..,src}/*' }).allow).toBe(false);
    expect(g.before('Glob', { pattern: '*', path: '/' }).allow).toBe(false);
  });
  it('caps searches, and fetches only URLs it was shown', () => {
    const g = guard();
    expect(g.before('WebSearch', { query: 'a' }).allow).toBe(true);
    expect(g.before('WebSearch', { query: 'b' }).allow).toBe(true);
    expect(g.before('WebSearch', { query: 'c' })).toEqual({
      allow: false,
      reason: 'at most 2 searches a pass',
    });
    const url = 'https://docs.example.com/page';
    expect(g.before('WebFetch', { url }).allow).toBe(false);
    g.after('WebSearch', { results: [{ url: `${url}/` }] });
    expect(g.before('WebFetch', { url: `${url}#part` }).allow).toBe(true);
    g.after('Read', `see https://evil.example/x`);
    expect(g.before('WebFetch', { url: 'https://evil.example/x' }).allow).toBe(false);
    g.after('mcp__review__pr', 'the description links https://spec.example/a.');
    expect(g.before('WebFetch', { url: 'https://spec.example/a' }).allow).toBe(true);
    expect(g.before('WebFetch', { url: 'file:///etc/passwd' }).allow).toBe(false);
  });
});

describe('helpers', () => {
  it('resolves a path that does not exist yet by its folder', () => {
    expect(resolved('src/new.ts', repo)).toBe(path.join(resolved(repo, '/'), 'src', 'new.ts'));
    expect(resolved('/no/such/place', '/')).toBe('/no/such/place');
  });
  it('compares URLs without fragments, trailing slashes or punctuation', () => {
    expect(normalUrl('https://a.b/c/#x')).toBe('https://a.b/c');
    expect(normalUrl('https://a.b/c.')).toBe('https://a.b/c');
  });
});
