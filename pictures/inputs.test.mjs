import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlock, parseFiles, parseInputs } from './inputs.mjs';

const env = {
  REPO: 'jbhirsh/sift',
  TARGET: '222',
  HOST_PR: '240',
  RUN_ID: '43133552506',
  ARTIFACT: 'ios-screenshots',
  FILES: 'light/before.png | Light, before\nlight/after.png | Light, after\n',
  BLOCK: '222',
};

describe('parseInputs', () => {
  it('reads every input, with the defaults for columns and width', () => {
    expect(parseInputs(env)).toEqual({
      repo: 'jbhirsh/sift',
      target: '222',
      hostPr: '240',
      runId: '43133552506',
      artifact: 'ios-screenshots',
      files: [
        { path: 'light/before.png', caption: 'Light, before' },
        { path: 'light/after.png', caption: 'Light, after' },
      ],
      block: '222',
      columns: 2,
      width: 300,
    });
    expect(parseInputs({ ...env, COLUMNS: '4', WIDTH: ' 260 ' })).toMatchObject({
      columns: 4,
      width: 260,
    });
  });

  it.each([
    ['REPO', '', 'REPO is owner/name'],
    ['REPO', 'sift', 'REPO is owner/name'],
    ['TARGET', '', "TARGET is the issue's or PR's number"],
    ['TARGET', '0', "TARGET is the issue's or PR's number"],
    ['TARGET', '-1', "TARGET is the issue's or PR's number"],
    ['TARGET', '12a', "TARGET is the issue's or PR's number"],
    ['HOST_PR', '', 'HOST_PR is the number of a PR whose description may be overwritten'],
    ['RUN_ID', 'abc', "RUN_ID is the run's id"],
    ['ARTIFACT', '', "ARTIFACT is an artifact's name"],
    ['ARTIFACT', '../x', "ARTIFACT is an artifact's name"],
    ['BLOCK', 'a--b', 'BLOCK names the block'],
    ['BLOCK', '', 'BLOCK names the block'],
    ['COLUMNS', '5', 'COLUMNS is a whole number from 1 to 4, not "5"'],
    ['COLUMNS', '0', 'COLUMNS is a whole number from 1 to 4'],
    ['COLUMNS', '1.5', 'COLUMNS is a whole number from 1 to 4'],
    ['WIDTH', '0', 'WIDTH is a whole number from 1 to 10000'],
    ['WIDTH', 'wide', 'WIDTH is a whole number from 1 to 10000'],
    ['FILES', '', 'FILES names no file to attach'],
  ])('refuses %s=%j', (name, value, message) => {
    expect(() => parseInputs({ ...env, [name]: value })).toThrow(`pictures: ${message}`);
  });
});

describe('parseFiles', () => {
  it('passes blank lines over and takes the name for a missing caption', () => {
    expect(parseFiles('\n  a.png  \n\r\nb/c.jpg |  \nd.gif | Has | bars\n')).toEqual([
      { path: 'a.png', caption: 'a.png' },
      { path: 'b/c.jpg', caption: 'c.jpg' },
      { path: 'd.gif', caption: 'Has | bars' },
    ]);
  });

  it.each([
    '/etc/passwd',
    '../up.png',
    'a/../../up.png',
    'a/./b.png',
    './a.png',
    'a//b.png',
    'a/',
    'a b.png',
    'a).png',
    'a\0.png',
    'a\\b.png',
    ' | caption only',
  ])('refuses the path in %j', (line) => {
    expect(() => parseFiles(line)).toThrow("isn't a file's path in the artifact");
  });

  it('ends a line at any line break, a lone \\r too', () => {
    expect(parseFiles('a.png | x\ry.png | z')).toEqual([
      { path: 'a.png', caption: 'x' },
      { path: 'y.png', caption: 'z' },
    ]);
  });

  it('refuses a file named twice', () => {
    expect(() => parseFiles('a.png\na.png | again')).toThrow('pictures: FILES names a.png twice');
  });

  it('refuses nothing at all', () => {
    expect(() => parseFiles(undefined)).toThrow('FILES names no file');
    expect(() => parseFiles('\n \n')).toThrow('FILES names no file');
  });
});

describe('parseBlock', () => {
  it("takes pr-gif's scenario names, trimmed", () => {
    expect(parseBlock(' 222 ')).toBe('222');
    expect(parseBlock('sift.mockup-1_a')).toBe('sift.mockup-1_a');
  });

  it.each(['', '-a', '.a', 'a b', 'a--b', 'a>b', 'a<b', undefined])('refuses %j', (value) => {
    expect(() => parseBlock(value)).toThrow('pictures: BLOCK names the block');
  });
});

describe('node pictures/inputs.mjs', () => {
  const script = path.join(import.meta.dirname, 'inputs.mjs');
  /** @param {Record<string, string>} values */
  const run = (values) =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...values },
      encoding: 'utf8',
    });

  it('exits 0 for good inputs, and 1 saying what is wrong', () => {
    expect(run(env).status).toBe(0);
    const bad = run({ ...env, HOST_PR: '' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('pictures: HOST_PR is the number of a PR');
  });
});
