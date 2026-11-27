import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSettings } from './settings.ts';
import type { ProbeSettings } from './settings.ts';

const KEYS = [
  'pages',
  'requests',
  'reads',
  'previewSafe',
  'cold',
  'repeats',
  'hosts',
  'headers',
  'timeout',
];

// Any JSON, and JSON shaped like the settings with any values in each key.
const settingsish = fc.oneof(
  fc.jsonValue(),
  fc.dictionary(fc.constantFrom(...KEYS, 'other'), fc.jsonValue()),
  fc.record(
    {
      pages: fc.array(
        fc.record({
          path: fc.oneof(
            fc.constantFrom('/', '//evil.example/', '/\\evil.example', '/a?b'),
            fc.string(),
            fc.string().map((rest) => `/${rest}`),
          ),
          expect: fc.array(fc.constantFrom('a', 'b')),
        }),
      ),
      requests: fc.array(
        fc.record(
          {
            name: fc.constantFrom('a', 'b', 'a b'),
            path: fc.constantFrom('/x', 'x', '/x?y'),
            method: fc.constantFrom('GET', 'post', 'POST'),
            operation: fc.constantFrom('Games', '1', ''),
          },
          { requiredKeys: ['name', 'path'] },
        ),
      ),
      repeats: fc.oneof(fc.integer({ min: -2, max: 25 }), fc.double()),
      timeout: fc.double(),
      hosts: fc.array(fc.oneof(fc.domain(), fc.string())),
      headers: fc.dictionary(fc.string(), fc.string()),
    },
    { requiredKeys: [] },
  ),
);

describe('parseSettings, for any JSON value', () => {
  it('returns valid settings or throws an Error naming .github/ci.json: probe', () => {
    fc.assert(
      fc.property(settingsish, (raw) => {
        let settings: ProbeSettings;
        try {
          settings = parseSettings(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/^\.github\/ci\.json: probe[ .]/);
          return;
        }
        expect(settings.pages.length).toBeGreaterThan(0);
        expect(settings.requests.length).toBeGreaterThan(0);
        const names = settings.requests.map((r) => r.name);
        for (const page of settings.pages) {
          for (const n of page.expect) expect(names).toContain(n);
          expect(new Set(page.expect).size).toBe(page.expect.length);
          // Every page and request path stays on the deployment's origin.
          for (const p of [page.path, ...settings.requests.map((r) => r.path)]) {
            expect(new URL(p, 'https://app.example').origin).toBe('https://app.example');
          }
        }
        expect(Number.isInteger(settings.repeats)).toBe(true);
        expect(settings.repeats).toBeGreaterThanOrEqual(1);
        expect(settings.repeats).toBeLessThanOrEqual(20);
        expect(settings.timeout).toBeGreaterThan(0);
      }),
    );
  });
});
