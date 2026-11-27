import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_ORIGIN, contentType, pageFile, routePage } from './route.ts';
import { builtPage } from './test-page.ts';
import type { BrowserContext } from 'playwright';

describe('pageFile', () => {
  const { parent, dir } = builtPage();
  const at = (...parts: string[]) => ({ file: path.join(dir, ...parts), folder: false });

  it('finds a file, and a folder by its index.html, saying it was a folder', () => {
    expect(pageFile(dir, '/')).toEqual({ file: path.join(dir, 'index.html'), folder: true });
    expect(pageFile(dir, '/index.html')).toEqual(at('index.html'));
    expect(pageFile(dir, '/assets/app.js')).toEqual(at('assets', 'app.js'));
    expect(pageFile(dir, '/assets/%61pp.js')).toEqual(at('assets', 'app.js'));
    expect(pageFile(dir, '/in.js')).toEqual(at('assets', 'app.js'));
    expect(pageFile(dir, '/sub')).toEqual({
      file: path.join(dir, 'sub', 'index.html'),
      folder: true,
    });
    expect(pageFile(dir, '/sub/')).toEqual({
      file: path.join(dir, 'sub', 'index.html'),
      folder: true,
    });
  });

  it.each([
    '/missing.html',
    '/empty',
    '/empty/',
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/..%2Fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E%2fsecret.txt',
    '/..%5Csecret.txt',
    `/${parent}/secret.txt`,
    `${parent}/secret.txt`,
    '/out.txt',
    '/up/secret.txt',
    '/up/dist/../secret.txt',
    '/other',
    '/other/index.html',
    '/index.html%00.js',
    '/%E0%A4%A',
  ])('refuses %s', (pathname) => {
    expect(pageFile(dir, pathname)).toBeNull();
  });

  it('follows a symlink out and back in, as the file it lands on', () => {
    expect(pageFile(dir, '/up/dist/index.html')).toEqual(at('index.html'));
  });
});

describe('contentType', () => {
  it("names each file's type by its extension", () => {
    expect(contentType('a/index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('app.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentType('s.css')).toBe('text/css; charset=utf-8');
    expect(contentType('i.svg')).toBe('image/svg+xml');
    expect(contentType('i.png')).toBe('image/png');
    expect(contentType('d.json')).toBe('application/json; charset=utf-8');
    expect(contentType('blob')).toBe('application/octet-stream');
  });
});

describe('routePage', () => {
  it("answers the page's origin from the folder, 404 outside it, and aborts any other origin", async () => {
    const { dir } = builtPage();
    const route = vi.fn();
    const context = { route } as unknown as BrowserContext;
    await routePage(context, dir);
    expect(route).toHaveBeenCalledTimes(1);
    const [matches, handle] = route.mock.calls[0] as [
      (url: URL) => boolean,
      (route: unknown) => Promise<void>,
    ];
    // Every request reaches the handler, which decides.
    expect(matches(new URL('https://example.com/x.js'))).toBe(true);
    const answer = async (url: string) => {
      const fulfill = vi.fn();
      const abort = vi.fn();
      await handle({ request: () => ({ url: () => url }), fulfill, abort });
      if (abort.mock.calls.length > 0) return { aborted: abort.mock.calls[0][0] as string };
      return fulfill.mock.calls[0][0] as Record<string, unknown>;
    };
    expect(await answer(`${PAGE_ORIGIN}/assets/app.js?v=1#x`)).toEqual({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: Buffer.from('run()'),
    });
    expect(await answer(`${PAGE_ORIGIN}/`)).toMatchObject({
      status: 200,
      contentType: 'text/html; charset=utf-8',
    });
    expect(await answer(`${PAGE_ORIGIN}/out.txt`)).toMatchObject({ status: 404 });
    expect(await answer(`${PAGE_ORIGIN}/..%2Fsecret.txt`)).toMatchObject({ status: 404 });
    expect(await answer(`${PAGE_ORIGIN}/sub?tab=2`)).toEqual({
      status: 301,
      headers: { location: '/sub/?tab=2' },
    });
    expect(await answer(`${PAGE_ORIGIN}/sub/`)).toMatchObject({ status: 200 });
    for (const other of [
      'https://gif.test/',
      'http://gif.test.example/',
      'http://gif.test:8080/',
      'https://fonts.example/a.woff2',
      'http://127.0.0.1:5173/',
    ]) {
      expect(await answer(other)).toEqual({ aborted: 'blockedbyclient' });
    }
  });
});
