import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPrVisuals, settings } from '../visuals/check.mjs';
import { HEADINGS, PAIRS, problems } from './structure.mjs';

const master = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);

describe("this repo's template, the master", () => {
  it('has the shared shape', () => {
    expect(problems(master)).toEqual([]);
  });

  it('has its headings in order and no box to tick', () => {
    expect([...master.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(
      HEADINGS.map((names) => names[0]),
    );
    expect(master).not.toMatch(/\[[ x]\]\s*No visible/i);
  });

  it('is a template under which a UI change passes only with sharedTemplate', () => {
    const files = ['src/App.tsx'];
    expect(checkPrVisuals({ files, body: master, settings: settings({}) }).ok).toBe(false);
    expect(
      checkPrVisuals({ files, body: master, settings: settings({ sharedTemplate: true }) }).ok,
    ).toBe(true);
  });
});

describe('a bug fix', () => {
  it('may say Problem and Solution where a feature says Goal and Plan', () => {
    const fix = master.replace('## Goal', '## Problem').replace('## Plan', '## Solution');
    expect(problems(fix)).toEqual([]);
    expect(problems(master.replace('## Goal', '## Problem'))).toEqual([]);
  });

  it('may not say them in the wrong place or twice, or any other word', () => {
    expect(problems(master.replace('## Plan', '## Problem')).join()).toMatch(/headings must be/);
    expect(problems(master.replace('## Goal', '## Aim')).join()).toMatch(/Goal or Problem/);
  });
});

describe('problems', () => {
  it('names a heading out of order, a box, a missing pair and a picture', () => {
    const swapped = master
      .replace('## Checklist', '## Tmp')
      .replace('## Changes', '## Checklist')
      .replace('## Tmp', '## Changes');
    expect(problems(swapped).join()).toMatch(/headings must be/);
    expect(problems(`${master}\n- [ ] No visible UI change`).join()).toMatch(
      /No visible UI change/,
    );
    for (const key of PAIRS) {
      expect(problems(master.replace(`<!-- ${key} -->`, '')).join()).toContain(key);
    }
    expect(problems(`${master}\n![x](https://u/a.png)`).join()).toMatch(/picture/);
    expect(problems(master.replace('## Plan', '<!-- ![x](a.png) -->\n## Plan'))).toEqual([]);
    const pair = '<!-- describe:visual-review -->\n<!-- /describe:visual-review -->';
    expect(problems(`${master}\n${pair}`).join()).toMatch(/more than one/);
  });

  it("keeps the Example's guidance inside its comment, with every fence closed", () => {
    // GitHub ends an HTML comment at the first `-->`, even inside a code fence,
    // so a marker in the example would let the guidance show in the description.
    const comment = master.slice(master.indexOf('<!--', master.indexOf('## Goal')));
    const guidance = comment.slice(0, comment.indexOf('-->'));
    expect(guidance).toContain('\n**Example**\n');
    expect(guidance).toContain('_Real case: BoardGames#343');
    // An unclosed fence would blind the "no picture outside a comment" rule.
    expect((master.match(/```/g) ?? []).length % 2).toBe(0);
    expect((master.match(/~~~/g) ?? []).length % 2).toBe(0);
    expect(problems(master)).toEqual([]);
  });
});
