import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOutput, summary } from './actions.mjs';

afterEach(() => {
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STEP_SUMMARY;
  vi.restoreAllMocks();
});

function tempFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gh-')), 'out');
  writeFileSync(file, '');
  return file;
}

describe('setOutput', () => {
  it('writes a multi-line safe output to GITHUB_OUTPUT', () => {
    process.env.GITHUB_OUTPUT = tempFile();
    setOutput('scope', 'a\nb');
    expect(readFileSync(process.env.GITHUB_OUTPUT, 'utf8')).toMatch(
      /^scope<<(EOF_\w+)\na\nb\n\1\n$/,
    );
  });
  it('prints outside Actions', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setOutput('run', 'true');
    expect(write).toHaveBeenCalledWith('run=true\n');
  });
});

describe('summary', () => {
  it('appends to the job summary, or prints', () => {
    process.env.GITHUB_STEP_SUMMARY = tempFile();
    summary('# hi');
    expect(readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8')).toBe('# hi\n');
    delete process.env.GITHUB_STEP_SUMMARY;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    summary('x');
    expect(write).toHaveBeenCalledWith('x\n');
  });
});
