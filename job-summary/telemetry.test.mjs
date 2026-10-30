import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  busyPercent,
  cpusTimes,
  loadRow,
  machineNotes,
  mergeNotes,
  parseLoadavg,
  parseNoteLines,
  parseProcStat,
  telemetryFiles,
} from './telemetry.mjs';
import { parseLoad, parseNotes } from './summary.mjs';

describe('telemetryFiles', () => {
  it("puts the notes and samples in RUNNER_TEMP's job-summary folder, and nowhere without it", () => {
    expect(telemetryFiles({ RUNNER_TEMP: '/tmp/r' })).toEqual({
      dir: path.join('/tmp/r', 'job-summary'),
      notes: path.join('/tmp/r', 'job-summary', 'notes.json'),
      load: path.join('/tmp/r', 'job-summary', 'machine-cpu.csv'),
    });
    expect(telemetryFiles({})).toBeNull();
    expect(telemetryFiles({ RUNNER_TEMP: '' })).toBeNull();
  });
});

describe('parseNoteLines', () => {
  it('splits each line at its first colon, trims both sides, and skips what has no label', () => {
    expect(
      parseNoteLines(
        'Xcode: Xcode 26.1\r\n\n  Warm-up launch :  Setup up within 4 s \nURL: https://a.b/c:1\n' +
          'no colon here\n: no label\nEmpty:\n',
      ),
    ).toEqual({
      notes: [
        ['Xcode', 'Xcode 26.1'],
        ['Warm-up launch', 'Setup up within 4 s'],
        ['URL', 'https://a.b/c:1'],
        ['Empty', ''],
      ],
      skipped: ['no colon here', ': no label'],
    });
    expect(parseNoteLines('')).toEqual({ notes: [], skipped: [] });
  });
});

describe('machineNotes', () => {
  const machine = { cores: 4, memory: 16 * 2 ** 30 - 12345, node: 'v24.1.0' };

  it("names the hosted runner's image, its cores, memory and Node", () => {
    expect(machineNotes({ ImageOS: 'ubuntu24', ImageVersion: '20261020.1' }, machine)).toEqual([
      ['Runner image', 'ubuntu24 20261020.1'],
      ['Cores', '4'],
      ['Memory', '16 GB'],
      ['Node', 'v24.1.0'],
    ]);
  });

  it("leaves the image out on a runner that doesn't say it", () => {
    expect(machineNotes({}, machine).map(([label]) => label)).toEqual(['Cores', 'Memory', 'Node']);
  });
});

describe('mergeNotes', () => {
  it('keeps earlier notes in order, a label given again taking its new value', () => {
    const text = mergeNotes('{"Cores":"4","Xcode":"26.0","n":3}', [
      ['Xcode', '26.1'],
      ['Maestro', '2.1'],
    ]);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.entries(JSON.parse(text))).toEqual([
      ['Cores', '4'],
      ['Xcode', '26.1'],
      ['n', '3'],
      ['Maestro', '2.1'],
    ]);
  });

  it("starts afresh from no file, or one that isn't a JSON object", () => {
    for (const earlier of [null, 'not json', '[["a","b"]]', 'null', '"x"']) {
      expect(JSON.parse(mergeNotes(earlier, [['A', 'b']]))).toEqual({ A: 'b' });
    }
  });

  it('writes what summary.mjs reads back', () => {
    expect(parseNotes(mergeNotes(null, [['Simulator', 'iPhone 17 Pro']]))).toEqual([
      ['Simulator', 'iPhone 17 Pro'],
    ]);
  });
});

describe('parseProcStat', () => {
  const stat = `cpu  4705 150 1120 16250 520 30 45 10 99 7
cpu0 2352 75 560 8125 260 15 22 5 0 0
intr 114930548 113199788 3 0 5 263 0 4 [... lots more numbers ...]
ctxt 1990473`;

  it('reads every core together, iowait as idle, guest time not counted twice', () => {
    expect(parseProcStat(stat)).toEqual({
      idle: 16250 + 520,
      total: 4705 + 150 + 1120 + 16250 + 520 + 30 + 45 + 10,
    });
  });

  it("reads an old kernel's shorter line", () => {
    expect(parseProcStat('cpu 10 0 5 85\n')).toEqual({ idle: 85, total: 100 });
  });

  it('finds nothing without a whole cpu line', () => {
    expect(parseProcStat('cpu0 1 2 3 4\n')).toBeNull();
    expect(parseProcStat('cpu 1 2 x 4\n')).toBeNull();
    expect(parseProcStat('cpu 1 2\n')).toBeNull();
    expect(parseProcStat('')).toBeNull();
  });
});

describe('parseLoadavg', () => {
  it('reads the 1-minute load average, and nothing from what is not one', () => {
    expect(parseLoadavg('0.52 0.58 0.59 1/389 12345\n')).toBe(0.52);
    expect(parseLoadavg('')).toBeNull();
    expect(parseLoadavg('abc 1 2')).toBeNull();
    expect(parseLoadavg('-1 0 0')).toBeNull();
  });
});

describe('cpusTimes', () => {
  it("adds up every core's times", () => {
    const core = { user: 10, nice: 1, sys: 4, idle: 80, irq: 5 };
    expect(cpusTimes([{ times: core }, { times: { ...core, idle: 40 } }])).toEqual({
      idle: 120,
      total: 200 - 40,
    });
    expect(cpusTimes([])).toEqual({ idle: 0, total: 0 });
  });
});

describe('busyPercent', () => {
  it('is the share of the time between two readings that was not idle', () => {
    expect(busyPercent({ idle: 100, total: 200 }, { idle: 130, total: 300 })).toBeCloseTo(70);
    expect(busyPercent({ idle: 0, total: 0 }, { idle: 10, total: 10 })).toBe(0);
    expect(busyPercent({ idle: 0, total: 0 }, { idle: 0, total: 10 })).toBe(100);
  });

  it('stays between 0 and 100, and is null when no time passed or the counters went back', () => {
    expect(busyPercent({ idle: 0, total: 0 }, { idle: 20, total: 10 })).toBe(0);
    expect(busyPercent({ idle: 50, total: 0 }, { idle: 0, total: 10 })).toBe(100);
    expect(busyPercent({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBeNull();
    expect(busyPercent({ idle: 5, total: 10 }, { idle: 1, total: 5 })).toBeNull();
  });
});

describe('loadRow', () => {
  it('writes Unix seconds, the load to two places and busy to one, as parseLoad reads it', () => {
    expect(loadRow(1_761_800_000_999, 0.5, 42.25)).toBe('1761800000,0.5,42.3');
    expect(loadRow(1_761_800_010_000, 3.14159, 100)).toBe('1761800010,3.14,100.0');
    expect(
      parseLoad(`time,load,busy\n${loadRow(1_000_010_000, 2, 37.5)}`, 1_000_000_000, 60),
    ).toEqual([{ t: 10, load: 2, busy: 37.5 }]);
  });
});
