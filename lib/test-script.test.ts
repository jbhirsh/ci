import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importOnly, runAsScript } from './test-script.ts';

type Seen = { argv: string[]; env: Record<string, string | undefined>; exitCode: unknown };

/**
 * A script that records what it saw on globalThis.seen at each import, then
 * sets the exit code its EXIT variable names (the string itself, as an env
 * value is; none when unset) and throws when THROW is set.
 */
function script(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'test-script-')), 'script.mjs');
  writeFileSync(
    file,
    [
      'globalThis.seen = [...(globalThis.seen ?? []),',
      '  { argv: [...process.argv], env: { ...process.env }, exitCode: process.exitCode }];',
      'if (process.env.EXIT !== undefined) process.exitCode = process.env.EXIT;',
      "if (process.env.THROW) throw new Error('thrown at import');",
      '',
    ].join('\n'),
  );
  return file;
}

const seen = () => (globalThis as { seen?: Seen[] }).seen ?? [];

describe('runAsScript', () => {
  it('runs the file as node would, with only the env given, and puts everything back', async () => {
    const file = script();
    const before = {
      argv: process.argv,
      env: process.env,
      values: { ...process.env },
      exitCode: process.exitCode,
    };
    process.exitCode = 7;
    try {
      const env = { PATH: '/bin', EXIT: '3', UNSET: undefined };
      expect(await runAsScript(file, ['check', '--issue'], env)).toBe(3);
      expect(seen().at(-1)).toStrictEqual({
        argv: [process.execPath, file, 'check', '--issue'],
        // This test file's TMPDIR kept (lib/test-tmpdir.ts), and nothing else.
        env: { TMPDIR: before.values.TMPDIR, PATH: '/bin', EXIT: '3' },
        exitCode: undefined,
      });
      expect(process.argv).toBe(before.argv);
      expect(process.env).toBe(before.env);
      expect({ ...process.env }).toStrictEqual(before.values);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = before.exitCode;
    }
  });

  it('returns 0 when the script sets no exit code, as Node exits', async () => {
    expect(await runAsScript(script(), [], { PATH: '/bin' })).toBe(0);
  });

  it("takes a TMPDIR given in place of the test file's", async () => {
    await runAsScript(script(), [], { TMPDIR: '/elsewhere' });
    expect(seen().at(-1)?.env).toStrictEqual({ TMPDIR: '/elsewhere' });
  });

  it("keeps Node's env, which holds every value as a string", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'test-script-')), 'env.mjs');
    writeFileSync(
      file,
      'process.env.COUNT = 1;\nprocess.exitCode = process.env.COUNT === "1" ? 0 : 9;\n',
    );
    expect(await runAsScript(file, [], {})).toBe(0);
    expect(process.env.COUNT).toBe(undefined);
  });

  it('imports afresh each time, so the top level runs again', async () => {
    const file = script();
    const count = seen().length;
    await runAsScript(file, [], {});
    await runAsScript(file, [], {});
    expect(seen().length).toBe(count + 2);
  });

  it('puts everything back when the script throws', async () => {
    const before = {
      argv: process.argv,
      env: process.env,
      values: { ...process.env },
      exitCode: process.exitCode,
    };
    await expect(runAsScript(script(), [], { THROW: '1', EXIT: '4' })).rejects.toThrow(
      'thrown at import',
    );
    expect(process.argv).toBe(before.argv);
    expect(process.env).toBe(before.env);
    expect({ ...process.env }).toStrictEqual(before.values);
    expect(process.exitCode).toBe(before.exitCode);
  });
});

describe('importOnly', () => {
  it("imports afresh with this process's argv and env, and returns the exit code it set", async () => {
    const file = script();
    const before = { argv: process.argv, env: process.env, exitCode: process.exitCode };
    process.exitCode = 7;
    try {
      expect(await importOnly(file)).toBe(undefined);
      expect(seen().at(-1)).toEqual({
        argv: before.argv,
        env: { ...before.env },
        exitCode: undefined,
      });
      expect(process.argv).toBe(before.argv);
      expect(process.env).toBe(before.env);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = before.exitCode;
    }
    process.env.EXIT = '5';
    try {
      expect(await importOnly(file)).toBe(5);
    } finally {
      delete process.env.EXIT;
    }
  });
});
