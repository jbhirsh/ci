import { describe, expect, it } from 'vitest';
import { blocksFor } from './blocks.mjs';

describe('blocksFor', () => {
  const pictures = blocksFor('pictures');

  it("marks a key's block with the prefix", () => {
    expect(pictures.markers('222')).toEqual({
      start: '<!-- pictures:222 -->',
      end: '<!-- /pictures:222 -->',
    });
  });

  it('refuses a key that could end the marker comment, in its own words', () => {
    for (const bad of ['a b', 'a--b', 'a>b', '<a', '']) {
      expect(() => pictures.markers(bad)).toThrow(
        `pictures: a block named ${JSON.stringify(bad)} can't mark its block in a description; rename it`,
      );
    }
    expect(() =>
      blocksFor('pr-gif', { named: 'a scenario named', where: 'a PR description' }).markers('a b'),
    ).toThrow(`pr-gif: a scenario named "a b" can't mark its block in a PR description; rename it`);
  });

  it('writes a block after the rest, then in place of itself', () => {
    const once = pictures.write('Intro\n\n', 'a', 'one');
    expect(once).toBe('Intro\n\n<!-- pictures:a -->\none\n<!-- /pictures:a -->\n');
    expect(pictures.write(once, 'a', 'two')).toBe(
      'Intro\n\n<!-- pictures:a -->\ntwo\n<!-- /pictures:a -->\n',
    );
    expect(pictures.write('', 'a', 'x')).toBe('<!-- pictures:a -->\nx\n<!-- /pictures:a -->\n');
  });

  it('reads back what it wrote, and leaves the text around it as it was', () => {
    const body = pictures.write('Before', 'a', 'table');
    const found = pictures.find(body, 'a');
    expect(found && body.slice(found.from, found.to)).toBe(
      '<!-- pictures:a -->\ntable\n<!-- /pictures:a -->',
    );
    const around = `Head\n${body}Tail`;
    expect(pictures.write(around, 'a', 'new')).toBe(
      'Head\nBefore\n\n<!-- pictures:a -->\nnew\n<!-- /pictures:a -->\nTail',
    );
  });

  it('leaves an unpaired marker alone', () => {
    const body = 'x <!-- pictures:a --> broken';
    expect(pictures.find(body, 'a')).toBe(null);
    expect(pictures.write(body, 'a', 't')).toBe(
      'x <!-- pictures:a --> broken\n\n<!-- pictures:a -->\nt\n<!-- /pictures:a -->\n',
    );
    // A start with no end after it, at the very beginning.
    expect(pictures.find('<!-- pictures:a --> x', 'a')).toBe(null);
    // The last start an end follows.
    const twice = '<!-- pictures:a -->1<!-- /pictures:a --> <!-- pictures:a -->';
    expect(pictures.find(twice, 'a')).toEqual({ from: 0, to: 40 });
  });

  it("ignores another prefix's blocks", () => {
    const gif = blocksFor('pr-gif');
    const body = gif.write('Intro', 'a', 'gif');
    expect(pictures.find(body, 'a')).toBe(null);
    expect(pictures.keys(body)).toEqual([]);
    const both = pictures.write(body, 'a', 'pictures');
    expect(gif.write(both, 'a', 'new')).toContain('<!-- pictures:a -->\npictures\n');
    expect(pictures.remove(both, 'a')).toBe(body.trimEnd());
  });

  it('removes a block and the blank line before it, keeping the rest', () => {
    const body = pictures.write(pictures.write('Intro', 'a', '1'), 'b', '2');
    expect(pictures.remove(body, 'a')).toBe(
      'Intro\n\n<!-- pictures:b -->\n2\n<!-- /pictures:b -->\n',
    );
    expect(pictures.remove('Intro', 'a')).toBe('Intro');
    expect(pictures.remove(pictures.write('', 'a', '1'), 'a')).toBe('');
  });

  it('lists its blocks in order, once each, with a pair only', () => {
    const body = [
      pictures.write(pictures.write('', 'b', '1'), 'a', '2'),
      '<!-- pictures:c -->',
      '<!-- pictures:x--y --><!-- /pictures:x--y -->',
    ].join('\n');
    expect(pictures.keys(body)).toEqual(['b', 'a']);
  });
});
