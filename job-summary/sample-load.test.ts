import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loop, nextRow, reading, start } from './sample-load.mjs';
import { SAMPLE_MS } from './telemetry.mjs';

/** A fresh RUNNER_TEMP, and where the samples go in it. */
function runnerTemp() {
  const temp = mkdtempSync(path.join(tmpdir(), 'sample-load-'));
  return { temp, file: path.join(temp, 'job-summary', 'machine-cpu.csv') };
}

describe('reading', () => {
  /** @type {Record<string, string>} */
  const proc = {
    '/proc/loadavg': '1.25 0.9 0.8 2/300 999\n',
    '/proc/stat': 'cpu  10 0 10 70 10 0 0 0 0 0\ncpu0 1 1 1 1\n',
  };

  it("reads Linux's /proc", () => {
    expect(reading('linux', (f) => proc[f])).toEqual({ load: 1.25, cpu: { idle: 80, total: 100 } });
  });

  it("is null when /proc can't be read or doesn't read as expected", () => {
    expect(
      reading('linux', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
    expect(reading('linux', (f) => (f === '/proc/stat' ? '' : proc[f]))).toBeNull();
    expect(reading('linux', (f) => (f === '/proc/loadavg' ? '' : proc[f]))).toBeNull();
  });

  it('reads os.loadavg() and os.cpus() elsewhere', () => {
    const r = reading('darwin');
    expect(r?.load).toBeGreaterThanOrEqual(0);
    expect(r?.cpu.total).toBeGreaterThanOrEqual(r?.cpu.idle ?? Infinity);
  });
});

describe('nextRow', () => {
  const before = { load: 1, cpu: { idle: 50, total: 100 } };

  it('writes the time, the latest load and the busy share since the last reading', () => {
    expect(nextRow(before, { load: 2.5, cpu: { idle: 75, total: 200 } }, 1_700_000_000_500)).toBe(
      '1700000000,2.5,75.0',
    );
  });

  it('is null without both readings, or with no time between them', () => {
    expect(nextRow(null, before, 0)).toBeNull();
    expect(nextRow(before, null, 0)).toBeNull();
    expect(nextRow(before, before, 0)).toBeNull();
  });
});

describe('loop', () => {
  it('appends a row every SAMPLE_MS, skipping one it could not read', () => {
    const { temp } = runnerTemp();
    const file = path.join(temp, 'cpu.csv');
    writeFileSync(file, 'time,load,busy\n');
    const readings = [
      { load: 1, cpu: { idle: 0, total: 0 } },
      { load: 2, cpu: { idle: 5, total: 10 } },
      null,
      { load: 3, cpu: { idle: 5, total: 20 } },
    ];
    /** @type {(() => void)[]} */
    const timers = [];
    let now = 1_700_000_000_000;
    loop(
      file,
      () => readings.shift() ?? null,
      (fn, ms) => {
        expect(ms).toBe(SAMPLE_MS);
        timers.push(fn);
      },
      () => (now += SAMPLE_MS),
    );
    for (let i = 0; i < 3; i++) timers[i]();
    expect(readFileSync(file, 'utf8')).toBe(
      'time,load,busy\n1700000010,2,50.0\n1700000030,3,100.0\n',
    );
  });

  it("skips a row it can't write, and carries on", () => {
    /** @type {(() => void)[]} */
    const timers = [];
    let n = 0;
    loop(
      path.join(tmpdir(), 'no-such-folder-here', 'x', 'cpu.csv'),
      () => ({ load: 1, cpu: { idle: 0, total: (n += 10) } }),
      (fn) => timers.push(fn),
    );
    timers[0]();
    expect(timers).toHaveLength(2);
  });
});

describe('start', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});

  it('writes the header and starts the sampler detached, once a job', () => {
    const { temp, file } = runnerTemp();
    const child = { on: vi.fn(), unref: vi.fn() };
    const run = vi.fn(() => child);
    expect(start({ RUNNER_TEMP: temp }, run)).toBe(
      `Sampling the machine's CPU every 10 s into ${file}`,
    );
    expect(readFileSync(file, 'utf8')).toBe('time,load,busy\n');
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [fileURLToPath(new URL('./sample-load.mjs', import.meta.url)), '--loop', file],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.unref).toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(start({ RUNNER_TEMP: temp }, run)).toBe(`Already sampling into ${file}`);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('warns rather than failing, without RUNNER_TEMP or when it cannot start', () => {
    expect(start({})).toBe('::warning::job-summary/sample-load: RUNNER_TEMP is not set');
    const { temp } = runnerTemp();
    const run = () => {
      throw new Error('spawn EAGAIN');
    };
    expect(start({ RUNNER_TEMP: temp }, run)).toBe(
      '::warning::job-summary/sample-load: spawn EAGAIN',
    );
  });
});
