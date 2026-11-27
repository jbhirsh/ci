import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selftest } from './selftest.ts';

const PROBE = {
  pages: [{ path: '/', expect: ['games'] }],
  requests: [{ name: 'games', path: '/api/graphql', operation: 'Games' }],
};
const LOCK = JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.65.0' } } });
const CALLER = 'jobs:\n  perf-probe:\n    steps:\n      - uses: jbhirsh/ci/probe/web@main\n';

/**
 * An app with these files.
 */
function app(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'probe-selftest-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

describe('selftest', () => {
  it('says so, and checks nothing more, for an app with no probe key', () => {
    const log = vi.fn();
    expect(selftest(app({ '.github/ci.json': '{"gif": {}}' }), log)).toEqual([]);
    expect(selftest(app({}), log)).toEqual([]);
    expect(log).toHaveBeenCalledWith("probe: no probe settings; the app doesn't use the probe yet");
  });

  it('passes an app whose settings parse, whose lockfile pins Playwright, and that calls the probe', () => {
    const log = vi.fn();
    const root = app({
      '.github/ci.json': JSON.stringify({ probe: PROBE }),
      'package-lock.json': LOCK,
      '.github/workflows/smoke.yml': CALLER,
      '.github/workflows/ci.yml': 'jobs: {}\n',
    });
    expect(selftest(root, log)).toEqual([]);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'probe: settings parse (1 page(s), 1 request(s) to time)',
      "probe: the app's lockfile pins Playwright 1.65.0",
      'probe: smoke.yml calls it',
    ]);
  });

  it('names a key that has no caller workflow', () => {
    const root = app({
      '.github/ci.json': JSON.stringify({ probe: PROBE }),
      'package-lock.json': LOCK,
    });
    expect(selftest(root, () => {})).toEqual([
      'no workflow in .github/workflows calls jbhirsh/ci/probe/web@main',
    ]);
    const other = app({
      '.github/ci.json': JSON.stringify({ probe: PROBE }),
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': 'jobs: {}\n',
    });
    expect(selftest(other, () => {})).toHaveLength(1);
  });

  it("names a lockfile that doesn't pin Playwright", () => {
    const root = app({
      '.github/ci.json': JSON.stringify({ probe: PROBE }),
      'package-lock.json': JSON.stringify({ packages: {} }),
      '.github/workflows/smoke.yml': CALLER,
    });
    expect(selftest(root, () => {})).toEqual([
      'Playwright: package-lock.json pins no version of playwright',
    ]);
  });

  it('names settings that are wrong', () => {
    const root = app({ '.github/ci.json': JSON.stringify({ probe: { pages: [] } }) });
    expect(selftest(root, () => {})).toEqual([
      'settings: .github/ci.json: probe.requests must be a list of at least one',
    ]);
  });
});
