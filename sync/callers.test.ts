import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** @param {string} file */
const doc = (file) => parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

const canonical = doc('./callers/pr-description.yml');

describe('the canonical PR description caller', () => {
  it("is this repo's own check, apart from its comments", () => {
    // The apps' copy and this repo's must run the same check the same way.
    expect(canonical).toEqual(doc('../.github/workflows/pr-description.yml'));
  });

  it('is a gating check that reports on every PR and holds no token', () => {
    expect(canonical.name).toBe('PR description');
    expect(canonical.jobs.description.name).toBe('PR description');
    expect(canonical.permissions).toEqual({});
    // A required check has no trigger-level `paths:` filter: a filtered-out
    // workflow never reports, so the check would wait forever.
    for (const trigger of Object.values(canonical.on)) {
      expect(trigger).not.toHaveProperty('paths');
      expect(trigger).not.toHaveProperty('paths-ignore');
    }
    expect(canonical.jobs.description.steps).toEqual([{ uses: 'jbhirsh/ci/pr-template@main' }]);
  });
});
