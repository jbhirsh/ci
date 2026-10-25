import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selftest } from './selftest.mjs';
import { testApp } from './testApp.mjs';

describe('selftest', () => {
  it('passes an app with no settings, against the defaults', () => {
    expect(selftest(testApp({})).join('\n')).toContain('checked against the defaults');
  });

  it('passes an app whose guide and skip globs hold up', () => {
    const root = testApp({
      '.github/ci.json': '{"review": {"instructions": "g.md", "skip": ["src/gql/**"]}}',
      'g.md': '## Auth',
      'src/gql/graphql.ts': '',
    });
    const log = selftest(root).join('\n');
    expect(log).toContain('guide g.md');
    expect(log).toContain('each matches a tracked file');
    expect(log).toContain('fixture transcripts are judged as expected');
  });

  it('fails a skip glob that matches nothing', () => {
    const root = testApp({ '.github/ci.json': '{"review": {"skip": ["gone/**"]}}' });
    expect(() => selftest(root)).toThrow('"gone/**" matches no tracked file');
  });

  it('skips the glob check outside a git checkout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plain-'));
    writeFileSync(path.join(root, 'package.json'), '{}');
    expect(selftest(root).join('\n')).not.toContain('each matches');
  });

  it("fails a skip glob that would hide the fixtures' test file", () => {
    const root = testApp({
      '.github/ci.json': '{"review": {"skip": ["__tests__/**"]}}',
      '__tests__/x.ts': '',
    });
    expect(() => selftest(root)).toThrow('stat-only.json left');
  });
});
