import { expect, test } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchNtwine } from './harness/launch';

test('the production build boots in E2E mode against empty temp dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-boot-'));
  const launched = await launchNtwine({ userData: join(root, 'userData'), appData: join(root, 'appData') });
  try {
    const { page } = launched;
    await expect(page.getByText('Splice database')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import library' })).toBeVisible();
    // Empty appData → the real detection glob finds nothing.
    await expect(page.getByText('not found')).toBeVisible();
    // The snapshot is live and the app is unimported.
    const snap = await page.evaluate(() => window.__ntwineE2E!());
    expect(snap.running).toBe(false);
    expect(snap.rows).toBe(0);
    // userData landed in OUR temp dir, not the developer's (realpath both sides: macOS tmpdir is a
    // /var → /private/var symlink and Electron may hand back either spelling).
    const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
    expect(realpathSync(userData)).toBe(realpathSync(join(root, 'userData')));
  } finally {
    await launched.close();
    rmSync(root, { recursive: true, force: true });
  }
});
