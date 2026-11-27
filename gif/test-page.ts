// A built page for route.ts's tests: its folder, beside a secret, with
// symlinks out of it and within it.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A build folder beside a secret, with symlinks out of it and within it.
 */
export function builtPage() {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'gif-route-')));
  const dir = path.join(parent, 'dist');
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  mkdirSync(path.join(dir, 'empty'));
  writeFileSync(path.join(dir, 'index.html'), '<p>page</p>');
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'run()');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'index.html'), '<a href="next.html">next</a>');
  writeFileSync(path.join(parent, 'secret.txt'), 'secret');
  mkdirSync(path.join(parent, 'other'));
  writeFileSync(path.join(parent, 'other', 'index.html'), 'other');
  symlinkSync(path.join(parent, 'secret.txt'), path.join(dir, 'out.txt'));
  symlinkSync(parent, path.join(dir, 'up'));
  symlinkSync(path.join(parent, 'other'), path.join(dir, 'other'));
  symlinkSync(path.join(dir, 'assets', 'app.js'), path.join(dir, 'in.js'));
  return { parent, dir };
}
