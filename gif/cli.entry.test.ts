// cli.ts's command line, the path the apps' `npm run gif` runs: run as Node
// runs it, it calls main (Node stripping its types) and hands a failure back
// as a message and exit code 1; imported, it runs nothing.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEntry } from './cli.ts';

const ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url));

// A stand-in for cli.ts's main, so only the entry's own lines run.
const main = vi.fn();

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  main.mockReset();
});

describe('cli.ts as a script', () => {
  it('hands main the arguments after the script, and says why it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    main.mockRejectedValueOnce(new Error('no button', { cause: new Error('timed out') }));
    await runEntry(process.argv.slice(2), main);
    expect(process.exitCode).toBe(1);
    expect(main).toHaveBeenCalledWith(process.argv.slice(2));
    expect(error.mock.calls).toEqual([['no button'], ['timed out']]);
  });

  it('prints a failure that is no Error as it is', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    main.mockRejectedValueOnce('stopped');
    await runEntry([], main);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls).toEqual([['stopped']]);
  });

  it('leaves the exit code alone when main succeeds', async () => {
    main.mockResolvedValueOnce(undefined);
    await runEntry(['flow.ts'], main);
    expect(process.exitCode).toBeUndefined();
  });

  it('runs main on the arguments after the script, and fails with its message and exit code 1', () => {
    const app = mkdtempSync(path.join(tmpdir(), 'gif-entry-'));
    try {
      const result = spawnSync(process.execPath, [ENTRY], {
        cwd: app,
        env: { ...process.env, APP_ROOT: app },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('one scenario, please');
      expect(result.stderr).toContain('usage: gif <scenario>');
      // The scenario is taken, so main got the arguments after the script.
      const option = spawnSync(process.execPath, [ENTRY, 'flow.ts', '--nope'], {
        cwd: app,
        env: { ...process.env, APP_ROOT: app },
        encoding: 'utf8',
      });
      expect(option.status).toBe(1);
      expect(option.stderr).toContain("Unknown option '--nope'");
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});
