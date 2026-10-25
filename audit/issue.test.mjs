import { describe, expect, it } from 'vitest';
import { LABEL, MAX_BODY, findIssue, issueAction, issueBody, sync } from './issue.mjs';

/**
 * A fake gh: answers `issue list` with `issues`, records every call and
 * what it was given on stdin.
 *
 * @param {unknown[]} issues
 */
function fakeGh(issues = []) {
  const calls = /** @type {{ args: string[], input?: string }[]} */ ([]);
  /** @type {import('./issue.mjs').Gh} */
  const gh = (args, input) => {
    calls.push({ args, input });
    return args[0] === 'issue' && args[1] === 'list' ? JSON.stringify(issues) : '';
  };
  return { gh, calls };
}

const title = 'Broken links (weekly audit)';
const sweep = { title, runUrl: 'https://github.com/o/r/actions/runs/42', date: '2026-10-26' };

describe('issueAction', () => {
  it('opens an issue for findings when none exists', () => {
    expect(issueAction(undefined, true)).toBe('create');
  });

  it('keeps the open issue current, or reopens a closed one, while findings last', () => {
    expect(issueAction({ state: 'OPEN' }, true)).toBe('update');
    expect(issueAction({ state: 'CLOSED' }, true)).toBe('reopen');
  });

  it('closes the open issue once a sweep is clean, and otherwise does nothing', () => {
    expect(issueAction({ state: 'OPEN' }, false)).toBe('close');
    expect(issueAction(undefined, false)).toBe('none');
    expect(issueAction({ state: 'CLOSED' }, false)).toBe('none');
  });
});

describe('issueBody', () => {
  it('puts the findings first, then a link to the run', () => {
    expect(issueBody('  - a finding\n\n', 'https://example.test/run/1')).toBe(
      '- a finding\n\n---\n_Updated by the [weekly audit](https://example.test/run/1). It closes this issue once a sweep finds nothing._\n',
    );
  });

  it('cuts a report too long for an issue at a line, sending the reader to the run', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- finding ${i}`).join('\n');
    const body = issueBody(lines, 'https://example.test/run/2', 400);
    expect(body.length).toBeLessThanOrEqual(400);
    expect(body).toContain('- finding 0\n');
    expect(body).not.toContain('- finding 49');
    expect(body).toMatch(
      /- finding \d+\n\n_Cut short: the full report is in \[the run\]\(https:\/\/example\.test\/run\/2\)\._\n\n---\n_Updated by/,
    );
  });

  it("keeps a report that fits, and stays under GitHub's 65,536-character limit", () => {
    expect(MAX_BODY).toBeLessThan(65_536);
    const fits = 'x'.repeat(100);
    expect(issueBody(fits, 'u', 200)).toBe(issueBody(fits, 'u'));
    expect(issueBody('y'.repeat(70_000), 'u').length).toBeLessThanOrEqual(MAX_BODY);
  });
});

describe('findIssue', () => {
  it('matches the exact title among weekly-audit issues, open or closed, newest first', () => {
    const { gh, calls } = fakeGh([
      { number: 3, title: `${title} old`, state: 'OPEN' },
      { number: 5, title, state: 'CLOSED' },
      { number: 8, title, state: 'OPEN' },
    ]);
    expect(findIssue(gh, title)).toEqual({ number: 8, title, state: 'OPEN' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--label', LABEL, '--state', 'all']));
  });

  it('is undefined when none has the title, and refuses an odd answer', () => {
    expect(findIssue(fakeGh([{ number: 3, title: 'Other', state: 'OPEN' }]).gh, title)).toBe(
      undefined,
    );
    expect(() => findIssue(() => '{}', title)).toThrow('no list');
  });
});

describe('sync', () => {
  it('creates the label and the issue on a first finding, the body on stdin', () => {
    const { gh, calls } = fakeGh();
    expect(sync({ ...sweep, findings: 'two dead links' }, gh)).toBe(`${title}: create.`);
    expect(calls[1].args.slice(0, 4)).toEqual(['label', 'create', LABEL, '--force']);
    expect(calls[2].args).toEqual([
      'issue',
      'create',
      '--title',
      title,
      '--label',
      LABEL,
      '--body-file',
      '-',
    ]);
    expect(calls[2].input).toContain('two dead links');
    expect(calls[2].input).toContain('(https://github.com/o/r/actions/runs/42)');
  });

  it('rewrites the open issue rather than opening another', () => {
    const { gh, calls } = fakeGh([{ number: 9, title, state: 'OPEN' }]);
    expect(sync({ ...sweep, findings: 'one dead link' }, gh)).toBe(`${title}: update (#9).`);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['issue', 'edit', '9', '--body-file', '-']);
    expect(calls[1].input).toContain('one dead link');
  });

  it('reopens a closed issue and rewrites it', () => {
    const { gh, calls } = fakeGh([{ number: 9, title, state: 'CLOSED' }]);
    expect(sync({ ...sweep, findings: 'back again' }, gh)).toBe(`${title}: reopen (#9).`);
    expect(calls[1].args).toEqual(['issue', 'reopen', '9']);
    expect(calls[2].args).toEqual(['issue', 'edit', '9', '--body-file', '-']);
  });

  it('closes the open issue as completed, with a dated comment, when nothing was found', () => {
    const { gh, calls } = fakeGh([{ number: 9, title, state: 'OPEN' }]);
    expect(sync({ ...sweep, findings: ' \n' }, gh)).toBe(`${title}: close (#9).`);
    expect(calls[1].args).toEqual([
      'issue',
      'close',
      '9',
      '--reason',
      'completed',
      '--comment',
      'The 2026-10-26 weekly audit found nothing, so this is resolved: https://github.com/o/r/actions/runs/42',
    ]);
  });

  it('leaves everything alone when clean with no open issue', () => {
    const { gh, calls } = fakeGh([{ number: 9, title, state: 'CLOSED' }]);
    expect(sync({ ...sweep, findings: '' }, gh)).toBe(`${title}: none (#9).`);
    expect(calls).toHaveLength(1);
  });
});
