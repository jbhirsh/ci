import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildModel } from '../model.ts';
import { report } from '../report.ts';
import { fixture } from './fixture.ts';
import { buildPage, main } from './page.ts';

const script = fileURLToPath(new URL('./page.ts', import.meta.url));

describe('buildPage', () => {
  it("writes the fixture's report as the folder's index.html, making the folder", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'gif-page-')), 'dist');
    expect(buildPage(out)).toBe(path.join(out, 'index.html'));
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toBe(report(buildModel(fixture())));
  });
});

describe('main', () => {
  it('builds into the folder named, saying where', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'gif-page-'));
    const lines: string[] = [];
    expect(main([out], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`job-summary: wrote ${path.join(out, 'index.html')}`]);
  });

  it('fails with no folder, building nothing', () => {
    const lines: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([], (line) => lines.push(line))).toBe(1);
    expect(error).toHaveBeenCalledWith('usage: node job-summary/gif/page.ts <out folder>');
    expect(lines).toEqual([]);
    error.mockRestore();
  });
});

describe('page.ts', () => {
  it('builds into the folder it is given, as the GIF tool runs it', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'gif-page-'));
    execFileSync(process.execPath, [script, out], { stdio: 'ignore' });
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toBe(report(buildModel(fixture())));
  });

  it('fails, saying how to run it, with no folder', () => {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/usage: node job-summary\/gif\/page\.ts <out folder>/);
  });
});
