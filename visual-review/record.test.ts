import { describe, expect, it } from 'vitest';
import { blocks } from '../describe/describe.ts';
import { assetLink, BOT, outsideOwnBlocks, parseRecord, recordLine } from './record.ts';

/** @type {import('./record.ts').Record} */
const RECORD = {
  sha: 'a'.repeat(40),
  fingerprint: '203b5d6e',
  format: 4,
  layout: '5c93130b',
  run: 45747339808,
  assets: ['3f493072-0000-1111-2222-333344445555', 'b46bca8f-0000-1111-2222-333344445555'],
};

describe('recordLine and parseRecord', () => {
  it('write and read the record at the start of the block', () => {
    const line = recordLine(RECORD);
    expect(line).toBe(
      `<!-- visual-review:upload sha=${'a'.repeat(40)} fingerprint=203b5d6e format=4 layout=5c93130b run=45747339808 assets=3f493072-0000-1111-2222-333344445555,b46bca8f-0000-1111-2222-333344445555 -->`,
    );
    const body = blocks.write('Goal.', BOT, `${line}\ntable`);
    expect(parseRecord(body)).toEqual(RECORD);
    expect(parseRecord(blocks.write('', BOT, recordLine({ ...RECORD, assets: [] })))).toEqual({
      ...RECORD,
      assets: [],
    });
  });

  it("reads none outside the block, nor one that isn't whole", () => {
    expect(parseRecord(recordLine(RECORD))).toBeNull();
    expect(parseRecord(blocks.write('', BOT, 'table'))).toBeNull();
    for (const bad of [
      recordLine({ ...RECORD, sha: 'abc' }),
      recordLine({ ...RECORD, assets: ['not-hex!'] }),
      recordLine(RECORD).replace(' run=', ' '),
      `x ${recordLine(RECORD)}`,
    ]) {
      expect(parseRecord(blocks.write('', BOT, bad))).toBeNull();
    }
  });

  it('links an asset by its id', () => {
    expect(assetLink('ab-12')).toBe('https://github.com/user-attachments/assets/ab-12');
  });
});

describe('outsideOwnBlocks', () => {
  it('takes the block out, empties the slots and trims the end', () => {
    const body = [
      'Goal.',
      '<!-- describe:visual-review:trips -->\nT\n<!-- /describe:visual-review:trips -->',
      '<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->',
      '',
    ].join('\n\n');
    expect(outsideOwnBlocks(body)).toBe(
      'Goal.\n\n<!-- describe:visual-review:trips --><!-- /describe:visual-review:trips -->',
    );
  });

  it("leaves another tool's blocks and a torn slot as they are", () => {
    const gif = '<!-- pr-gif:s -->\ng\n<!-- /pr-gif:s -->';
    expect(outsideOwnBlocks(gif)).toBe(gif);
    const torn = '<!-- describe:visual-review:trips -->\nauthor';
    expect(outsideOwnBlocks(torn)).toBe(torn);
  });
});
