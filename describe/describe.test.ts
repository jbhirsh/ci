import { describe as group, expect, it } from 'vitest';
import {
  blocks,
  isScreenState,
  parseUpload,
  partMarker,
  place,
  SECTION,
  uploadMarker,
  withSections,
} from './describe.ts';

const BOT = 'jbhirsh';
const A = 'a'.repeat(40);
const IMG = 'https://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555';

/**
 * An upload comment.
 */
const upload = (id: number, bot: string, sha: string, section: string, login: string = BOT) => ({
  id,
  node_id: `N${id}`,
  user: { login },
  body: `${uploadMarker(bot, sha)}\nPictures.\n\n${SECTION}\n${section}`,
});

group('parseUpload', () => {
  it('reads a genuine upload', () => {
    expect(parseUpload(upload(1, 'visual-review', A, `<img src="${IMG}">`), BOT)).toEqual({
      id: 1,
      nodeId: 'N1',
      bot: 'visual-review',
      sha: A,
      section: `<img src="${IMG}">`,
    });
  });

  it("refuses another author's, an unmarked one, one without a section, and outside links", () => {
    expect(parseUpload(upload(1, 'visual-review', A, 'x', 'someone'), BOT)).toBeNull();
    expect(parseUpload({ id: 1, node_id: 'N', user: { login: BOT }, body: 'hi' }, BOT)).toBeNull();
    expect(
      parseUpload({ id: 1, node_id: 'N', user: { login: BOT }, body: uploadMarker('x', A) }, BOT),
    ).toBeNull();
    for (const bad of [
      '<img src="https://evil.example/x.png">',
      '![x](https://raw.githubusercontent.com/a/b/c.png)',
      'see https://example.com',
      '<a href="javascript:alert(1)">x</a>',
    ]) {
      expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
    }
  });
});

/** One bot's section, as withSections takes it. */
const one = (section: string, bot = 'visual-review') => new Map([[bot, { section }]]);

group('withSections', () => {
  it("writes each bot's block and leaves the rest of the description", () => {
    const body = `Mine.\n\n${blocks.markers('pr-gif').start}\nhand\n${blocks.markers('pr-gif').end}`;
    const sections = one('table');
    const out = withSections(body, sections);
    expect(out.startsWith('Mine.')).toBe(true);
    expect(out).toContain('hand');
    expect(out).toContain(
      '<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->',
    );
    expect(withSections(out, sections)).toBe(out);
  });
});

group('place', () => {
  /**
   * A fake GitHub holding a description that may change under it.
   *
   * @param reads what each read of the description returns
   */
  const io = (reads: string[]) => {
    const written: string[] = [];
    let i = 0;
    return {
      written,
      io: {
        body: () => reads[Math.min(i++, reads.length - 1)],
        write: (b: string) => written.push(b),
        log: () => {},
      },
    };
  };

  it("writes the section it's handed", () => {
    const f = io(['Mine.']);
    expect(place(f.io, 'visual-review', 'new')).toBe(true);
    expect(f.written).toEqual([
      'Mine.\n\n<!-- describe:visual-review -->\nnew\n<!-- /describe:visual-review -->\n',
    ]);
  });

  it('writes nothing when the description already holds it', () => {
    const f = io([withSections('Mine.', one('new'))]);
    expect(place(f.io, 'visual-review', 'new')).toBe(false);
    expect(f.written).toEqual([]);
  });

  it('tidies the description as read before the section goes in', () => {
    const f = io(['Mine.\n\nSTRAY']);
    place(f.io, 'visual-review', 'new', (b) => b.replace('\n\nSTRAY', ''));
    expect(f.written[0]).not.toContain('STRAY');
  });

  it('works the edit out again when the description moved, keeping the new text', () => {
    const f = io(['Mine.', 'Mine, edited.', 'Mine, edited.', 'Mine, edited.']);
    place(f.io, 'visual-review', 'new');
    expect(f.written).toHaveLength(1);
    expect(f.written[0].startsWith('Mine, edited.')).toBe(true);
  });

  it('gives up, saying so, when it keeps moving', () => {
    const f = io(['1', '2', '3', '4', '5', '6', '7']);
    expect(() => place(f.io, 'visual-review', 'new')).toThrow(/kept changing/);
    expect(f.written).toEqual([]);
  });
});

/**
 * A section in parts: the heading, then a part a state, then the rest.
 *
 * @param screens text by state
 * @param rest
 */
const parts = (screens: Record<string, string>, rest?: string) =>
  [
    partMarker('head'),
    'HEAD',
    ...Object.entries(screens).flatMap(([state, text]) => [
      '',
      partMarker(`screen:${state}`),
      text,
    ]),
    ...(rest === undefined ? [] : ['', partMarker('rest'), rest]),
  ].join('\n');
const slot = (state: string, inner = '') =>
  `<!-- describe:visual-review:${state} -->${inner ? `\n${inner}\n` : '\n'}<!-- /describe:visual-review:${state} -->`;
const written = (section: string, body = '') => withSections(body, one(section));

group('a section in parts', () => {
  it('is read with its part lines left out, and refused with any other marker of ours', () => {
    const got = parseUpload(upload(1, 'visual-review', A, parts({ trips: 'T' })), BOT);
    expect(got?.section).toContain('T');
    for (const bad of [
      `${partMarker('head')}\n${SECTION}`,
      `${partMarker('head')}\n${uploadMarker('x', A)}`,
      `${partMarker('head')}\n<!-- describe:pr-gif -->`,
      `${partMarker('head')}\n<!-- /describe:pr-gif -->`,
      // A part a marker can't hold isn't a part line, so it's refused as a marker.
      `${partMarker('head')}\n<!-- describe-part:screen:a--b -->`,
      `${partMarker('head')}\n<!-- describe-part:screen:a b -->`,
    ]) {
      expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
    }
  });

  it('still takes only links to attachments, in every part', () => {
    const bad = parts({ trips: '<img src="https://evil.example/x.png">' });
    expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
  });

  it('puts a state under the slot an author placed, and the rest under the heading', () => {
    const out = written(
      parts({ trips: 'T', cards: 'C' }, 'R'),
      `1. A.\n\n${slot('trips')}\n\n2. B.`,
    );
    expect(out.indexOf('1. A.')).toBeLessThan(out.indexOf('T'));
    expect(out.indexOf('T')).toBeLessThan(out.indexOf('2. B.'));
    expect(out.indexOf('2. B.')).toBeLessThan(out.indexOf('HEAD'));
    expect(out.indexOf('HEAD')).toBeLessThan(out.indexOf('C'));
    expect(out.indexOf('C')).toBeLessThan(out.indexOf('R'));
    for (const text of ['T', 'C', 'R']) expect(out.split(text)).toHaveLength(2);
    expect(out).not.toContain('describe-part');
  });

  it("shows every part in the bot's block when there is no slot, in order", () => {
    const out = written(parts({ trips: 'T', cards: 'C' }, 'R'));
    expect(out).toBe(
      '<!-- describe:visual-review -->\nHEAD\n\nT\n\nC\n\nR\n<!-- /describe:visual-review -->\n',
    );
  });

  it('fills a slot added later from the same upload, with no other change', () => {
    const first = written(parts({ trips: 'T' }));
    const second = written(parts({ trips: 'T' }), `Intro.\n\n${slot('trips')}\n\n${first}`);
    expect(second.split('T')).toHaveLength(2);
    expect(second.indexOf('T')).toBeLessThan(second.indexOf('HEAD'));
  });

  it('empties a slot whose state has no part, and keeps its markers, even for a section with no parts', () => {
    const body = `Intro.\n\n${slot('trips', 'old')}`;
    for (const section of [parts({ cards: 'C' }), '### Visual changes: none']) {
      const out = written(section, body);
      expect(out).not.toContain('old');
      expect(blocks.find(out, 'visual-review:trips')).not.toBeNull();
    }
  });

  it('leaves an upload with no part lines as it always was', () => {
    expect(written('table', 'Mine.')).toBe(
      'Mine.\n\n<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->\n',
    );
  });

  it("gives a slot nested in another, or inside the bot's own block, no part", () => {
    const inner = slot('cards');
    const nested = `<!-- describe:visual-review:trips -->\n${inner}\n<!-- /describe:visual-review:trips -->`;
    const out = written(parts({ trips: 'T', cards: 'C' }), nested);
    expect(out.split('C')).toHaveLength(2);
    expect(out.split('T')).toHaveLength(2);
    const inside = `<!-- describe:visual-review -->\n${slot('trips')}\n<!-- /describe:visual-review -->`;
    const out2 = written(parts({ trips: 'T' }), inside);
    expect(out2.split('T')).toHaveLength(2);
  });

  it('treats a state with two pairs, or a torn one, as no slot, and shows its part once', () => {
    const torn = '<!-- describe:visual-review:trips -->\nauthor';
    for (const body of [
      `${slot('trips')}\n\n${slot('trips')}`,
      torn,
      `${torn}\n${slot('trips')}`,
    ]) {
      const out = written(parts({ trips: 'T' }), body);
      expect(out.split('T')).toHaveLength(2);
      expect(out.indexOf('T')).toBeGreaterThan(out.indexOf('HEAD'));
    }
  });

  it("gives a state a marker can't hold no slot, whatever the description says", () => {
    expect(isScreenState('a--b')).toBe(false);
    expect(isScreenState('a b')).toBe(false);
    expect(isScreenState('trips-1.v2_x')).toBe(true);
    const out = written(parts({}, 'R'), slot('a--b'));
    expect(out).toContain('R');
  });

  it("keeps another bot's section as it is", () => {
    const sections = new Map([
      ['visual-review', { section: parts({ trips: 'T' }) }],
      ['pr-gif', { section: 'gif' }],
    ]);
    const out = withSections(slot('trips'), sections);
    expect(out).toContain('<!-- describe:pr-gif -->\ngif\n<!-- /describe:pr-gif -->');
  });

  it("leaves another tool's block inside a slot alone, so the slot gets no part", () => {
    const gif = '<!-- pr-gif:s -->\ng\n<!-- /pr-gif:s -->';
    const body = `<!-- describe:visual-review:trips -->${gif}<!-- /describe:visual-review:trips -->`;
    const out = written(parts({ trips: 'T' }), body);
    expect(out).toContain(gif);
    expect(out.split('T')).toHaveLength(2);
    expect(out.indexOf('T')).toBeGreaterThan(out.indexOf('HEAD'));
  });

  it('puts the text of a part named twice into its slot, and text before the first part in the rest', () => {
    const section = `LEAD\n${partMarker('screen:trips')}\nA\n${partMarker('screen:trips')}\nB`;
    const out = written(section, slot('trips'));
    expect(out.indexOf('A')).toBeLessThan(out.indexOf('B'));
    expect(out).toContain(slot('trips', 'A\n\nB'));
    expect(out.indexOf('LEAD')).toBeGreaterThan(out.indexOf('B'));
  });

  it('adds no blank lines for a part with no text', () => {
    const out = written(
      `${partMarker('head')}\nH\n${partMarker('screen:b')}\nB\n${partMarker('rest')}\n`,
    );
    expect(out).toBe('<!-- describe:visual-review -->\nH\n\nB\n<!-- /describe:visual-review -->\n');
  });

  it('never gives a name outside letters, digits, . _ and - a slot, however it is written', () => {
    for (const state of ['café', 'a:b', 'a/b', 'a--b', 'a b']) {
      expect(isScreenState(state)).toBe(false);
    }
  });
});

group('parseUpload, for the links a section may hold', () => {
  const COMMIT_LINK = `https://github.com/jbhirsh/app/commit/${A}`;
  it('takes a link to a commit and refuses any other page', () => {
    expect(
      parseUpload(upload(1, 'visual-review', A, `[\`abc\`](${COMMIT_LINK})`), BOT),
    ).not.toBeNull();
    for (const bad of [
      'https://github.com/jbhirsh/app/commit/abc',
      `https://github.com/jbhirsh/app/pull/1`,
      `${COMMIT_LINK}/x`,
      `https://evil.example/jbhirsh/app/commit/${A}`,
      `http://github.com/jbhirsh/app/commit/${A}`,
    ]) {
      expect(parseUpload(upload(1, 'visual-review', A, `[x](${bad})`), BOT)).toBeNull();
    }
  });
});

group('withSections, for the table parts', () => {
  const part = (key: string, text: string) => `${partMarker(key)}\n${text}`;
  const write = (body: string, parts: string[]) =>
    withSections(
      body,
      new Map([
        [
          'visual-review',
          { id: 1, nodeId: 'N', bot: 'visual-review', sha: A, section: parts.join('\n\n') },
        ],
      ]),
    );

  it('says none when the upload has no minor row', () => {
    const out = write('Body', [
      part('head', 'HEAD'),
      part('header:big', '| B |\n|---|'),
      part('big:ok', '| ROWX |'),
      part('fold:closed', 'Minor edge differences (under 0.1%)'),
    ]);
    expect(out).toContain('Minor edge differences (under 0.1%): none');
    expect(out).toContain('| B |\n|---|\n| ROWX |');
  });

  it('counts a screen once however many sizes it has, and each row with no state', () => {
    const out = write('Body', [
      part('head', 'HEAD'),
      part('header:minor', '| M |\n|---|'),
      part('minor:a', '| R1 |\n| R2 |'),
      part('minor', '| R3 |\n| R4 |'),
      part('fold:open', 'Minor edge differences (under 0.1%)'),
    ]);
    expect(out).toContain(
      '<details open><summary>Minor edge differences (under 0.1%): 3 screens</summary>',
    );
  });
});
