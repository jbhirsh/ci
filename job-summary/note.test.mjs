import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, thisMachine } from './note.mjs';

const machine = () => ({ cores: 2, memory: 7 * 2 ** 30, node: 'v24.0.0' });

/** A fresh RUNNER_TEMP, and where the notes go in it. */
function runnerTemp() {
  const temp = mkdtempSync(path.join(tmpdir(), 'note-'));
  return { temp, file: path.join(temp, 'job-summary', 'notes.json') };
}

/** @param {string} file */
const read = (file) => Object.entries(JSON.parse(readFileSync(file, 'utf8')));

describe('note main', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});

  it('notes the machine first, then each call merges its notes in', () => {
    const { temp, file } = runnerTemp();
    const env = { RUNNER_TEMP: temp, ImageOS: 'macos15', ImageVersion: '20261020.1' };
    expect(main({ ...env, NOTES: 'Xcode: 26.0\nSimulator: iPhone 17 Pro' }, machine)).toEqual([
      `Noted Runner image, Cores, Memory, Node, Xcode, Simulator in ${file}`,
    ]);
    main({ ...env, NOTES: 'Xcode: 26.1\nMaestro: 2.1.0' }, () => {
      throw new Error('asked about the machine again');
    });
    expect(read(file)).toEqual([
      ['Runner image', 'macos15 20261020.1'],
      ['Cores', '2'],
      ['Memory', '7 GB'],
      ['Node', 'v24.0.0'],
      ['Xcode', '26.1'],
      ['Simulator', 'iPhone 17 Pro'],
      ['Maestro', '2.1.0'],
    ]);
  });

  it('notes only the machine with no notes, and says which lines it left out', () => {
    const { temp, file } = runnerTemp();
    expect(main({ RUNNER_TEMP: temp, NOTES: 'just words\nA: b' }, machine)).toEqual([
      '::warning::job-summary/note: "just words" isn\'t a "Label: value" line; left out',
      `Noted Cores, Memory, Node, A in ${file}`,
    ]);
    const again = main({ RUNNER_TEMP: temp }, machine);
    expect(again).toEqual([`Noted nothing in ${file}`]);
  });

  it('warns rather than failing, without RUNNER_TEMP or when the file is out of reach', () => {
    expect(main({ NOTES: 'A: b' }, machine)).toEqual([
      '::warning::job-summary/note: RUNNER_TEMP is not set, so there is nowhere to note',
    ]);
    const { temp } = runnerTemp();
    // A folder where the notes file would go: it can't be read or replaced.
    mkdirSync(path.join(temp, 'job-summary', 'notes.json'), { recursive: true });
    const [said] = main({ RUNNER_TEMP: temp, NOTES: 'A: b' }, machine);
    expect(said).toMatch(/^::warning::job-summary\/note: /);
  });

  it('starts afresh from notes that were not JSON', () => {
    const { temp, file } = runnerTemp();
    mkdirSync(path.dirname(file));
    writeFileSync(file, 'garbage');
    main({ RUNNER_TEMP: temp, NOTES: 'A: b' }, machine);
    expect(read(file)).toEqual([['A', 'b']]);
  });
});

describe('thisMachine', () => {
  it("reads this process's cores, memory and Node", () => {
    const m = thisMachine();
    expect(m.cores).toBeGreaterThan(0);
    expect(m.memory).toBeGreaterThan(0);
    expect(m.node).toBe(process.version);
  });
});
