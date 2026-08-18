import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSeam, type Seam } from './seam';

export const REPO_ROOT = join(__dirname, '..', '..', '..');
const MAIN_JS = join(REPO_ROOT, '.vite', 'build', 'main.js');
const RENDERER_INDEX = join(REPO_ROOT, '.vite', 'renderer', 'main_window', 'index.html');
const SRC_DIR = join(REPO_ROOT, 'src');

function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeUnder(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** `.vite/build/main.js` is written by BOTH `yarn start` (dev) and `electron-forge package` (prod);
 * only a CURRENT production build is a valid launch target (e2e spec §3.3): a dev build is
 * rejected by content, a stale production build (older than anything under src/) by mtime — a
 * stale build would make a freshly added data-testid read as a locator bug. */
export function assertProductionArtifact(): void {
  if (!existsSync(MAIN_JS) || !existsSync(RENDERER_INDEX)) {
    throw new Error('e2e: no production build found — run `yarn e2e` (or `yarn package`) first');
  }
  if (readFileSync(MAIN_JS, 'utf8').includes('http://localhost:')) {
    throw new Error('e2e: .vite/build/main.js is a DEV build (yarn start) — run `yarn package` first');
  }
  if (statSync(MAIN_JS).mtimeMs < newestMtimeUnder(SRC_DIR)) {
    throw new Error('e2e: production build is older than src/ — run `yarn package` (or `yarn e2e`) first');
  }
}

export interface LaunchOptions {
  userData: string;
  appData?: string;
  libraryRoot?: string;
  extraEnv?: Record<string, string>;
}
export interface Launched {
  app: ElectronApplication;
  page: Page;
  seam: Seam;
  close(): Promise<void>;
}

export async function launchNtwine(opts: LaunchOptions): Promise<Launched> {
  assertProductionArtifact();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NTWINE_E2E: '1',
    NTWINE_USER_DATA: opts.userData,
    ELECTRON_ENABLE_LOGGING: '1',
    ...(opts.appData ? { NTWINE_APP_DATA: opts.appData } : {}),
    ...(opts.libraryRoot ? { NTWINE_LIBRARY_ROOT: opts.libraryRoot } : {}),
    ...opts.extraEnv,
  };
  // The RUNNER is Electron-as-Node (yarn e2e:only); the APP must not be.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [MAIN_JS], env, cwd: REPO_ROOT });
  let page: Page;
  try {
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.__ntwineE2E === 'function');
  } catch (err) {
    // The Electron process is already spawned at this point — a failed boot (firstWindow timeout,
    // a broken __ntwineE2E attach) must not leak it. Best-effort: a close() failure here must not
    // mask the original boot error.
    await app.close().catch(() => {});
    throw err;
  }
  // Idempotent: a spec may close the app itself (persistence relaunch) and the fixture's teardown
  // closes it again — the second call must be a no-op, not a "target closed" throw.
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    try {
      await app.close();
    } finally {
      closed = true;
    }
  };
  return { app, page, seam: createSeam(app), close };
}
