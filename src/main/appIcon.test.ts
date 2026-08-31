import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWindowIcon } from './appIcon';

describe('resolveWindowIcon', () => {
  it('points at the icon beside the app root when it is there', () => {
    const icon = resolveWindowIcon('/app', () => true);

    expect(icon).toBe(path.join('/app', 'assets', 'icon.ico'));
  });

  // A packaged build never ships assets/ (forge.config.ts's `ignore` keeps everything but
  // .vite and better-sqlite3 out of the asar). Handing BrowserWindow a path to a file that
  // isn't there makes Electron fall back to the executable's own icon anyway — but only if we
  // pass nothing. Passing a dead path logs an error and shows a blank window icon.
  it('returns nothing when the icon is absent, so Electron uses the executable’s own', () => {
    expect(resolveWindowIcon('/packaged/app.asar', () => false)).toBeUndefined();
  });
});
