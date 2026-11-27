// cli.mjs, the entry the apps' `npm run gif` runs by path: run as Node runs
// it, it loads cli.ts (Node stripping its types) and hands a failure back as
// a message and exit code 1.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTRY = fileURLToPath(new URL('./cli.mjs', import.meta.url));

// In this process, cli.ts's main is a stand-in, so importing the entry runs
// only the entry's own lines.
const main = vi.hoisted(() => vi.fn());
vi.mock('./cli.ts', () => ({ main }));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cli.mjs', () => {
  it('hands main the arguments after the script, and says why it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    main.mockRejectedValueOnce(new Error('no button', { cause: new Error('timed out') }));
    await import('./cli.mjs');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(main).toHaveBeenCalledWith(process.argv.slice(2));
    expect(error.mock.calls).toEqual([['no button'], ['timed out']]);
  });

  it('prints a failure that is no Error as it is', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    main.mockRejectedValueOnce('stopped');
    await import('./cli.mjs');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error.mock.calls).toEqual([['stopped']]);
  });

  it("runs cli.ts's main and fails with its message and exit code 1", () => {
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
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});
