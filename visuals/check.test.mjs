import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settings as baselineSettings } from '../visual-baselines/settings.mjs';
import {
  DEFAULT_ADVICE,
  SCENARIO_ADVICE,
  baselinesShown,
  checkPrVisuals,
  loadBaselineSettings,
  readEntries,
  report,
  settings,
  visibleText,
} from './check.mjs';
import { goldenText } from './golden.mjs';

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

describe('with no fromBaselines', () => {
  it("prints today's lines, byte for byte", () => {
    const golden = readFileSync(new URL('./check.golden.txt', import.meta.url), 'utf8');
    expect(goldenText()).toBe(golden);
  });

  it('refuses a setting that is not true or false', () => {
    expect(() => settings({ fromBaselines: 'yes' })).toThrow(
      'visuals.fromBaselines must be true or false',
    );
    expect(settings({ fromBaselines: false })).toEqual(settings({}));
  });
});

describe('with fromBaselines', () => {
  const s = settings({ fromBaselines: true });
  const parsed = baselineSettings({
    folders: ['e2e/*-snapshots'],
    columns: [
      { label: 'Phone', file: '{state}-visual-phone-webkit-linux.png' },
      { label: 'Desktop', file: '{state}-visual-webkit-linux.png' },
    ],
  });
  const baselines = { ...parsed, columns: parsed.columns ?? [] };
  const files = ['src/components/SignInPage.tsx'];
  /**
   * The verdict for a UI change with these changed baselines and description.
   *
   * @param {import('../lib/baselines.mjs').FileEntry[]} changed
   * @param {string} [body]
   * @param {string} [state]
   */
  const verdict = (changed, body = '', state = 'open') =>
    checkPrVisuals({
      files,
      body,
      state,
      baselines: baselinesShown(changed, baselines),
      settings: s,
    });
  const phone = 'e2e/visual-phone.spec.ts-snapshots/sign-in-light-visual-phone-webkit-linux.png';

  it('passes a UI change whose changed baselines land in a column', () => {
    expect(verdict([{ filename: phone, status: 'modified' }])).toEqual({
      ok: true,
      reason: 'changed baselines show it',
    });
    expect(verdict([{ filename: phone, status: 'added' }]).ok).toBe(true);
  });

  it('passes one whose only changed baseline was renamed into a column', () => {
    const renamed = { filename: phone, status: 'renamed', previous_filename: `${phone}.old.png` };
    expect(verdict([renamed]).ok).toBe(true);
  });

  it('fails one whose only changed baselines are deleted or in no column', () => {
    expect(verdict([{ filename: phone, status: 'removed' }]).ok).toBe(false);
    expect(
      verdict([
        {
          filename: 'e2e/visual-full.spec.ts-snapshots/sign-in-light-visual-firefox-linux.png',
          status: 'modified',
        },
      ]).ok,
    ).toBe(false);
  });

  it.each([
    ['a labelled GIF', '![GIF: the sheet opening](https://github.com/user-attachments/assets/1)'],
    ['a GIF the gif tool attached', '![GIF: sign-in after](https://example.com/a.gif)'],
    ['a reason no test draws it', "![No test draws: Google's sign-in page](https://x/a.png)"],
    ['a labelled <img>', '<img alt="GIF: drag" src="https://x/a.gif" width="300">'],
    [
      "a labelled <img>, alt after src, in '",
      "<img src='https://x/a.png' alt='No test draws: mail'>",
    ],
    [
      'a bare uploaded video on its own line',
      'After:\nhttps://github.com/user-attachments/assets/0f1e\n',
    ],
    ['an HTML video', '<video src="https://example.com/a.mp4"></video>'],
    [
      'an unlabelled GIF on the branch',
      '<img src="https://raw.example/x/a-after.gif" width="300">',
    ],
    ['an unlabelled Markdown GIF', '![after](https://example.com/a.GIF?raw=true)'],
  ])('passes a picture that says why no baseline shows it: %s', (_, body) => {
    expect(verdict([], body)).toEqual({
      ok: true,
      reason: 'description shows what no baseline can',
    });
  });

  it.each([
    ['an unlabelled still', '![after](https://example.com/a.png)'],
    ['an unlabelled <img>', '<img src="https://x/a.png" width="300">'],
    ['a still whose alt names a GIF', '<img alt="a.gif" src="https://x/a.png">'],
    ['a reason with nothing after it', '![No test draws:](https://x/a.png)'],
    ['an <img> labelled but with no src', '<img alt="GIF: x">'],
    ['an uploaded link inside a sentence', 'See https://github.com/user-attachments/assets/1 here'],
    ['a labelled GIF in a comment', '<!-- ![GIF: x](https://x/a.gif) -->'],
  ])('fails %s', (_, body) => {
    expect(verdict([], body).ok).toBe(false);
  });

  it('still passes the ticked box, Dependabot and a PR with no UI', () => {
    expect(verdict([], '- [x] No visible UI change').ok).toBe(true);
    expect(checkPrVisuals({ files, body: '', author: 'dependabot[bot]', settings: s }).ok).toBe(
      true,
    );
    expect(checkPrVisuals({ files: ['README.md'], body: '', settings: s }).ok).toBe(true);
  });

  it('passes a closed PR, which it was never meant to judge', () => {
    expect(verdict([], '', 'closed')).toEqual({ ok: true, reason: 'closed PR' });
    // Without the setting a closed PR is judged as before.
    expect(checkPrVisuals({ files, body: '', state: 'closed', settings: settings({}) }).ok).toBe(
      false,
    );
  });

  it('tells the author to add a scenario when it fails', () => {
    const { code, message } = report(`${files[0]}\n`, {
      body: '',
      baselines: { shown: 0 },
      settings: s,
    });
    expect(code).toBe(1);
    expect(message.split('\n').slice(-2)).toEqual([DEFAULT_ADVICE, SCENARIO_ADVICE]);
  });

  it('reads the files API entries action.yml writes, one a line', () => {
    expect(
      readEntries(
        '{"filename":"a.png","status":"renamed","previous_filename":"b.png"}\n\n{"filename":"c","status":"added","previous_filename":null}\n',
      ),
    ).toEqual([
      { filename: 'a.png', status: 'renamed', previous_filename: 'b.png' },
      { filename: 'c', status: 'added', previous_filename: null },
    ]);
  });

  it('needs the app to pair its baselines', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'visuals-'));
    mkdirSync(path.join(root, '.github'));
    const write = (/** @type {unknown} */ config) =>
      writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify(config));
    write({ 'visual-baselines': { folders: ['shots'] } });
    expect(() => loadBaselineSettings(root)).toThrow(
      'visuals.fromBaselines needs visual-baselines.columns',
    );
    write({
      'visual-baselines': { folders: ['shots'], columns: [{ label: 'A', file: '{state}.png' }] },
    });
    expect(loadBaselineSettings(root).columns).toEqual([{ label: 'A', file: ['{state}.png'] }]);
  });
});
