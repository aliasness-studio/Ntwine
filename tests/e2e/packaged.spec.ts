import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagedBaseEnv, packagedExecutable, runPackaged } from './harness/packaged';

test('the packaged app boots, loads the renderer, and quits on the boot marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-pkg-'));
  const marker = join(root, 'booted.txt');
  try {
    const { code } = await runPackaged(packagedExecutable(), { ...packagedBaseEnv(), NTWINE_E2E: '1', NTWINE_USER_DATA: join(root, 'ud'), NTWINE_E2E_BOOT_MARKER: marker });
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(realpathSync(readFileSync(marker, 'utf8'))).toBe(realpathSync(join(root, 'ud')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the packaged app refuses E2E mode without NTWINE_USER_DATA — and touches no app-data path first', async () => {
  // The refusal must also happen before any path under the real app-data root
  // is created. The developer's real `…/Ntwine/ntwine-data` already exists (it cannot be asserted
  // absent), so redirect the home root to a fresh temp dir and assert nothing appeared under it.
  // macOS: Chromium/Foundation resolve Application Support from $HOME. Windows: roaming AppData
  // comes from the shell known-folder API, which ignores %APPDATA% — only the exit code is
  // asserted there.
  const fakeHome = mkdtempSync(join(tmpdir(), 'ntwine-e2e-home-'));
  try {
    const env: Record<string, string> = { ...packagedBaseEnv(), NTWINE_E2E: '1' };
    if (process.platform === 'darwin') env.HOME = fakeHome;
    const { code, stderr } = await runPackaged(packagedExecutable(), env);
    expect(code).toBe(2);
    expect(stderr).toMatch(/NTWINE_USER_DATA/);
    if (process.platform === 'darwin') {
      expect(existsSync(join(fakeHome, 'Library', 'Application Support', 'Ntwine'))).toBe(false);
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
