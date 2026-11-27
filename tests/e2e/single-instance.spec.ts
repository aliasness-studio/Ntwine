import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './harness/fixtures';
import { packagedBaseEnv, packagedExecutable, runPackaged } from './harness/packaged';

// The second launch is the PACKAGED binary while the first is the harness's build: two different
// bundles sharing one user-data directory, which is how a downloaded copy meets an installed one.
// It carries a boot marker, so a launch that wrongly got past the lock would boot, write the
// marker and quit — the marker's absence is the proof it never started up.

test('a second launch against the same user data quits at once and hands over to the first', async ({ ntwine }) => {
  const { app, page, seam, fixture, root } = ntwine;
  await seam.arm('ntwine:e2e:second-instance');
  const marker = join(root, 'second-booted.txt');

  const { code } = await runPackaged(packagedExecutable(), {
    ...packagedBaseEnv(),
    NTWINE_E2E: '1',
    NTWINE_USER_DATA: fixture.userData,
    NTWINE_E2E_BOOT_MARKER: marker,
  });

  expect(code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  await expect.poll(() => seam.count('ntwine:e2e:second-instance')).toBe(1);
  // The first instance is still up, with its one window, and still answers.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const snap = await page.evaluate(() => window.__ntwineE2E!());
  expect(snap.running).toBe(false);
});

test('launches with separate user data do not block each other', async ({ ntwine }) => {
  const { seam } = ntwine;
  await seam.arm('ntwine:e2e:second-instance');
  const other = mkdtempSync(join(tmpdir(), 'ntwine-e2e-other-'));
  const marker = join(other, 'booted.txt');
  try {
    const { code } = await runPackaged(packagedExecutable(), {
      ...packagedBaseEnv(),
      NTWINE_E2E: '1',
      NTWINE_USER_DATA: join(other, 'ud'),
      NTWINE_E2E_BOOT_MARKER: marker,
    });
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(realpathSync(readFileSync(marker, 'utf8'))).toBe(realpathSync(join(other, 'ud')));
    expect(await seam.count('ntwine:e2e:second-instance')).toBe(0);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
