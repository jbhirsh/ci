import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selftest } from './selftest.ts';

const SHOTS = `name: Visual regression
on: [pull_request, push]
concurrency:
  group: v-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name != 'push' }}
jobs:
  visual:
    steps:
      - uses: jbhirsh/ci/visual-shots@main
`;
const STUB = `name: Visual review
on:
  workflow_run:
    workflows: [Visual regression, PR GIFs]
jobs:
  review:
    uses: jbhirsh/ci/.github/workflows/visual-review.yml@main
`;

/**
 * An app checkout with these files.
 *
 * @param {Record<string, string>} files
 */
function app(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}
const ci = JSON.stringify({
  'visual-review': { workflow: 'visual.yml', job: 'visual', folders: ['shots'] },
});

describe('selftest', () => {
  it("says so for an app that doesn't use visual review", () => {
    expect(selftest(app({}))).toEqual([
      'visual-review: no settings; the app uses no visual review yet.',
    ]);
  });

  it('passes an app wired as the header says', () => {
    const root = app({
      '.github/ci.json': ci,
      '.github/workflows/visual.yml': SHOTS,
      '.github/workflows/visual-review.yml': STUB,
    });
    expect(selftest(root)[0]).toMatch(/wakes on Visual regression, PR GIFs/);
  });

  it('fails each wiring mistake', () => {
    const base = {
      '.github/ci.json': ci,
      '.github/workflows/visual.yml': SHOTS,
      '.github/workflows/visual-review.yml': STUB,
    };
    for (const [over, why] of /** @type {[Record<string, string>, RegExp][]} */ ([
      [{ '.github/workflows/visual.yml': '' }, /doesn't upload its shots/],
      [
        { '.github/workflows/visual.yml': `${SHOTS}\n  cancel-in-progress: true\n` },
        /cancels runs in progress/,
      ],
      [{ '.github/workflows/visual-review.yml': 'name: x' }, /doesn't call/],
      [
        { '.github/workflows/visual-review.yml': STUB.replace('Visual regression, ', '') },
        /doesn't list Visual regression/,
      ],
      [
        { '.github/workflows/visual-review.yml': STUB.replace('PR GIFs', 'Visual review') },
        /lists itself/,
      ],
    ])) {
      expect(() => selftest(app({ ...base, ...over }))).toThrow(why);
    }
    expect(() => selftest(app({ '.github/ci.json': ci }))).toThrow(
      /no \.github\/workflows\/visual\.yml/,
    );
    expect(() =>
      selftest(app({ '.github/ci.json': ci, '.github/workflows/visual.yml': SHOTS })),
    ).toThrow(/no \.github\/workflows\/visual-review\.yml/);
  });
});
