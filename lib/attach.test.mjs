import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTACH_LIMIT,
  ATTACH_MAX_BYTES,
  attachToDescription,
  attachmentLinksIn,
  waitForLinks,
} from './attach.mjs';

describe('the limits', () => {
  it("are gh's 50 files an edit and GitHub's 10 MB a file", () => {
    expect(ATTACH_LIMIT).toBe(50);
    expect(ATTACH_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('attachmentLinksIn', () => {
  it('takes the attachment links, in order, and nothing else', () => {
    const a = 'https://github.com/user-attachments/assets/aaa-1';
    const b = 'https://github.com/user-attachments/assets/b_2';
    expect(
      attachmentLinksIn(`![x](${a}) https://github.com/o/r <img src="${b}" width="3"> ./local.png`),
    ).toEqual([a, b]);
    expect(attachmentLinksIn('')).toEqual([]);
  });
});

describe('waitForLinks', () => {
  /**
   * A fetch answering each link from its own list of statuses (or errors),
   * the last repeating, and a clock that moves on each wait.
   *
   * @param {Record<string, (number | Error)[]>} answers
   */
  function fake(answers) {
    let clock = 0;
    /** @type {string[]} */
    const asked = [];
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (
        async (/** @type {string} */ url) => {
          asked.push(url);
          const list = answers[url];
          const next = list.length > 1 ? list.shift() : list[0];
          if (next instanceof Error) throw next;
          return new Response(next === 200 ? 'PNG' : null, { status: next });
        }
      )
    );
    const wait = async (/** @type {number} */ ms) => {
      clock += ms;
    };
    return { asked, options: { fetch, now: () => clock, wait, limitMs: 20, everyMs: 5 } };
  }

  it('waits for a link that goes live a moment after the edit', async () => {
    const { asked, options } = fake({ a: [404, new Error('reset'), 200], b: [200] });
    await waitForLinks(['a', 'b'], { prefix: 'pictures', label: 'pictures', ...options });
    expect(asked).toEqual(['a', 'a', 'a', 'b']);
  });

  it("names each link that never answered, in the caller's words", async () => {
    const { options } = fake({ a: [404], b: [200], c: [new Error('ENOTFOUND')] });
    await expect(
      waitForLinks(['a', 'b', 'c'], {
        prefix: 'pictures',
        label: 'attached picture(s)',
        ...options,
      }),
    ).rejects.toThrow(
      "pictures: 2 attached picture(s) didn't answer within 0.02 s: a (404), c (ENOTFOUND)",
    );
  });
});

describe('waitForLinks, on a connection that stalls', () => {
  it('gives each try at most everyMs, counting a hung one as failed', async () => {
    let tries = 0;
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (
        (/** @type {string} */ _url, /** @type {{ signal?: AbortSignal }} */ init) => {
          tries += 1;
          // Never answers: only the signal ends it.
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        }
      )
    );
    const started = Date.now();
    await expect(
      waitForLinks(['a'], {
        prefix: 'pictures',
        label: 'attached picture(s)',
        fetch,
        wait: async () => {},
        limitMs: 60,
        everyMs: 20,
      }),
    ).rejects.toThrow(/pictures: 1 attached picture\(s\) didn't answer within 0.06 s: a \(.+\)/);
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('attachToDescription', () => {
  /**
   * A fake gh over one PR's description, which `--attach` rewrites as gh's
   * manual says: each local reference to an attached file becomes its URL.
   *
   * @param {string} body
   * @param {{ keepLocal?: boolean; fail?: boolean }} [opts]
   */
  function fakeGh(body, opts = {}) {
    /** @type {string[][]} */
    const calls = [];
    /** @type {import('./gh.mjs').Command} */
    const gh = (args) => {
      calls.push(args);
      if (opts.fail) throw new Error('gh pr failed: too large');
      let next = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      args.forEach((arg, i) => {
        if (args[i - 1] !== '--attach' || opts.keepLocal) return;
        next = next.replaceAll(`](${arg})`, `](https://github.com/user-attachments/assets/${i})`);
      });
      body = next;
      return { status: 0, stdout: '', stderr: '' };
    };
    return { gh, calls, view: () => body };
  }

  /**
   * @param {ReturnType<typeof fakeGh>} fake
   * @param {readonly string[]} files
   * @param {string} [was]
   */
  function attach(fake, files, was = fake.view()) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'lib-attach-'));
    /** @type {string[]} */
    const logs = [];
    const body = `${was}\n${files.map((f) => `![${f}](./${f})`).join('\n')}`;
    const after = attachToDescription({
      repo: 'o/r',
      pr: '9',
      cwd,
      files,
      was,
      body,
      view: fake.view,
      gh: fake.gh,
      prefix: 'pictures',
      noun: 'picture',
      log: (l) => logs.push(l),
    });
    return { after, logs, cwd };
  }

  it('writes the body and attaches the files in one edit, then removes its body file', () => {
    const fake = fakeGh('Host.');
    const { after, logs, cwd } = attach(fake, ['a.png', 'b.png']);
    expect(fake.calls).toEqual([
      [
        'pr',
        'edit',
        '9',
        '--repo',
        'o/r',
        '--body-file',
        path.join(cwd, '.pictures-body-9.md'),
        '--attach',
        './a.png',
        '--attach',
        './b.png',
      ],
    ]);
    expect(after).toBe(
      'Host.\n![a.png](https://github.com/user-attachments/assets/8)\n![b.png](https://github.com/user-attachments/assets/10)',
    );
    expect(logs).toEqual(["pictures: attached 2 pictures to #9's description"]);
    expect(() => readFileSync(path.join(cwd, '.pictures-body-9.md'))).toThrow();
  });

  it('attaches at most ATTACH_LIMIT an edit, reading the description again between', () => {
    const fake = fakeGh('');
    const files = Array.from({ length: ATTACH_LIMIT + 1 }, (_, i) => `p${i}.png`);
    const { after, logs } = attach(fake, files);
    expect(fake.calls.map((c) => c.filter((a) => a === '--attach').length)).toEqual([
      ATTACH_LIMIT,
      1,
    ]);
    expect(after).not.toContain('](./');
    expect(logs).toEqual([`pictures: attached ${ATTACH_LIMIT + 1} pictures to #9's description`]);
  });

  it('edits once with nothing to attach when the body changed, and not at all when not', () => {
    const fake = fakeGh('Old');
    const cwd = mkdtempSync(path.join(tmpdir(), 'lib-attach-'));
    /** @type {string[]} */
    const logs = [];
    const common = { repo: 'o/r', pr: '9', cwd, files: [], view: fake.view, gh: fake.gh };
    const options = {
      ...common,
      prefix: 'pictures',
      noun: 'picture',
      log: (/** @type {string} */ l) => logs.push(l),
    };
    expect(attachToDescription({ ...options, was: 'Old', body: 'New' })).toBe('New');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].includes('--attach')).toBe(false);
    expect(attachToDescription({ ...options, was: 'New', body: 'New' })).toBe('New');
    expect(fake.calls).toHaveLength(1);
    expect(logs).toEqual([
      "pictures: updated #9's description",
      "pictures: #9's description needs no change",
    ]);
  });

  it('checks for local references only in the span this run wrote, when given one', () => {
    // An earlier run's leftover, before ---, isn't this run's to fix: a gh
    // that rewrites only the reference after it.
    let body = 'Old block: ![x](./a.png)\n---';
    /** @type {import('./gh.mjs').Command} */
    const gh = (args) => {
      const next = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      const at = next.indexOf('---');
      body =
        next.slice(0, at) +
        next
          .slice(at)
          .replace('](./a.png)', `](${'https://github.com/user-attachments/assets/1'})`);
      return { status: 0, stdout: '', stderr: '' };
    };
    const was = body;
    const options = {
      repo: 'o/r',
      pr: '9',
      cwd: mkdtempSync(path.join(tmpdir(), 'lib-attach-')),
      files: ['a.png'],
      was,
      body: `${was}\n![a](./a.png)`,
      view: () => body,
      gh,
      prefix: 'pictures',
      noun: 'picture',
      log: () => {},
    };
    expect(() => attachToDescription(options)).toThrow('left a.png referenced locally');
    const after = attachToDescription({ ...options, span: (b) => b.slice(b.indexOf('---')) });
    expect(after).toBe(
      'Old block: ![x](./a.png)\n---\n![a](https://github.com/user-attachments/assets/1)',
    );
  });

  it('says one picture, not one pictures', () => {
    expect(attach(fakeGh(''), ['a.png']).logs).toEqual([
      "pictures: attached 1 picture to #9's description",
    ]);
  });

  it('fails when gh left a file referenced locally', () => {
    expect(() => attach(fakeGh('', { keepLocal: true }), ['a.png'])).toThrow(
      "pictures: gh uploaded the pictures but left a.png referenced locally in #9's description",
    );
  });

  it('says how far it got when an edit fails, keeping the cause', () => {
    /** @type {Error} */
    let thrown = new Error('none');
    try {
      attach(fakeGh('', { fail: true }), ['a.png', 'b.png']);
    } catch (error) {
      thrown = /** @type {Error} */ (error);
    }
    expect(thrown.message).toBe(
      'pictures: attaching to #9 stopped after 0 of 2 pictures; its description may still reference the rest locally (./…): run it again to attach them',
    );
    expect(/** @type {Error} */ (thrown.cause).message).toBe('gh pr failed: too large');
  });
});
