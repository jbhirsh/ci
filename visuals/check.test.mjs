import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADVICE,
  checkPrVisuals,
  readAll,
  report,
  settings,
  visibleText,
} from './check.mjs';

// The three apps' settings, as their .github/ci.json give them.
const FOG = settings({ ui: ['src/**/*.{tsx,css}'], notUi: ['**/*.test.tsx', 'src/test/**'] });
const SIFT = settings({
  ui: [
    'src/App.tsx',
    'src/components/**/*.{ts,tsx}',
    'src/screens/**/*.{ts,tsx}',
    'src/theme/**/*.{ts,tsx}',
    'assets/**',
  ],
  notUi: [],
  advice: 'Add before/after simulator screenshots.',
});
const BOARDGAMES = settings({
  ui: ['src/**/*.{tsx,css}', 'src/**/*Classes.ts', 'index.html'],
  notUi: ['**/*.test.tsx', 'src/__tests__/**', 'src/context/**', 'src/main.tsx'],
});

/** @param {string[]} files */
const uiFiles = (files, s = FOG) => {
  const verdict = checkPrVisuals({ files, body: '', settings: s });
  return verdict.ok ? [] : verdict.ui;
};

// A PR template like the apps': its example table sits in a comment.
const TEMPLATE = `<!-- What changes and why. -->

## Visual changes

<!--
UI changes need before/after visuals.

| Before (\`main\`) | After |
|---|---|
| <img src="…" width="300"> | <img src="…" width="300"> |
-->

- [ ] No visible UI change

## Validation
`;

describe('settings', () => {
  it('fills in the defaults', () => {
    expect(settings({})).toEqual({
      ui: ['src/**/*.{tsx,css}'],
      notUi: ['**/*.test.*', '**/__tests__/**', 'src/test/**'],
      advice: DEFAULT_ADVICE,
    });
  });

  it('refuses advice that is not text', () => {
    expect(() => settings({ advice: 3 })).toThrow('visuals.advice must be text');
    expect(() => settings({ advice: ' ' })).toThrow('visuals.advice must be text');
  });
});

describe('which files are UI', () => {
  it("keeps fog-and-frontier's components and stylesheets under src", () => {
    expect(
      uiFiles(['src/pages/Trips.tsx', 'src/index.css', 'src/lib/geo.ts', 'api/graphql.ts']),
    ).toEqual(['src/pages/Trips.tsx', 'src/index.css']);
    expect(uiFiles(['src/pages/Trips.test.tsx', 'src/test/render.tsx', 'README.md'])).toEqual([]);
  });

  it("keeps sift's screens, components, root App, theme and image assets", () => {
    const ui = [
      'src/screens/SiftScreen.tsx',
      'src/components/InteractiveCard.tsx',
      'src/App.tsx',
      'src/theme/index.ts',
      'src/theme/ThemeContext.tsx',
      'src/components/Card/styles.ts',
      'assets/icon.png',
    ];
    expect(uiFiles(ui, SIFT)).toEqual(ui);
    expect(
      uiFiles(
        [
          'src/context/SiftContext.tsx',
          'src/hooks/useMusicProvider.ts',
          'src/services/SessionStore.ts',
          'src/utils/sorting.ts',
          '__tests__/unit/SiftScreen.test.tsx',
          '.maestro/02_sift_flow.yaml',
          'package.json',
          'README.md',
        ],
        SIFT,
      ),
    ).toEqual([]);
  });

  it("keeps BoardGames' class modules and index.html, and drops what draws nothing", () => {
    expect(
      uiFiles(
        [
          'src/components/GameCard.tsx',
          'src/index.css',
          'src/components/sharedClasses.ts',
          'src/components/FilterBar/pillClasses.ts',
          'index.html',
          'src/utils/classNames.ts',
          'public/index.html',
          'src/utils/filterGames.ts',
        ],
        BOARDGAMES,
      ),
    ).toEqual([
      'src/components/GameCard.tsx',
      'src/index.css',
      'src/components/sharedClasses.ts',
      'src/components/FilterBar/pillClasses.ts',
      'index.html',
    ]);
    expect(
      uiFiles(
        [
          'src/__tests__/GameCard.test.tsx',
          'src/__tests__/testData.ts',
          'src/Foo.test.tsx',
          'src/context/FilterContext.tsx',
          'src/main.tsx',
          'src/App.tsx',
        ],
        BOARDGAMES,
      ),
    ).toEqual(['src/App.tsx']);
  });
});

describe('checkPrVisuals', () => {
  const ui = ['src/components/BottomSheet.tsx'];
  /** @param {string | undefined} body */
  const ok = (body) => checkPrVisuals({ files: ui, body, settings: FOG }).ok;

  it('passes a PR with no UI files, whatever the description', () => {
    expect(checkPrVisuals({ files: ['api/_db.ts'], body: '', settings: FOG }).ok).toBe(true);
    expect(
      checkPrVisuals({ files: ['package-lock.json'], body: undefined, settings: FOG }).ok,
    ).toBe(true);
  });

  it("passes Dependabot's PRs", () => {
    expect(
      checkPrVisuals({ files: ui, body: '', author: 'dependabot[bot]', settings: FOG }),
    ).toEqual({ ok: true, reason: "Dependabot's PR" });
  });

  it('fails a UI change with no picture, naming the files', () => {
    expect(checkPrVisuals({ files: ui, body: 'Fixes the sheet.', settings: FOG })).toEqual({
      ok: false,
      ui,
    });
    expect(ok(undefined)).toBe(false);
  });

  it.each([
    ['a markdown image', '![after](https://example.com/a.png)'],
    ['a markdown GIF', '![drag](https://example.com/drag.gif)'],
    ['an HTML image', '<img src="https://example.com/a.png" width="300">'],
    ['an HTML video', '<video src="https://example.com/a.mp4"></video>'],
    [
      'a video with its source inside',
      '<video>\n<source src="https://example.com/a.mp4">\n</video>',
    ],
    ['an image link with a space before the URL', '![after]( https://example.com/a.png)'],
    ['an uploaded video', 'https://github.com/user-attachments/assets/0f1e2d3c'],
  ])('passes a UI change whose description has %s', (_, body) => {
    expect(ok(body)).toBe(true);
  });

  it('passes a UI change ticked "No visible UI change", in any list or quote', () => {
    expect(ok('- [x] No visible UI change')).toBe(true);
    expect(ok('* [X] No visible UI change (refactor)')).toBe(true);
    expect(ok('1. [x] no visible UI change')).toBe(true);
    expect(ok('> - [x] No visible UI change')).toBe(true);
    // The box's own words, not a sentence that starts with them.
    expect(ok('- [x] No visible UI changes are hard')).toBe(false);
  });

  it('fails the untouched template, whose example sits in a comment', () => {
    expect(ok(TEMPLATE)).toBe(false);
  });

  it('passes the template once its box is ticked', () => {
    const ticked = TEMPLATE.replace('- [ ] No visible UI change', '- [x] No visible UI change');
    expect(ticked).not.toEqual(TEMPLATE);
    expect(ok(ticked)).toBe(true);
  });

  it('ignores pictures in comments, closed or not', () => {
    const img = '<img src="a.png">';
    expect(ok(`<!-- ${img} -->`)).toBe(false);
    // An unclosed comment hides the rest of the description.
    expect(ok(`<!-- note\n${img}`)).toBe(false);
    // Text after a closed comment still counts.
    expect(ok(`<!-- note -->\n${img}`)).toBe(true);
    expect(ok(`<!-- a --><!-- b -->${img}`)).toBe(true);
  });

  it('treats a comment opener quoted in code as text, not a comment', () => {
    expect(ok('Fills in the template\'s `<!--` block.\n<img src="after.png">')).toBe(true);
    expect(ok('```html\n<!-- example\n```\n![after](https://example.com/a.png)')).toBe(true);
  });

  it('ignores pictures quoted in code', () => {
    expect(ok('Use `<img src="a.png">` here')).toBe(false);
    expect(ok('```html\n<img src="a.png">\n```')).toBe(false);
    expect(ok('~~~\n<img src="a.png">\n~~~')).toBe(false);
    // An unclosed fence runs to the end, as GitHub renders it.
    expect(ok('```\n<img src="a.png">')).toBe(false);
    expect(ok('a `b\n<img src="a.png">` c')).toBe(false);
  });

  it('does not count an unticked box or a mention of an image', () => {
    expect(ok('- [ ] No visible UI change')).toBe(false);
    expect(ok('Screenshots: <img> to follow')).toBe(false);
    expect(ok('see ![]() later')).toBe(false);
  });
});

describe('visibleText', () => {
  it('keeps text around comments and code and treats a missing body as empty', () => {
    expect(visibleText('a <!-- hidden --> b `code` c')).toBe('a  b  c');
    expect(visibleText(undefined)).toBe('');
  });
});

describe('report', () => {
  it('passes with a reason', () => {
    expect(report('api/graphql.ts\n', { body: '', settings: FOG })).toEqual({
      code: 0,
      message: 'PR visuals: ok (no UI files changed).',
    });
  });

  it("fails as a GitHub error naming each UI file, then the app's advice", () => {
    const { code, message } = report(
      '  src/index.css \n\nsrc/components/Card.tsx\napi/graphql.ts\n',
      {
        body: 'No pictures.',
        settings: FOG,
      },
    );
    expect(code).toBe(1);
    expect(message.split('\n')).toEqual([
      '::error::This PR changes the UI but its description shows none of it.',
      'Changed UI files:',
      '  src/index.css',
      '  src/components/Card.tsx',
      DEFAULT_ADVICE,
    ]);
    expect(report('assets/icon.png', { body: '', settings: SIFT }).message).toMatch(
      /simulator screenshots\.$/,
    );
  });
});

describe('readAll', () => {
  it('joins every chunk of a stream', async () => {
    expect(await readAll(Readable.from(['a\n', Buffer.from('b\n')]))).toBe('a\nb\n');
  });
});

describe('the settings an app keeps', () => {
  it('reads them from .github/ci.json', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'visuals-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github', 'ci.json'),
      JSON.stringify({ visuals: { ui: ['app/**'] } }),
    );
    const { appConfig } = await import('../lib/app.mjs');
    expect(settings(appConfig('visuals', root)).ui).toEqual(['app/**']);
  });
});
